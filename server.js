const http = require('http');
const url = require('url');
const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { marked } = require('marked');
const payments = require('./payments');
const x402 = require('./x402');

const PORT = process.env.PORT || 3001;
const CHROME_PATH = process.env.CHROME_PATH || '/usr/bin/google-chrome';
const API_KEYS_FILE = path.join(__dirname, 'api-keys.json');
const RATE_LIMIT_WINDOW = 60 * 1000; // 1 minute
const MAX_CONCURRENT = 3;

// Load or create API keys
let apiKeys = {};
try { apiKeys = JSON.parse(fs.readFileSync(API_KEYS_FILE, 'utf8')); } catch {}

// Generate a demo key if none exist
if (Object.keys(apiKeys).length === 0) {
  const demoKey = 'demo_' + crypto.randomBytes(16).toString('hex');
  apiKeys[demoKey] = {
    name: 'demo',
    tier: 'free',
    limit: 100, // per month
    used: 0,
    resetMonth: new Date().toISOString().slice(0, 7),
    created: new Date().toISOString(),
  };
  fs.writeFileSync(API_KEYS_FILE, JSON.stringify(apiKeys, null, 2));
  console.log(`Demo API key created: ${demoKey}`);
}

// Rate limiting
const rateLimits = new Map();
let activeTasks = 0;

function checkRateLimit(apiKey) {
  const now = Date.now();
  const entry = rateLimits.get(apiKey) || { count: 0, windowStart: now };
  if (now - entry.windowStart > RATE_LIMIT_WINDOW) {
    entry.count = 0;
    entry.windowStart = now;
  }
  entry.count++;
  rateLimits.set(apiKey, entry);
  return entry.count <= 10; // 10 requests per minute
}

function resetMonthlyUsage(keyData) {
  const currentMonth = new Date().toISOString().slice(0, 7);
  if (keyData.resetMonth !== currentMonth) {
    keyData.used = 0;
    keyData.resetMonth = currentMonth;
  }
}

function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(data));
}

function sendError(res, status, message) {
  sendJson(res, status, { error: message });
}

// Authenticate via x402 micropayment or API key
// Returns { ok: true, keyData, settleFn } or { ok: false } (response already sent)
async function authenticate(req, res, parsed) {
  if (x402.hasX402Payment(req)) {
    const payResult = await x402.processPayment(req);
    if (!payResult.allowed) {
      const headers = { 'Access-Control-Allow-Origin': '*', ...payResult.headers };
      res.writeHead(payResult.status, headers);
      res.end(payResult.isHtml ? payResult.body : JSON.stringify(payResult.body));
      return { ok: false };
    }
    return { ok: true, keyData: null, settleFn: payResult.settle };
  }

  const apiKey = req.headers['x-api-key'] || parsed.query.api_key;
  if (!apiKey) {
    // No auth - return x402 payment requirements
    const payResult = await x402.processPayment(req);
    if (!payResult.allowed && payResult.status === 402) {
      const headers = { 'Access-Control-Allow-Origin': '*', ...payResult.headers };
      res.writeHead(402, headers);
      res.end(payResult.isHtml ? payResult.body : JSON.stringify(payResult.body));
      return { ok: false };
    }
    sendError(res, 401, 'Auth required: X-API-Key header, ?api_key= param, or x402 Payment-Signature header.');
    return { ok: false };
  }
  if (!apiKeys[apiKey]) {
    sendError(res, 401, 'Invalid API key.');
    return { ok: false };
  }

  const keyData = apiKeys[apiKey];
  resetMonthlyUsage(keyData);
  if (keyData.used >= keyData.limit) {
    sendError(res, 429, `Monthly limit reached (${keyData.limit}). Upgrade your plan.`);
    return { ok: false };
  }
  if (!checkRateLimit(apiKey)) {
    sendError(res, 429, 'Rate limit exceeded. Max 10 requests per minute.');
    return { ok: false };
  }

  return { ok: true, keyData, settleFn: null };
}

