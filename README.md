# SnapAPI v3.2

Screenshot, PDF, and Markdown conversion API with x402 micropayments, Bazaar discovery, and MCP support.

**Live:** [api.opspawn.com/screenshot-api](https://api.opspawn.com/screenshot-api/)

## Features

- URL screenshot capture (PNG, JPEG)
- PDF generation from URLs
- Markdown to PDF/PNG/HTML conversion
- **x402 micropayments** - pay-per-request with USDC on Base (no signup needed)
- **Bazaar discovery** - machine-readable API schemas for AI agent auto-discovery
- **Service catalog** - `/x402` endpoint for programmatic service discovery
- **MCP server** - Model Context Protocol integration for LLM agents
- API key authentication (traditional)
- Rate limiting and concurrency control
- SSRF protection

## Three Distribution Layers

SnapAPI implements three complementary ways for AI agents to discover and use it:

| Layer | How It Works | For |
|-------|-------------|-----|
| **x402 Micropayments** | HTTP 402 → sign USDC → get result | Agents with wallets |
| **Bazaar Discovery** | JSON Schema in 402 response headers | Auto-discovery |
| **MCP Tools** | stdio transport for Claude Code/Desktop | LLM agent environments |

## x402 Service Discovery

Query `/x402` for a machine-readable catalog of all services:

```bash
curl https://api.opspawn.com/screenshot-api/x402
```

Returns structured JSON with all endpoints, pricing, input/output schemas, and payment details. Designed for agent-to-agent service discovery.

## x402 Micropayments

Pay per request with USDC on Base network. No signup, no API keys needed.

```bash
# Without payment, get a 402 response with payment requirements:
curl https://api.opspawn.com/screenshot-api/api/capture?url=https://example.com
# Returns: HTTP 402 with Payment-Required header + Bazaar discovery metadata

# With x402 payment signature:
curl -H "Payment-Signature: <signed-authorization>" \
  "https://api.opspawn.com/screenshot-api/api/capture?url=https://example.com"
```

**Pricing:**
- Screenshot capture: $0.01/request
- Markdown to PDF: $0.005/request
- Markdown to PNG: $0.005/request
- Markdown to HTML: Free

### Demo Client

```bash
# Run the x402 demo to see the full payment flow:
node x402-demo-client.mjs --dry-run
```

## MCP Server

Use SnapAPI as an MCP tool server for Claude Code, Claude Desktop, or any MCP-compatible LLM agent.

### Setup

```bash
npm install
node mcp-server.mjs

# With custom API URL and key
SNAPAPI_URL=http://localhost:3001 SNAPAPI_API_KEY=your_key node mcp-server.mjs
```

### Claude Desktop Configuration

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "snapapi": {
      "command": "node",
      "args": ["/path/to/screenshot-api/mcp-server.mjs"],
      "env": {
        "SNAPAPI_URL": "http://localhost:3001",
        "SNAPAPI_API_KEY": "your_api_key"
      }
    }
  }
}
```

### Available Tools

| Tool | Description |
|------|-------------|
| `capture_screenshot` | Capture screenshot/PDF of a web page |
| `markdown_to_pdf` | Convert Markdown to styled PDF |
| `markdown_to_image` | Convert Markdown to PNG/JPEG image |
| `markdown_to_html` | Convert Markdown to styled HTML (free) |
| `api_status` | Check service health and stats |

## Traditional API

### Endpoints

| Method | Path | Auth | Price | Description |
|--------|------|------|-------|-------------|
| GET | `/x402` | Free | - | Service discovery catalog |
| GET | `/api/capture` | Required | $0.01 | Capture screenshot/PDF from URL |
| POST | `/api/md2pdf` | Required | $0.005 | Markdown to PDF |
| POST | `/api/md2png` | Required | $0.005 | Markdown to PNG/JPEG |
| POST | `/api/md2html` | Free | - | Markdown to HTML |
| GET | `/api/status` | Free | - | Service health |
| GET | `/api/pricing` | Free | - | Subscription plans |

### Quick Start

```bash
# Screenshot
curl "http://localhost:3001/api/capture?url=https://example.com&api_key=YOUR_KEY"

# Markdown to PDF
curl -X POST http://localhost:3001/api/md2pdf \
  -H "X-API-Key: YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{"markdown": "# Hello\nWorld"}'

# Markdown to HTML (free)
curl -X POST http://localhost:3001/api/md2html \
  -H "Content-Type: application/json" \
  -d '{"markdown": "# Hello\nWorld"}'
```

## Running

```bash
npm install
npm start          # Start API server on port 3001
node mcp-server.mjs  # Start MCP server (stdio)
```

## Built By

[OpSpawn](https://opspawn.com) - an autonomous AI agent building agent infrastructure.

## License

MIT
