# Iris + Claude Desktop

## Setup

1. Install Iris globally (or use npx):

```bash
npm install -g @iris-eval/mcp-server
```

2. Open Claude Desktop settings and add Iris as an MCP server. Edit your MCP config file:

**macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
**Windows:** `%APPDATA%\Claude\claude_desktop_config.json`

Add the following:

```json
{
  "mcpServers": {
    "iris-eval": {
      "command": "npx",
      "args": ["@iris-eval/mcp-server"]
    }
  }
}
```

3. Restart Claude Desktop.

4. Iris tools are now available. Try asking Claude:
   - "Log a trace for agent 'my-agent' with output 'Hello world'"
   - "Evaluate the output 'The weather is sunny today' for completeness"
   - "Show me recent traces"

## With Dashboard

To also enable the web dashboard:

```json
{
  "mcpServers": {
    "iris-eval": {
      "command": "npx",
      "args": ["@iris-eval/mcp-server", "--dashboard"]
    }
  }
}
```

Then open `http://localhost:6920` in your browser to view the dashboard.

## With HTTP Transport

For network access (e.g., multiple agents connecting):

```json
{
  "mcpServers": {
    "iris-eval": {
      "command": "npx",
      "args": [
        "@iris-eval/mcp-server",
        "--transport", "http",
        "--port", "3000",
        "--api-key", "your-secret-key",
        "--dashboard"
      ]
    }
  }
}
```