// Analytics
let stats = { total_captures: 0, screenshots: 0, pdfs: 0, md_conversions: 0, errors: 0 };
const ANALYTICS_FILE = path.join(__dirname, 'analytics.json');
let analytics = { daily: {}, total_views: 0 };
try { analytics = JSON.parse(fs.readFileSync(ANALYTICS_FILE, 'utf8')); } catch {}
function trackPageView() {
  const today = new Date().toISOString().split('T')[0];
  analytics.daily[today] = (analytics.daily[today] || 0) + 1;
  analytics.total_views++;
  if (analytics.total_views % 10 === 0) {
    fs.writeFile(ANALYTICS_FILE, JSON.stringify(analytics, null, 2), () => {});
  }
}

// Read POST body
function readBody(req, maxSize = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let body = '';
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > maxSize) {
        reject(new Error('Body too large (max 1MB)'));
        req.destroy();
        return;
      }
      body += chunk;
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

// Markdown-to-HTML with styling
function renderMarkdownHTML(markdown, options = {}) {
  const htmlContent = marked(markdown);
  const theme = options.theme === 'dark' ? `
    body { background: #1a1a2e; color: #e0e0e0; }
    a { color: #64b5f6; }
    code { background: #2d2d44; }
    pre { background: #2d2d44; }
    blockquote { border-left-color: #64b5f6; color: #b0b0b0; }
    table th { background: #2d2d44; }
    table td, table th { border-color: #3d3d54; }
    hr { border-color: #3d3d54; }
  ` : `
    body { background: #ffffff; color: #24292f; }
    a { color: #0969da; }
    code { background: #f6f8fa; }
    pre { background: #f6f8fa; }
    blockquote { border-left-color: #d0d7de; color: #57606a; }
    table th { background: #f6f8fa; }
    table td, table th { border-color: #d0d7de; }
    hr { border-color: #d0d7de; }
  `;

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  * { box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;
    line-height: 1.6;
    max-width: ${options.width || '800px'};
    margin: 0 auto;
    padding: 2rem;
    font-size: ${options.fontSize || '16px'};
  }
  h1, h2, h3, h4, h5, h6 { margin-top: 1.5em; margin-bottom: 0.5em; font-weight: 600; }
  h1 { font-size: 2em; border-bottom: 1px solid #d0d7de; padding-bottom: 0.3em; }
  h2 { font-size: 1.5em; border-bottom: 1px solid #d0d7de; padding-bottom: 0.3em; }
  code {
    padding: 0.2em 0.4em;
    border-radius: 6px;
    font-size: 85%;
    font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace;
  }
  pre {
    padding: 1rem;
    border-radius: 6px;
    overflow-x: auto;
    line-height: 1.45;
  }
  pre code { padding: 0; background: none; font-size: 85%; }
  blockquote {
    margin: 0;
    padding: 0 1em;
    border-left: 0.25em solid;
  }
  table { border-collapse: collapse; width: 100%; margin: 1em 0; }
  table td, table th { padding: 6px 13px; border: 1px solid; }
  img { max-width: 100%; }
  hr { border: none; border-top: 1px solid; margin: 2em 0; }
  ul, ol { padding-left: 2em; }
  li + li { margin-top: 0.25em; }
  ${theme}
</style>
</head>
<body>${htmlContent}</body>
</html>`;
}

// Convert markdown to PDF or PNG using Puppeteer
async function convertMarkdown(markdown, options = {}) {
  const html = renderMarkdownHTML(markdown, options);

  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--single-process'],
  });

  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'load' });

    let result;
    if (options.format === 'png' || options.format === 'jpeg') {
      const width = Math.min(Math.max(parseInt(options.viewportWidth) || 1280, 320), 3840);
      await page.setViewport({ width, height: 800 });
      await page.setContent(html, { waitUntil: 'load' });
      result = await page.screenshot({
        type: options.format,
        fullPage: true,
        quality: options.format === 'jpeg' ? Math.min(parseInt(options.quality) || 85, 100) : undefined,
      });
    } else {
      result = await page.pdf({
        format: options.paperSize || 'A4',
        printBackground: true,
        margin: {
          top: options.marginTop || '20mm',
          bottom: options.marginBottom || '20mm',
          left: options.marginLeft || '15mm',
          right: options.marginRight || '15mm',
        },
        landscape: options.landscape === true || options.landscape === 'true',
      });
    }

    stats.md_conversions++;
    stats.total_captures++;
    return result;
  } finally {
    await browser.close();
  }
}

async function captureScreenshot(targetUrl, options = {}) {
  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--single-process',
    ],
  });

  try {
    const page = await browser.newPage();

    const width = Math.min(Math.max(parseInt(options.width) || 1280, 320), 3840);
    const height = Math.min(Math.max(parseInt(options.height) || 800, 200), 2160);
    await page.setViewport({ width, height });

    if (options.userAgent) {
      await page.setUserAgent(options.userAgent);
    }

    const timeout = Math.min(Math.max(parseInt(options.timeout) || 30000, 5000), 60000);
    await page.goto(targetUrl, {
      waitUntil: options.waitUntil || 'networkidle2',
      timeout,
    });

    if (options.delay) {
      await new Promise(r => setTimeout(r, Math.min(parseInt(options.delay), 10000)));
    }

    let result;
    if (options.format === 'pdf') {
      result = await page.pdf({
        format: options.paperSize || 'A4',
        printBackground: options.printBackground !== false,
        landscape: options.landscape === true || options.landscape === 'true',
      });
      stats.pdfs++;
    } else {
      result = await page.screenshot({
        type: options.imageType || 'png',
        fullPage: options.fullPage === true || options.fullPage === 'true',
        quality: options.imageType === 'jpeg' ? Math.min(parseInt(options.quality) || 80, 100) : undefined,
      });
      stats.screenshots++;
    }

    stats.total_captures++;
    return result;
  } finally {
    await browser.close();
  }
}

const server = http.createServer(async (req, res) => {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-API-Key, Payment-Signature, X-Payment',
      'Access-Control-Expose-Headers': 'Payment-Required, Payment-Response',
    });
    res.end();
    return;
  }

  const parsed = url.parse(req.url, true);

  // Health/status endpoint (no auth required)
  if (parsed.pathname === '/api/status') {
    sendJson(res, 200, {
      service: 'screenshot-api',
      status: 'ok',
      stats,
      page_views: analytics.total_views,
      active_tasks: activeTasks,
      max_concurrent: MAX_CONCURRENT,
      timestamp: new Date().toISOString(),
    });
    return;
  }

  // API docs - JSON
  if (parsed.pathname === '/api') {
    sendJson(res, 200, {
      service: 'SnapAPI - Document Generation Suite',
      version: '3.0.0',
      description: 'Screenshots, PDFs, and Markdown conversion API with x402 micropayments',
      built_by: 'OpSpawn (AI Agent) - transparent about AI authorship',
      payment: {
        x402: {
          description: 'Pay-per-request via x402 protocol (no signup needed)',
          network: 'Base (USDC)',
          prices: x402.PRICES,
          protocol: 'https://x402.org',
          how: 'Send Payment-Signature header with signed USDC authorization',
        },
        subscription: {
          description: 'Monthly subscription via USDC on Polygon',
          endpoint: 'POST /api/subscribe',
        },
      },
      endpoints: {
        'GET /api/capture': {
          description: 'Capture a screenshot or PDF from a URL',
          auth: 'X-API-Key header, ?api_key= query param, OR x402 Payment-Signature header',
          x402_price: x402.PRICES.capture,
          params: {
            url: 'Target URL (required)',
            format: 'png (default), jpeg, or pdf',
            width: 'Viewport width (320-3840, default 1280)',
            height: 'Viewport height (200-2160, default 800)',
            fullPage: 'Capture full page (true/false)',
            delay: 'Wait ms after load (max 10000)',
            quality: 'JPEG quality (1-100, default 80)',
            paperSize: 'PDF paper size (A4, Letter, etc)',
            landscape: 'PDF landscape mode (true/false)',
          },
        },
        'POST /api/md2pdf': {
          description: 'Convert Markdown to PDF',
          auth: 'X-API-Key header OR x402 Payment-Signature header',
          x402_price: x402.PRICES.md2pdf,
          body: 'JSON: { markdown, theme?, paperSize?, landscape?, fontSize?, margins? }',
        },
        'POST /api/md2png': {
          description: 'Convert Markdown to PNG image',
          auth: 'X-API-Key header OR x402 Payment-Signature header',
          x402_price: x402.PRICES.md2png,
          body: 'JSON: { markdown, theme?, width?, fontSize? }',
        },
        'POST /api/md2html': {
          description: 'Convert Markdown to styled HTML (no auth required)',
          body: 'JSON: { markdown, theme?, fontSize? }',
        },
        'GET /api/status': { description: 'Service health and stats' },
      },
    });
    return;
  }

  // Favicon
  if (parsed.pathname === '/favicon.svg') {
    const faviconPath = path.join(__dirname, 'public', 'favicon.svg');
    try {
      const data = fs.readFileSync(faviconPath);
      res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=86400' });
      res.end(data);
    } catch {
      res.writeHead(404);
      res.end('Not found');
    }
    return;
  }

  // Landing page
  if (parsed.pathname === '/') {
    trackPageView();
    const landingPage = fs.readFileSync(path.join(__dirname, 'landing.html'), 'utf8');
    res.writeHead(200, { 'Content-Type': 'text/html', 'Access-Control-Allow-Origin': '*' });
    res.end(landingPage);
    return;
  }

  // Capture endpoint
  if (parsed.pathname === '/api/capture') {
    // Auth: x402 micropayment OR API key
    const auth = await authenticate(req, res, parsed);
    if (!auth.ok) return;
    const { keyData, settleFn } = auth;

    // Concurrency limit
    if (activeTasks >= MAX_CONCURRENT) {
      return sendError(res, 503, 'Server busy. Try again in a few seconds.');
    }

    // Validate URL
    const targetUrl = parsed.query.url;
    if (!targetUrl) {
      return sendError(res, 400, 'Missing required parameter: url');
    }

    let parsedTarget;
    try {
      parsedTarget = new URL(targetUrl);
    } catch {
      return sendError(res, 400, 'Invalid URL format');
    }

    // Block private/internal URLs
    const hostname = parsedTarget.hostname.toLowerCase();
    if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '0.0.0.0' ||
        hostname.startsWith('192.168.') || hostname.startsWith('10.') || hostname.startsWith('172.') ||
        hostname === '::1' || hostname === 'metadata.google.internal') {
      return sendError(res, 400, 'Cannot capture internal/private URLs');
    }

    if (!['http:', 'https:'].includes(parsedTarget.protocol)) {
      return sendError(res, 400, 'Only http and https URLs are supported');
    }

    activeTasks++;
    try {
      const buffer = await captureScreenshot(targetUrl, {
        format: parsed.query.format,
        width: parsed.query.width,
        height: parsed.query.height,
        fullPage: parsed.query.fullPage,
        delay: parsed.query.delay,
        imageType: parsed.query.format === 'jpeg' ? 'jpeg' : 'png',
        quality: parsed.query.quality,
        paperSize: parsed.query.paperSize,
        landscape: parsed.query.landscape,
        printBackground: parsed.query.printBackground,
        waitUntil: parsed.query.waitUntil,
        timeout: parsed.query.timeout,
        userAgent: parsed.query.userAgent,
      });

      if (keyData) {
        keyData.used++;
        fs.writeFile(API_KEYS_FILE, JSON.stringify(apiKeys, null, 2), () => {});
      }

      const contentType = parsed.query.format === 'pdf'
        ? 'application/pdf'
        : parsed.query.format === 'jpeg' ? 'image/jpeg' : 'image/png';

      const responseHeaders = {
        'Content-Type': contentType,
        'Content-Length': buffer.length,
        'Access-Control-Allow-Origin': '*',
      };
      if (keyData) {
        responseHeaders['X-Captures-Used'] = keyData.used;
        responseHeaders['X-Captures-Limit'] = keyData.limit;
      }

      // Settle x402 payment after successful capture
      if (settleFn) {
        const settleResult = await settleFn();
        if (settleResult && settleResult.headers) {
          Object.assign(responseHeaders, settleResult.headers);
        }
      }

      res.writeHead(200, responseHeaders);
      res.end(buffer);
    } catch (err) {
      stats.errors++;
      sendError(res, 500, 'Capture failed: ' + err.message);
    } finally {
      activeTasks--;
    }
    return;
  }

  // Markdown to HTML (no auth required - lightweight)
  if (parsed.pathname === '/api/md2html' && req.method === 'POST') {
    try {
      const body = JSON.parse(await readBody(req));
      if (!body.markdown) {
        return sendError(res, 400, 'Missing required field: markdown');
      }
      const html = renderMarkdownHTML(body.markdown, {
        theme: body.theme,
        fontSize: body.fontSize,
        width: body.width,
      });
      res.writeHead(200, { 'Content-Type': 'text/html', 'Access-Control-Allow-Origin': '*' });
      res.end(html);
    } catch (err) {
      sendError(res, 400, 'Invalid JSON body: ' + err.message);
    }
    return;
  }

  // Markdown to PDF (auth required - uses Puppeteer)
  if (parsed.pathname === '/api/md2pdf' && req.method === 'POST') {
    const auth = await authenticate(req, res, parsed);
    if (!auth.ok) return;
    const { keyData, settleFn } = auth;

    if (activeTasks >= MAX_CONCURRENT) {
      return sendError(res, 503, 'Server busy. Try again in a few seconds.');
    }

    try {
      const body = JSON.parse(await readBody(req));
      if (!body.markdown) {
        return sendError(res, 400, 'Missing required field: markdown');
      }

      activeTasks++;
      try {
        const buffer = await convertMarkdown(body.markdown, {
          format: 'pdf',
          theme: body.theme,
          paperSize: body.paperSize,
          landscape: body.landscape,
          fontSize: body.fontSize,
          marginTop: body.margins?.top,
          marginBottom: body.margins?.bottom,
          marginLeft: body.margins?.left,
          marginRight: body.margins?.right,
        });

        if (keyData) {
          keyData.used++;
          fs.writeFile(API_KEYS_FILE, JSON.stringify(apiKeys, null, 2), () => {});
        }

        const responseHeaders = {
          'Content-Type': 'application/pdf',
          'Content-Length': buffer.length,
          'Content-Disposition': 'inline; filename="document.pdf"',
          'Access-Control-Allow-Origin': '*',
        };
        if (keyData) {
          responseHeaders['X-Captures-Used'] = keyData.used;
          responseHeaders['X-Captures-Limit'] = keyData.limit;
        }

        if (settleFn) {
          const settleResult = await settleFn();
          if (settleResult && settleResult.headers) {
            Object.assign(responseHeaders, settleResult.headers);
          }
        }

        res.writeHead(200, responseHeaders);
        res.end(buffer);
      } finally {
        activeTasks--;
      }
    } catch (err) {
      stats.errors++;
      sendError(res, err.message.includes('JSON') ? 400 : 500, err.message);
    }
    return;
  }

  // Markdown to PNG (auth required - uses Puppeteer)
  if (parsed.pathname === '/api/md2png' && req.method === 'POST') {
    const auth = await authenticate(req, res, parsed);
    if (!auth.ok) return;
    const { keyData, settleFn } = auth;

    if (activeTasks >= MAX_CONCURRENT) {
      return sendError(res, 503, 'Server busy. Try again in a few seconds.');
    }

    try {
      const body = JSON.parse(await readBody(req));
      if (!body.markdown) {
        return sendError(res, 400, 'Missing required field: markdown');
      }

      activeTasks++;
      try {
        const buffer = await convertMarkdown(body.markdown, {
          format: body.format === 'jpeg' ? 'jpeg' : 'png',
          theme: body.theme,
          viewportWidth: body.width,
          fontSize: body.fontSize,
          quality: body.quality,
        });

        if (keyData) {
          keyData.used++;
          fs.writeFile(API_KEYS_FILE, JSON.stringify(apiKeys, null, 2), () => {});
        }

        const imgType = body.format === 'jpeg' ? 'jpeg' : 'png';
        const responseHeaders = {
          'Content-Type': `image/${imgType}`,
          'Content-Length': buffer.length,
          'Content-Disposition': `inline; filename="document.${imgType}"`,
          'Access-Control-Allow-Origin': '*',
        };
        if (keyData) {
          responseHeaders['X-Captures-Used'] = keyData.used;
          responseHeaders['X-Captures-Limit'] = keyData.limit;
        }

        if (settleFn) {
          const settleResult = await settleFn();
          if (settleResult && settleResult.headers) {
            Object.assign(responseHeaders, settleResult.headers);
          }
        }

        res.writeHead(200, responseHeaders);
        res.end(buffer);
      } finally {
        activeTasks--;
      }
    } catch (err) {
      stats.errors++;
      sendError(res, err.message.includes('JSON') ? 400 : 500, err.message);
    }
    return;
  }

  // --- Payment Endpoints ---

  // Create subscription invoice
  if (parsed.pathname === '/api/subscribe' && req.method === 'POST') {
    try {
      const body = JSON.parse(await readBody(req));
      const plan = body.plan || 'pro';
      const email = body.email || null;

      const invoice = payments.createInvoice(plan, email);

      sendJson(res, 201, {
        invoice_id: invoice.id,
        plan: invoice.plan,
        amount: invoice.amount,
        token: 'USDC',
        network: 'Polygon',
        wallet: invoice.wallet,
        expires_at: invoice.expires_at,
        instructions: `Send exactly ${invoice.amount} USDC to ${invoice.wallet} on Polygon network. The unique amount helps us identify your payment.`,
        check_url: `/api/subscribe/${invoice.id}`
      });
    } catch (err) {
      sendError(res, 400, err.message);
    }
    return;
  }

  // Check invoice status
  if (parsed.pathname.startsWith('/api/subscribe/') && req.method === 'GET') {
    const invoiceId = parsed.pathname.split('/api/subscribe/')[1];
    if (!invoiceId) return sendError(res, 400, 'Missing invoice ID');

    try {
      const invoice = await payments.checkPayment(invoiceId);
      if (!invoice) return sendError(res, 404, 'Invoice not found');

      const response = {
        invoice_id: invoice.id,
        status: invoice.status,
        plan: invoice.plan,
        amount: invoice.amount
      };

      if (invoice.status === 'paid') {
        response.api_key = invoice.api_key;
        response.tx_hash = invoice.tx_hash;
        response.message = 'Payment confirmed! Your API key is ready to use.';

        // Also register the key in apiKeys
        if (invoice.api_key && !apiKeys[invoice.api_key]) {
          const planData = payments.PLANS[invoice.plan];
          apiKeys[invoice.api_key] = {
            name: invoice.email || invoice.plan,
            tier: invoice.plan,
            limit: planData.limit,
            used: 0,
            resetMonth: new Date().toISOString().slice(0, 7),
            created: new Date().toISOString()
          };
          fs.writeFileSync(API_KEYS_FILE, JSON.stringify(apiKeys, null, 2));
        }
      } else if (invoice.status === 'pending') {
        response.wallet = invoice.wallet;
        response.network = 'Polygon';
        response.message = `Waiting for ${invoice.amount} USDC payment to ${invoice.wallet}`;
      } else if (invoice.status === 'expired') {
        response.message = 'Invoice expired. Create a new one at POST /api/subscribe';
      }

      sendJson(res, 200, response);
    } catch (err) {
      sendError(res, 500, err.message);
    }
    return;
  }

  // List plans/pricing
  if (parsed.pathname === '/api/pricing') {
    sendJson(res, 200, {
      plans: Object.entries(payments.PLANS).map(([id, plan]) => ({
        id,
        name: plan.name,
        price: plan.price,
        currency: 'USDC',
        network: 'Polygon',
        limit: plan.limit,
        period: plan.period,
        features: id === 'pro'
          ? ['1,000 captures/month', 'All formats (PNG, JPEG, PDF)', 'Markdown conversion', 'Priority support']
          : ['10,000 captures/month', 'All formats (PNG, JPEG, PDF)', 'Markdown conversion', 'Priority support', 'Higher rate limits']
      })),
      wallet: payments.WALLET_ADDRESS,
      subscribe_url: 'POST /api/subscribe'
    });
    return;
  }

  sendError(res, 404, 'Not found. Visit / for API documentation.');
});

server.listen(PORT, async () => {
  console.log(`Screenshot API running at http://localhost:${PORT}`);
  console.log(`API keys: ${Object.keys(apiKeys).length} configured`);
  // Start payment polling (check every 30 seconds)
  payments.startPolling(30000);
  // Initialize x402 micropayment system
  try {
    await x402.initX402();
  } catch (err) {
    console.error('[x402] Failed to initialize:', err.message);
    console.log('[x402] API key auth still works. x402 payments disabled.');
  }
});
