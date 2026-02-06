#!/usr/bin/env node

/**
 * OpSpawn Screenshot API - MCP Server
 *
 * Exposes screenshot capture and markdown conversion as MCP tools
 * that LLM agents can use via the Model Context Protocol.
 *
 * Usage:
 *   node mcp-server.mjs                    # stdio transport (for Claude Code, etc.)
 *   SNAPAPI_URL=http://localhost:3001 node mcp-server.mjs  # custom API URL
 *
 * Add to claude_desktop_config.json:
 *   {
 *     "mcpServers": {
 *       "snapapi": {
 *         "command": "node",
 *         "args": ["/path/to/mcp-server.mjs"]
 *       }
 *     }
 *   }
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const API_URL = process.env.SNAPAPI_URL || 'http://localhost:3001';
const API_KEY = process.env.SNAPAPI_API_KEY || '';

async function apiRequest(path, options = {}) {
  const url = new URL(path, API_URL);

  if (options.params) {
    for (const [k, v] of Object.entries(options.params)) {
      if (v !== undefined && v !== null && v !== '') {
        url.searchParams.set(k, String(v));
      }
    }
  }

  const headers = {};
  if (API_KEY) headers['X-API-Key'] = API_KEY;
  if (options.body) headers['Content-Type'] = 'application/json';

  const resp = await fetch(url.toString(), {
    method: options.method || 'GET',
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  return resp;
}

const server = new McpServer({
  name: 'snapapi',
  version: '1.0.0',
});

// Tool 1: Capture screenshot from URL
server.tool(
  'capture_screenshot',
  'Capture a screenshot or PDF of a web page. Returns the image as base64-encoded data.',
  {
    url: z.string().url().describe('The URL to capture'),
    format: z.enum(['png', 'jpeg', 'pdf']).default('png').describe('Output format'),
    width: z.number().int().min(320).max(3840).default(1280).optional()
      .describe('Viewport width in pixels'),
    height: z.number().int().min(200).max(2160).default(800).optional()
      .describe('Viewport height in pixels'),
    fullPage: z.boolean().default(false).optional()
      .describe('Capture full scrollable page instead of just viewport'),
    delay: z.number().int().min(0).max(10000).default(0).optional()
      .describe('Milliseconds to wait after page load before capture'),
  },
  async ({ url, format, width, height, fullPage, delay }) => {
    try {
      const resp = await apiRequest('/api/capture', {
        params: { url, format, width, height, fullPage, delay },
      });

      if (!resp.ok) {
        const err = await resp.json().catch(() => ({ error: resp.statusText }));
        return {
          content: [{ type: 'text', text: `Error ${resp.status}: ${err.error || resp.statusText}` }],
          isError: true,
        };
      }

      const buffer = Buffer.from(await resp.arrayBuffer());
      const mimeType = format === 'pdf' ? 'application/pdf'
        : format === 'jpeg' ? 'image/jpeg' : 'image/png';

      if (format === 'pdf') {
        return {
          content: [{
            type: 'resource',
            resource: {
              uri: `data:${mimeType};base64,${buffer.toString('base64')}`,
              mimeType,
              text: buffer.toString('base64'),
            },
          }],
        };
      }

      return {
        content: [{
          type: 'image',
          data: buffer.toString('base64'),
          mimeType,
        }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Failed to capture screenshot: ${err.message}` }],
        isError: true,
      };
    }
  }
);

// Tool 2: Convert Markdown to PDF
server.tool(
  'markdown_to_pdf',
  'Convert Markdown text to a styled PDF document. Returns base64-encoded PDF.',
  {
    markdown: z.string().describe('Markdown content to convert'),
    theme: z.enum(['light', 'dark']).default('light').optional()
      .describe('Visual theme for the PDF'),
    paperSize: z.enum(['A4', 'Letter', 'Legal', 'Tabloid']).default('A4').optional()
      .describe('Paper size'),
    landscape: z.boolean().default(false).optional()
      .describe('Use landscape orientation'),
    fontSize: z.string().default('16px').optional()
      .describe('Base font size (e.g. "14px", "18px")'),
  },
  async ({ markdown, theme, paperSize, landscape, fontSize }) => {
    try {
      const resp = await apiRequest('/api/md2pdf', {
        method: 'POST',
        body: { markdown, theme, paperSize, landscape, fontSize },
      });

      if (!resp.ok) {
        const err = await resp.json().catch(() => ({ error: resp.statusText }));
        return {
          content: [{ type: 'text', text: `Error ${resp.status}: ${err.error || resp.statusText}` }],
          isError: true,
        };
      }

      const buffer = Buffer.from(await resp.arrayBuffer());
      return {
        content: [{
          type: 'resource',
          resource: {
            uri: `data:application/pdf;base64,${buffer.toString('base64')}`,
            mimeType: 'application/pdf',
            text: buffer.toString('base64'),
          },
        }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Failed to convert markdown to PDF: ${err.message}` }],
        isError: true,
      };
    }
  }
);

// Tool 3: Convert Markdown to PNG image
server.tool(
  'markdown_to_image',
  'Convert Markdown text to a styled PNG or JPEG image. Returns the image as base64.',
  {
    markdown: z.string().describe('Markdown content to convert'),
    format: z.enum(['png', 'jpeg']).default('png').optional()
      .describe('Image format'),
    theme: z.enum(['light', 'dark']).default('light').optional()
      .describe('Visual theme'),
    width: z.number().int().min(320).max(3840).default(1280).optional()
      .describe('Image width in pixels'),
    fontSize: z.string().default('16px').optional()
      .describe('Base font size'),
  },
  async ({ markdown, format, theme, width, fontSize }) => {
    try {
      const resp = await apiRequest('/api/md2png', {
        method: 'POST',
        body: { markdown, format, theme, width, fontSize },
      });

      if (!resp.ok) {
        const err = await resp.json().catch(() => ({ error: resp.statusText }));
        return {
          content: [{ type: 'text', text: `Error ${resp.status}: ${err.error || resp.statusText}` }],
          isError: true,
        };
      }

      const buffer = Buffer.from(await resp.arrayBuffer());
      const mimeType = format === 'jpeg' ? 'image/jpeg' : 'image/png';
      return {
        content: [{
          type: 'image',
          data: buffer.toString('base64'),
          mimeType,
        }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Failed to convert markdown to image: ${err.message}` }],
        isError: true,
      };
    }
  }
);

// Tool 4: Convert Markdown to HTML (free, no auth)
server.tool(
  'markdown_to_html',
  'Convert Markdown text to styled HTML. Free, no authentication required.',
  {
    markdown: z.string().describe('Markdown content to convert'),
    theme: z.enum(['light', 'dark']).default('light').optional()
      .describe('Visual theme'),
    fontSize: z.string().default('16px').optional()
      .describe('Base font size'),
  },
  async ({ markdown, theme, fontSize }) => {
    try {
      const resp = await apiRequest('/api/md2html', {
        method: 'POST',
        body: { markdown, theme, fontSize },
      });

      if (!resp.ok) {
        const err = await resp.text();
        return {
          content: [{ type: 'text', text: `Error ${resp.status}: ${err}` }],
          isError: true,
        };
      }

      const html = await resp.text();
      return {
        content: [{ type: 'text', text: html }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Failed to convert markdown to HTML: ${err.message}` }],
        isError: true,
      };
    }
  }
);

// Tool 5: Get API status
server.tool(
  'api_status',
  'Check the SnapAPI service health, stats, and current load.',
  {},
  async () => {
    try {
      const resp = await apiRequest('/api/status');
      const data = await resp.json();
      return {
        content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Failed to get status: ${err.message}` }],
        isError: true,
      };
    }
  }
);

// Resource: API documentation
server.resource(
  'api-docs',
  'snapapi://docs',
  { description: 'SnapAPI documentation and endpoint reference' },
  async () => {
    try {
      const resp = await apiRequest('/api');
      const data = await resp.json();
      return {
        contents: [{
          uri: 'snapapi://docs',
          mimeType: 'application/json',
          text: JSON.stringify(data, null, 2),
        }],
      };
    } catch (err) {
      return {
        contents: [{
          uri: 'snapapi://docs',
          mimeType: 'text/plain',
          text: `Failed to fetch docs: ${err.message}`,
        }],
      };
    }
  }
);

// Start server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`MCP server error: ${err.message}\n`);
  process.exit(1);
});
