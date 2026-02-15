const vscode = require("vscode");
const http = require("http");
const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { SSEServerTransport } = require("@modelcontextprotocol/sdk/server/sse.js");
const { z } = require("zod");

const DEFAULT_PORT = 6589;

let httpServer;
let outputChannel;

function parsePort(value) {
  const port = Number(value);
  if (Number.isInteger(port) && port >= 1 && port <= 65535) {
    return port;
  }
  return undefined;
}

function resolvePort() {
  const envPort = parsePort(process.env.VSCODE_DEBUG_BRIDGE_PORT);
  if (envPort) return envPort;

  const config = vscode.workspace.getConfiguration("vscodeDebugBridge");
  const configuredPort = parsePort(config.get("port"));
  return configuredPort || DEFAULT_PORT;
}

function endpointForPort(port) {
  return `http://127.0.0.1:${port}/sse`;
}

function resolveFolder(name) {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) return undefined;
  if (!name) return folders[0];
  return folders.find((f) => f.name === name) || folders[0];
}

function ok(text) {
  return { content: [{ type: "text", text }] };
}

function fail(text) {
  return { content: [{ type: "text", text }], isError: true };
}

function activate(context) {
  outputChannel = vscode.window.createOutputChannel("Debug Bridge");
  context.subscriptions.push(outputChannel);
  const port = resolvePort();
  const endpoint = endpointForPort(port);

  const showEndpointCommand = vscode.commands.registerCommand(
    "vscodeDebugBridge.showEndpoint",
    () => {
      const msg = `Debug Bridge MCP endpoint: ${endpoint}`;
      outputChannel.appendLine(msg);
      vscode.window.showInformationMessage(msg);
    }
  );
  context.subscriptions.push(showEndpointCommand);

  const mcpServer = new McpServer({
    name: "vscode-debug-bridge",
    version: "0.1.0",
  });

  // ── Tool: start_debug ──────────────────────────────────
  mcpServer.tool(
    "start_debug",
    "Start a debug session in VS Code. Provide either configName (from launch.json) or a full inline config object.",
    {
      configName: z
        .string()
        .optional()
        .describe("Launch configuration name from launch.json"),
      config: z
        .record(z.any())
        .optional()
        .describe(
          'Inline debug configuration, e.g. {"type":"python","request":"launch","program":"${workspaceFolder}/main.py"}'
        ),
      folderName: z
        .string()
        .optional()
        .describe("Workspace folder name (defaults to first folder)"),
    },
    async ({ configName, config, folderName }) => {
      const target = configName || config;
      if (!target) {
        return fail("Either configName or config is required.");
      }
      try {
        const started = await vscode.debug.startDebugging(
          resolveFolder(folderName),
          target
        );
        if (!started) {
          return fail("VS Code refused to start the debug session.");
        }
        return ok("Debug session started.");
      } catch (err) {
        return fail(`Failed to start: ${err.message}`);
      }
    }
  );

  // ── Tool: execute_command ──────────────────────────────
  mcpServer.tool(
    "execute_command",
    [
      "Execute a DAP (Debug Adapter Protocol) request on the active debug session.",
      "Common commands: threads, stackTrace, scopes, variables, evaluate,",
      "next, stepIn, stepOut, continue, pause, setBreakpoints, breakpointLocations.",
      "Returns the raw DAP response as JSON.",
    ].join(" "),
    {
      command: z.string().describe("DAP request command name"),
      args: z
        .record(z.any())
        .optional()
        .describe("DAP request arguments (varies per command)"),
    },
    async ({ command, args }) => {
      const session = vscode.debug.activeDebugSession;
      if (!session) {
        return fail("No active debug session.");
      }
      try {
        const result = await session.customRequest(command, args || {});
        return ok(JSON.stringify(result, null, 2));
      } catch (err) {
        return fail(`DAP error (${command}): ${err.message}`);
      }
    }
  );

  // ── Tool: stop_debug ───────────────────────────────────
  mcpServer.tool(
    "stop_debug",
    "Stop the active debug session.",
    {},
    async () => {
      const session = vscode.debug.activeDebugSession;
      if (!session) {
        return ok("No active debug session.");
      }
      try {
        await vscode.debug.stopDebugging(session);
        return ok("Debug session stopped.");
      } catch (err) {
        return fail(`Failed to stop: ${err.message}`);
      }
    }
  );

  // ── HTTP + SSE transport ───────────────────────────────
  const transports = new Map();

  httpServer = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);

    if (req.method === "GET" && url.pathname === "/sse") {
      outputChannel.appendLine("[mcp] Client connected");
      const transport = new SSEServerTransport("/message", res);
      transports.set(transport.sessionId, transport);
      res.on("close", () => {
        transports.delete(transport.sessionId);
        outputChannel.appendLine("[mcp] Client disconnected");
      });
      await mcpServer.connect(transport);
      return;
    }

    if (req.method === "POST" && url.pathname === "/message") {
      const sessionId = url.searchParams.get("sessionId");
      const transport = transports.get(sessionId);
      if (!transport) {
        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end("Unknown session");
        return;
      }
      await transport.handlePostMessage(req, res);
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
  });

  httpServer.listen(port, "127.0.0.1", () => {
    const msg = `Debug Bridge MCP ready -> ${endpoint}`;
    outputChannel.appendLine(msg);

    const showStartupNotification = vscode.workspace
      .getConfiguration("vscodeDebugBridge")
      .get("showStartupNotification", true);
    if (showStartupNotification) {
      vscode.window.showInformationMessage(msg);
    }
  });

  httpServer.on("error", (err) => {
    outputChannel.appendLine(`[mcp:error] ${err.message}`);
    vscode.window.showErrorMessage(`Debug Bridge: ${err.message}`);
  });

  context.subscriptions.push({
    dispose: () => {
      if (httpServer) {
        httpServer.close();
        httpServer = undefined;
      }
    },
  });
}

function deactivate() {
  if (httpServer) {
    httpServer.close();
    httpServer = undefined;
  }
}

module.exports = { activate, deactivate };
