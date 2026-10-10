// HTTP entry point: the MCP endpoint (Streamable HTTP, stateless), the family approval page, and the Alexa+ simulator.

import http from "node:http";
import { readFileSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { buildServer } from "./tools.js";
import { listApprovals, decide, resetLedger } from "./guard.js";
import { chat, resetSession, mode, provider } from "./agent.js";
import { treasuryBillYields } from "./sources.js";
import { runWithDemo, cleanDemoId } from "./demo.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.PORT || 8790);
// 127.0.0.1 on a laptop; set HOST=0.0.0.0 inside a container so the host can reach it.
const HOST = process.env.HOST || "127.0.0.1";
const MAX_BODY = 64 * 1024;

// Each visitor may send 30 requests a minute. This also keeps our calls to FINRA and the SEC rare.
const LIMIT = Number(process.env.MG_RATE_PER_MIN || 30);
const hits = new Map();
function allowed(req) {
  const ip = (process.env.TRUST_PROXY === "1" && String(req.headers["x-forwarded-for"] || "").split(",")[0].trim()) || req.socket.remoteAddress;
  if (ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1") return true; // the simulator calling its own /mcp
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter((t) => now - t < 60_000);
  recent.push(now);
  hits.set(ip, recent);
  if (hits.size > 10_000) hits.clear();
  return recent.length <= LIMIT;
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY) throw Object.assign(new Error("request too large"), { status: 413 });
    chunks.push(c);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  try {
    return raw ? JSON.parse(raw) : undefined;
  } catch {
    throw Object.assign(new Error("body must be JSON"), { status: 400 });
  }
}

function send(res, code, body, type = "application/json") {
  const data = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(code, { "Content-Type": `${type}; charset=utf-8`, "Cache-Control": "no-store" });
  res.end(data);
}

const PAGES = { "/": "web/alexa.html", "/family": "web/family.html" };

const app = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  // ?demo=<id> gives this visitor their own ledger for every call in the request.
  runWithDemo(url.searchParams.get("demo"), () => handle(req, res, url));
});

async function handle(req, res, url) {
  try {
    if (url.pathname === "/healthz") return send(res, 200, { ok: true, mode: mode(), ai: provider() });
    // Only requests that do work count; page loads and the approvals poll do not.
    if (req.method === "POST" && !allowed(req)) return send(res, 429, { error: "Too many requests. Please wait a minute." });
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
      return send(res, 200, await chat({ sessionId: session_id, text: text.trim().slice(0, 2000), mcpUrl: `http://127.0.0.1:${PORT}/mcp${cleanDemoId(url.searchParams.get("demo")) ? `?demo=${url.searchParams.get("demo")}` : ""}` }));
    }
    if (url.pathname === "/api/reset" && req.method === "POST") {
      const { session_id } = (await readBody(req)) || {};
      if (session_id) resetSession(session_id);
      resetLedger();
      return send(res, 200, { ok: true, mode: mode(), ai: provider() });
    }
    if (url.pathname === "/api/mode") return send(res, 200, { mode: mode(), ai: provider() });
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
    if (!e.status) console.error(e);
    if (!res.headersSent) send(res, e.status || 500, { error: e.status ? e.message : "Something went wrong" });
  }
}

// Demo households are throwaway: drop any untouched for 3 days.
function sweepDemos() {
  const dir = join(dirname(process.env.MG_LEDGER || join(ROOT, "data", "ledger.json")), "demos");
  try {
    for (const f of readdirSync(dir)) if (Date.now() - statSync(join(dir, f)).mtimeMs > 3 * 864e5) unlinkSync(join(dir, f));
  } catch {} // no demos yet
}
sweepDemos();
setInterval(sweepDemos, 6 * 3600e3).unref();

app.listen(PORT, HOST, () => {
  treasuryBillYields().catch(() => {}); // warm the cache; a failure here is retried on first use
  console.log(`Money Guardian on http://${HOST}:${PORT}  (MCP endpoint /mcp)`);
});
