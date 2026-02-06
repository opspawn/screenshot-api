# SnapAPI v3.1

Screenshot, PDF, and Markdown conversion API with x402 micropayments and MCP support.

## Features
- URL screenshot capture (PNG, JPEG)
- PDF generation from URLs
- Markdown to PDF/PNG/HTML conversion
- **x402 micropayments** - pay-per-request with USDC on Base (no signup needed)
- **Bazaar discovery** - machine-readable API schemas for AI agent auto-discovery
- **MCP server** - Model Context Protocol integration for LLM agents
- API key authentication (traditional)
- Rate limiting and concurrency control
- SSRF protection

## x402 Micropayments

Pay per request with USDC on Base network. No signup, no API keys needed.

```bash
# Without payment, you get a 402 response with payment requirements:
curl https://api.opspawn.com/screenshot-api/api/capture?url=https://example.com
# Returns: HTTP 402 with Payment-Required header

# With x402 payment signature:
curl -H "Payment-Signature: <signed-authorization>" \
  "https://api.opspawn.com/screenshot-api/api/capture?url=https://example.com"
```

**Pricing:**
- Screenshot capture: $0.01/request
- Markdown to PDF: $0.005/request
- Markdown to PNG: $0.005/request

## MCP Server

Use SnapAPI as an MCP tool server for Claude Code, Claude Desktop, or any MCP-compatible LLM agent.

### Setup

```bash
# Install dependencies
npm install

# Run MCP server (stdio transport)
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

### Available Resources

| Resource | URI | Description |
|----------|-----|-------------|
| API Docs | `snapapi://docs` | Full API documentation |

## Traditional API

### Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/capture` | Required | Capture screenshot/PDF from URL |
| POST | `/api/md2pdf` | Required | Markdown to PDF |
| POST | `/api/md2png` | Required | Markdown to PNG/JPEG |
| POST | `/api/md2html` | Free | Markdown to HTML |
| GET | `/api/status` | Free | Service health |
| GET | `/api/pricing` | Free | Subscription plans |

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
