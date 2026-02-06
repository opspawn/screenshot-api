// x402.js - x402 micropayment integration for SnapAPI
// Enables pay-per-request payments from AI agents via the x402 protocol

const { x402HTTPResourceServer, x402ResourceServer, HTTPFacilitatorClient } = require('@x402/core/server');
const { ExactEvmScheme } = require('@x402/evm/exact/server');

const WALLET_ADDRESS = '0x7483a9F237cf8043704D6b17DA31c12BfFF860DD';

// Pricing per endpoint (in USD, paid in USDC)
const PRICES = {
  capture: '$0.01',     // $0.01 per screenshot
  md2pdf: '$0.005',     // $0.005 per markdown-to-PDF
  md2png: '$0.005',     // $0.005 per markdown-to-PNG
};

// Accept x402 micropayments on Base (best EVM support for x402)
// Polygon subscription still available via /api/subscribe
const NETWORK = 'eip155:8453'; // Base Mainnet

// PayAI facilitator: supports Base mainnet, no API key required
const FACILITATOR_URL = 'https://facilitator.payai.network';

// HTTP adapter for raw Node.js http.IncomingMessage
class NodeHTTPAdapter {
  constructor(req) {
    this.req = req;
    const host = req.headers.host || 'localhost';
    this.parsedUrl = new URL(req.url || '/', `http://${host}`);
  }
  getHeader(name) { return this.req.headers[name.toLowerCase()]; }
  getMethod() { return this.req.method || 'GET'; }
  getPath() { return this.parsedUrl.pathname; }
  getUrl() { return this.parsedUrl.href; }
  getAcceptHeader() { return this.req.headers.accept || ''; }
  getUserAgent() { return this.req.headers['user-agent'] || ''; }
}

let httpResourceServer = null;
let initialized = false;

function createRouteConfig(price, description, mimeType) {
  return {
    accepts: {
      scheme: 'exact',
      network: NETWORK,
      payTo: WALLET_ADDRESS,
      price,
      maxTimeoutSeconds: 120,
    },
    description,
    mimeType,
  };
}

async function initX402() {
  if (initialized) return httpResourceServer;

  const facilitator = new HTTPFacilitatorClient({ url: FACILITATOR_URL });
  const resourceServer = new x402ResourceServer([facilitator]);

  resourceServer.register(NETWORK, new ExactEvmScheme());

  const routes = {
    'GET /api/capture': createRouteConfig(
      PRICES.capture,
      'Capture screenshot or PDF from a URL',
      'image/png'
    ),
    'POST /api/md2pdf': createRouteConfig(
      PRICES.md2pdf,
      'Convert Markdown to PDF',
      'application/pdf'
    ),
    'POST /api/md2png': createRouteConfig(
      PRICES.md2png,
      'Convert Markdown to PNG image',
      'image/png'
    ),
  };

  httpResourceServer = new x402HTTPResourceServer(resourceServer, routes);
  await httpResourceServer.initialize();
  initialized = true;
  console.log('[x402] Micropayment system initialized (PayAI facilitator)');
  console.log(`[x402] Accepting USDC on Base to ${WALLET_ADDRESS}`);
  console.log(`[x402] Prices: capture=${PRICES.capture}, md2pdf=${PRICES.md2pdf}, md2png=${PRICES.md2png}`);
  return httpResourceServer;
}

// Check if a request has an x402 payment header
function hasX402Payment(req) {
  return !!(req.headers['payment-signature'] || req.headers['x-payment']);
}

// Process an x402 payment request
// Returns: { allowed: true, settle: Function } or { allowed: false, status, headers, body }
async function processPayment(req) {
  if (!httpResourceServer) {
    return { allowed: false, status: 503, headers: {}, body: { error: 'x402 not initialized' } };
  }

  const adapter = new NodeHTTPAdapter(req);
  const context = {
    adapter,
    path: adapter.getPath(),
    method: adapter.getMethod(),
  };

  const result = await httpResourceServer.processHTTPRequest(context);

  if (result.type === 'no-payment-required') {
    return { allowed: true, settle: null };
  }

  if (result.type === 'payment-error') {
    return {
      allowed: false,
      status: result.response.status,
      headers: result.response.headers || {},
      body: result.response.body,
      isHtml: result.response.isHtml,
    };
  }

  if (result.type === 'payment-verified') {
    const settleFn = async () => {
      try {
        const settleResult = await httpResourceServer.processSettlement(
          result.paymentPayload,
          result.paymentRequirements,
          result.declaredExtensions
        );
        return settleResult;
      } catch (err) {
        console.error('[x402] Settlement error:', err.message);
        return null;
      }
    };
    return { allowed: true, settle: settleFn };
  }

  return { allowed: false, status: 500, headers: {}, body: { error: 'Unknown payment state' } };
}

module.exports = {
  initX402,
  hasX402Payment,
  processPayment,
  PRICES,
  WALLET_ADDRESS,
  NETWORK,
};
