// HTTP entry point: the MCP endpoint (Streamable HTTP, stateless), the family approval page, and the Alexa+ simulator.

import http from "node:http";
import { readFileSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { buildServer } from "./tools.js";
import { listApprovals, approvalStatus, decide, resetLedger, household } from "./guard.js";
import { readToken } from "./notify.js";
import { chat, resetSession, mode, provider, readCard } from "./agent.js";
import { treasuryBillYields, warmBanks } from "./sources.js";
import { runWithDemo, cleanDemoId } from "./demo.js";
import { secIndexDate } from "./secindex.js";
import { oauthEnabled, protectedResourceMetadata, authorizationServerMetadata, authorizeGet, authorizePost, token, readBearer, checkMcp } from "./oauth.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.PORT || 8790);
// 127.0.0.1 on a laptop; set HOST=0.0.0.0 inside a container so the host can reach it.
const HOST = process.env.HOST || "127.0.0.1";
const MAX_BODY = 64 * 1024;

// Each visitor may send 30 requests a minute. This also keeps our calls to FINRA and the SEC rare.
const LIMIT = Number(process.env.MG_RATE_PER_MIN || 30);
const hits = new Map();
const clientIp = (req) => (process.env.TRUST_PROXY === "1" && String(req.headers["x-forwarded-for"] || "").split(",")[0].trim()) || req.socket.remoteAddress;
function allowed(req) {
  const ip = clientIp(req);
  if (ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1") return true; // the simulator calling its own /mcp
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter((t) => now - t < 60_000);
  recent.push(now);
  hits.set(ip, recent);
  if (hits.size > 10_000) hits.clear();
  return recent.length <= LIMIT;
}

async function readRaw(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY) throw Object.assign(new Error("request too large"), { status: 413 });
    chunks.push(c);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function readBody(req) {
  const raw = await readRaw(req);
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

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

// The page an emailed link opens. Opening it changes nothing; only a button press decides.
function answerPage(a, token) {
  const name = household().trusted_contact.name;
  const body = !a || a.error ? "<h1>This request no longer exists</h1>"
    : `<h1>${esc(a.summary)}</h1>
${a.reasons?.length ? `<ul>${a.reasons.map((r) => `<li>${esc(r)}</li>`).join("")}</ul>` : ""}
${a.status === "pending"
    ? `<form method="post" action="/a/${esc(token)}"><button name="decision" value="approve" class="ok">Approve</button><button name="decision" value="deny" class="no">Say no</button></form>
<p class="muted">Nothing is paid or sent until you answer.</p>`
    : `<p class="done ${a.status}">${a.status === "approved" ? "You approved this." : "You said no."}</p>`}`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer"><title>Money Guardian</title><style>
:root{--bg:#eef0f3;--card:#fff;--ink:#1d1f24;--muted:#5d6270;--ok:#1f6f5c;--no:#a33a2a}
@media (prefers-color-scheme:dark){:root{--bg:#101317;--card:#1b1f26;--ink:#eceef2;--muted:#a3a9b6;--ok:#47b496;--no:#f07a66}}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;display:flex;justify-content:center;padding:24px 16px}
main{width:100%;max-width:440px;background:var(--card);border-radius:20px;padding:20px}h1{font-size:19px;margin:4px 0 8px}
.eyebrow,.muted{color:var(--muted);font-size:14px}form{display:flex;gap:8px;margin-top:12px}
button{flex:1;font:inherit;font-weight:600;padding:14px;border:0;border-radius:12px;color:#fff;cursor:pointer}.ok{background:var(--ok)}.no{background:var(--no)}
.done{font-weight:600}.done.approved{color:var(--ok)}.done.denied{color:var(--no)}</style></head>
<body><main><p class="eyebrow">Money Guardian · for ${esc(name)}</p>${body}</main></body></html>`;
}

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
      const body = await readBody(req);
      // With OAuth on (see src/oauth.js), every request needs a token, and household tools a linked household.
      const auth = readBearer(req.headers.authorization);
      const refused = checkMcp(auth, body);
      if (refused) return send(res, refused.status, refused.body);
      // Stateless: a fresh server and transport per request, so any instance (or Lambda) can answer.
      const server = buildServer();
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on("close", () => { transport.close(); server.close(); });
      await server.connect(transport);
      // A linked Alexa account acts for the real household; only the simulator may pick a demo household.
      const run = () => transport.handleRequest(req, res, body);
      return auth && !auth.internal ? runWithDemo(null, run) : run();
    }
    if (url.pathname.startsWith("/.well-known/oauth-")) {
      if (!oauthEnabled()) return send(res, 404, { error: "OAuth is not configured on this server" });
      if (url.pathname === "/.well-known/oauth-protected-resource" || url.pathname === "/.well-known/oauth-protected-resource/mcp") return send(res, 200, protectedResourceMetadata());
      if (url.pathname === "/.well-known/oauth-authorization-server") return send(res, 200, authorizationServerMetadata());
    }
    if (url.pathname === "/oauth/authorize" && oauthEnabled()) {
      const r = req.method === "POST" ? authorizePost(new URLSearchParams(await readRaw(req)), clientIp(req)) : authorizeGet(url.searchParams);
      if (r.redirect) { res.writeHead(302, { Location: r.redirect, "Cache-Control": "no-store" }); return res.end(); }
      res.writeHead(r.status, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Frame-Options": "DENY", "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'" });
      return res.end(r.html);
    }
    if (url.pathname === "/oauth/token" && oauthEnabled()) {
      if (req.method !== "POST") return send(res, 405, { error: "invalid_request", error_description: "Use POST" });
      const r = token(req.headers.authorization, new URLSearchParams(await readRaw(req)), url.searchParams);
      res.writeHead(r.status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", Pragma: "no-cache" });
      return res.end(JSON.stringify(r.body));
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
    if (url.pathname === "/api/ui" && req.method === "GET") {
      const uri = url.searchParams.get("uri") || "";
      if (!/^ui:\/\/money-guardian\/[a-z0-9-]+\.html$/.test(uri)) return send(res, 404, { error: "unknown card" });
      return send(res, 200, await readCard({ uri, mcpUrl: `http://127.0.0.1:${PORT}/mcp` }));
    }
    if (url.pathname === "/api/mode") return send(res, 200, { mode: mode(), ai: provider() });
    if (url.pathname === "/api/approvals" && req.method === "GET") return send(res, 200, listApprovals());
    if (url.pathname.startsWith("/api/approvals/") && req.method === "POST") {
      const id = url.pathname.split("/")[3];
      const { decision } = (await readBody(req)) || {};
      if (!["approve", "deny"].includes(decision)) return send(res, 400, { error: "decision must be approve or deny" });
      return send(res, 200, decide(id, decision));
    }
    if (url.pathname.startsWith("/a/")) {
      const token = url.pathname.slice(3);
      const t = readToken(token);
      if (!t) return send(res, 404, answerPage(null, token), "text/html");
      return runWithDemo(t.d, async () => {
        if (req.method === "POST") {
          const decision = new URLSearchParams(await readRaw(req)).get("decision");
          if (!["approve", "deny"].includes(decision)) return send(res, 400, { error: "decision must be approve or deny" });
          decide(t.a, decision);
        }
        send(res, 200, answerPage(approvalStatus(t.a), token), "text/html");
      });
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
  // Warm the slow-changing sources now, and keep them warm: a caller never waits for them.
  const warm = () => { treasuryBillYields().catch(() => {}); warmBanks().catch(() => {}); };
  warm();
  setInterval(warm, 9 * 60 * 1000).unref();
  console.log(`Money Guardian on http://${HOST}:${PORT}  (MCP endpoint /mcp)`);
  // Load the SEC register now (about a second), so the first caller doesn't wait for it.
  try { console.log(`SEC adviser register as of ${secIndexDate()}`); } catch (e) { console.error(`SEC adviser register unavailable: ${e.message}`); }
});
