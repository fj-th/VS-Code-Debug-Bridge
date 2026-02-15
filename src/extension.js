const vscode = require("vscode");
const http = require("http");
const { randomUUID } = require("crypto");
const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const {
  StreamableHTTPServerTransport,
} = require("@modelcontextprotocol/sdk/server/streamableHttp.js");
const { z } = require("zod");

const DEFAULT_PORT = 6589;

let httpServer;
let outputChannel;
const streamableSessions = new Map();

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
  return `http://127.0.0.1:${port}/mcp`;
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

function toTextPayload(value, fallback) {
  if (typeof value === "string") {
    return value;
  }
  if (value === undefined) {
    return fallback;
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function getSessionId(req) {
  const value = req.headers["mcp-session-id"];
  return Array.isArray(value) ? value[0] : value;
}

function isInitializeRequest(message) {
  return (
    !!message &&
    !Array.isArray(message) &&
    message.jsonrpc === "2.0" &&
    message.method === "initialize" &&
    Object.prototype.hasOwnProperty.call(message, "id")
  );
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";

    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 1_000_000) {
        reject(new Error("Request body too large"));
        req.destroy();
      }
    });

    req.on("error", reject);
    req.on("end", () => {
      if (raw.length === 0) {
        resolve(undefined);
        return;
      }

      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(err);
      }
    });
  });
}

function writeJsonRpcError(res, statusCode, code, message) {
  res.writeHead(statusCode, { "Content-Type": "application/json" });
  res.end(
    JSON.stringify({
      jsonrpc: "2.0",
      error: { code, message },
      id: null,
    })
  );
}

function createMcpServer() {
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
        const text = toTextPayload(
          result,
          JSON.stringify(
            {
              command,
              result: null,
              note: "DAP request completed with no response payload.",
            },
            null,
            2
          )
        );
        return ok(text);
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

  return mcpServer;
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

  // ── HTTP Streamable transport (/mcp) ───────────────────

  httpServer = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", `http://127.0.0.1:${port}`);
      const method = req.method || "GET";

      if (url.pathname !== "/mcp") {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Not found");
        return;
      }

      if (!["GET", "POST", "DELETE"].includes(method)) {
        writeJsonRpcError(res, 405, -32000, "Method not allowed.");
        return;
      }

      const sessionId = getSessionId(req);

      if (method === "POST") {
        let parsedBody;
        try {
          parsedBody = await readJsonBody(req);
        } catch {
          writeJsonRpcError(res, 400, -32700, "Parse error: Invalid JSON");
          return;
        }

        if (sessionId) {
          const existingSession = streamableSessions.get(sessionId);
          if (!existingSession) {
            writeJsonRpcError(
              res,
              404,
              -32000,
              "Bad Request: Session not found"
            );
            return;
          }
          await existingSession.transport.handleRequest(req, res, parsedBody);
          return;
        }

        if (!isInitializeRequest(parsedBody)) {
          writeJsonRpcError(
            res,
            400,
            -32000,
            "Bad Request: No valid session ID provided"
          );
          return;
        }

        const mcpServer = createMcpServer();
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (newSessionId) => {
            streamableSessions.set(newSessionId, { transport, mcpServer });
            outputChannel.appendLine(`[mcp] Client connected (${newSessionId})`);
          },
        });

        transport.onclose = () => {
          const closedSessionId = transport.sessionId;
          if (closedSessionId && streamableSessions.has(closedSessionId)) {
            streamableSessions.delete(closedSessionId);
            outputChannel.appendLine(
              `[mcp] Client disconnected (${closedSessionId})`
            );
          }
          void mcpServer.close().catch(() => {});
        };

        transport.onerror = (err) => {
          outputChannel.appendLine(`[mcp:transport:error] ${err.message}`);
        };

        await mcpServer.connect(transport);
        await transport.handleRequest(req, res, parsedBody);
        return;
      }

      if (!sessionId) {
        writeJsonRpcError(
          res,
          400,
          -32000,
          "Bad Request: Mcp-Session-Id header is required"
        );
        return;
      }

      const existingSession = streamableSessions.get(sessionId);
      if (!existingSession) {
        writeJsonRpcError(res, 404, -32000, "Bad Request: Session not found");
        return;
      }

      await existingSession.transport.handleRequest(req, res);
    } catch (err) {
      outputChannel.appendLine(`[mcp:error] ${err.message}`);
      if (!res.headersSent) {
        writeJsonRpcError(res, 500, -32603, "Internal server error");
      }
    }
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
      for (const { transport, mcpServer } of streamableSessions.values()) {
        void transport.close().catch(() => {});
        void mcpServer.close().catch(() => {});
      }
      streamableSessions.clear();

      if (httpServer) {
        httpServer.close();
        httpServer = undefined;
      }
    },
  });
}

function deactivate() {
  for (const { transport, mcpServer } of streamableSessions.values()) {
    void transport.close().catch(() => {});
    void mcpServer.close().catch(() => {});
  }
  streamableSessions.clear();

  if (httpServer) {
    httpServer.close();
    httpServer = undefined;
  }
}

module.exports = { activate, deactivate };
