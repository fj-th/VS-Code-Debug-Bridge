# VS Code Debug Bridge

Expose the VS Code debugger as an MCP server so AI agents can run debugging workflows through DAP.

Install the extension, connect to the local SSE endpoint, and control breakpoints, stepping, stack traces, variables, and evaluation from your AI tool.

## Why this extension

- No extra CLI process: the MCP server starts with VS Code.
- Language-agnostic debugging via DAP (with each language's debugger extension).
- Built for agent workflows: start, inspect, step, evaluate, and stop.

## Quick start (60 seconds)

1. Install the extension in VS Code.
2. Ensure your target language debugger is installed (JavaScript/TypeScript works out of the box).
3. Add this MCP server entry to your AI tool config (example: `~/.claude/settings.json`):

```json
{
  "mcpServers": {
    "vscode-debug": {
      "type": "sse",
      "url": "http://127.0.0.1:6589/sse"
    }
  }
}
```

4. Open your workspace in VS Code and call `start_debug(...)` from your AI tool.

## MCP tools

| Tool | Purpose |
|---|---|
| `start_debug` | Start a debug session by launch config name or inline config |
| `execute_command` | Send any DAP request to the active debug session |
| `stop_debug` | Stop the active debug session |

`execute_command` forwards [DAP (Debug Adapter Protocol)](https://microsoft.github.io/debug-adapter-protocol/) requests and returns raw JSON responses from the debugger.

## Common DAP commands

| Command | Description | Args |
|---|---|---|
| `threads` | List threads | - |
| `stackTrace` | Get call stack | `threadId` |
| `scopes` | List scopes (Local, Global, etc.) | `frameId` |
| `variables` | Get variable values | `variablesReference` |
| `evaluate` | Evaluate an expression | `expression`, `frameId` |
| `next` | Step over | `threadId` |
| `stepIn` | Step in | `threadId` |
| `stepOut` | Step out | `threadId` |
| `continue` | Resume execution | `threadId` |
| `pause` | Pause execution | `threadId` |
| `setBreakpoints` | Set breakpoints | `source`, `breakpoints` |

## Example flow

```js
start_debug({ configName: "Python: Current File" });

execute_command({ command: "threads" });
execute_command({ command: "stackTrace", args: { threadId: 1 } });
execute_command({ command: "scopes", args: { frameId: 0 } });
execute_command({ command: "variables", args: { variablesReference: 1 } });
execute_command({
  command: "evaluate",
  args: { expression: "len(items)", frameId: 0 },
});
execute_command({ command: "next", args: { threadId: 1 } });

stop_debug();
```

## Configuration

| Setting | Default | Description |
|---|---|---|
| `vscodeDebugBridge.port` | `6589` | Port for the local MCP endpoint (`http://127.0.0.1:<port>/sse`) |
| `vscodeDebugBridge.showStartupNotification` | `true` | Show startup notification when server is ready |

| Env var | Default | Description |
|---|---|---|
| `VSCODE_DEBUG_BRIDGE_PORT` | - | Overrides `vscodeDebugBridge.port` when set |

## VS Code command

- `Debug Bridge: Show MCP Endpoint` (`vscodeDebugBridge.showEndpoint`)

## Troubleshooting

- `No active debug session.`: run `start_debug` first.
- `VS Code refused to start the debug session.`: verify your `launch.json` config name or inline debug config.
- Cannot connect to `http://127.0.0.1:6589/sse`: confirm VS Code is open and another process is not using the same port.
- DAP command errors: verify command arguments for your debugger implementation.

## Security

The MCP endpoint binds to `127.0.0.1` only (local machine access).
