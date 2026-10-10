// HTTP entry point: the MCP endpoint (Streamable HTTP, stateless), the family approval page, and the Alexa+ simulator.

import http from "node:http";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { buildServer } from "./tools.js";
import { listApprovals, decide, resetLedger } from "./guard.js";
import { chat, resetSession, mode } from "./agent.js";
import { treasuryBillYields } from "./sources.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.PORT || 8790);

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : undefined;
}

function send(res, code, body, type = "application/json") {
  const data = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(code, { "Content-Type": `${type}; charset=utf-8`, "Cache-Control": "no-store" });
  res.end(data);
}

const PAGES = { "/": "web/alexa.html", "/family": "web/family.html" };

const app = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (url.pathname === "/mcp") {
      if (req.method !== "POST") return send(res, 405, { jsonrpc: "2.0", error: { code: -32000, message: "Use POST" }, id: null });
      // Stateless: a fresh server and transport per request, so any instance (or Lambda) can answer.
      const server = buildServer();
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on("close", () => { transport.close(); server.close(); });
      await server.connect(transport);
      return transport.handleRequest(req, res, await readBody(req));
    }
    if (url.pathname === "/api/chat" && req.method === "POST") {
      const { session_id, text } = (await readBody(req)) || {};
      if (!session_id || !text?.trim()) return send(res, 400, { error: "session_id and text are required" });
      return send(res, 200, await chat({ sessionId: session_id, text: text.trim().slice(0, 2000), mcpUrl: `http://127.0.0.1:${PORT}/mcp` }));
    }
    if (url.pathname === "/api/reset" && req.method === "POST") {
      const { session_id } = (await readBody(req)) || {};
      if (session_id) resetSession(session_id);
      resetLedger();
      return send(res, 200, { ok: true, mode: mode() });
    }
    if (url.pathname === "/api/mode") return send(res, 200, { mode: mode() });
    if (url.pathname === "/api/approvals" && req.method === "GET") return send(res, 200, listApprovals());
    if (url.pathname.startsWith("/api/approvals/") && req.method === "POST") {
      const id = url.pathname.split("/")[3];
      const { decision } = (await readBody(req)) || {};
      if (!["approve", "deny"].includes(decision)) return send(res, 400, { error: "decision must be approve or deny" });
      return send(res, 200, decide(id, decision));
    }
    if (PAGES[url.pathname]) return send(res, 200, readFileSync(join(ROOT, PAGES[url.pathname]), "utf8"), "text/html");
    send(res, 404, { error: "not found" });
  } catch (e) {
    console.error(e);
    if (!res.headersSent) send(res, 500, { error: String(e.message || e) });
  }
});

app.listen(PORT, "127.0.0.1", () => {
  treasuryBillYields().catch(() => {}); // warm the cache; a failure here is retried on first use
  console.log(`Money Guardian on http://127.0.0.1:${PORT}  (MCP endpoint /mcp)`);
});
