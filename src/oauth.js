// OAuth 2.1 for Alexa+, as its MCP add-on docs require (Authentication and Account Linking pages):
//
//   Tier 1, client_credentials: Alexa+ itself, scope mcp:service. Enough for initialize, tools/list,
//     the card, and the four public checks (seller, pitch, product, bank): no one has to sign up to
//     ask "is this a scam?".
//   Tier 2, authorization_code + PKCE S256: the household signs in once ("account linking"), scope
//     mcp:tools. Needed for the household's own tools: bills, family approval, payments.
//
// A tool called without the token it needs gets HTTP 401 with a JSON body and no WWW-Authenticate
// header; Alexa+ then starts account linking. No dynamic client registration and no OIDC: Alexa+
// supports neither. Off unless configured (see .env.example); then /mcp is open, as on a laptop.

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const env = (k) => process.env[k] || "";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export const oauthEnabled = () =>
  ["MG_PUBLIC_URL", "MG_LINK_SECRET", "MG_OAUTH_CLIENT_ID", "MG_OAUTH_CLIENT_SECRET", "MG_OAUTH_REDIRECT_URIS", "MG_HOUSEHOLD_PASSCODE"].every((k) => env(k));

const base = () => env("MG_PUBLIC_URL").replace(/\/$/, "");
export const resourceUri = () => `${base()}/mcp`;

export const USER_TOOLS = new Set(["review_bills", "request_family_approval", "approval_status", "pay_bill"]);
const ACCESS_TTL = 3600; // seconds; Alexa+ asks for one hour or less
const CODE_TTL_MS = 5 * 60e3;
const REFRESH_TTL_MS = 90 * 864e5;
const FORM_TTL_MS = 10 * 60e3;

// ---------- Small helpers ----------

const b64 = (b) => Buffer.from(b).toString("base64url");
const sha256 = (s) => createHash("sha256").update(s).digest();
const key = (purpose) => createHmac("sha256", env("MG_LINK_SECRET")).update(`oauth:${purpose}`).digest(); // one key per use
const mac = (purpose, s) => createHmac("sha256", key(purpose)).update(s).digest("base64url");
const same = (a, b) => { const x = sha256(String(a)), y = sha256(String(b)); return timingSafeEqual(x, y); };

function seal(purpose, obj) {
  const p = b64(JSON.stringify(obj));
  return `${p}.${mac(purpose, p)}`;
}
function unseal(purpose, token) {
  if (typeof token !== "string") return null;
  const [p, m] = token.split(".");
  if (!p || !m || m.length !== 43 || !same(m, mac(purpose, p))) return null;
  try { return JSON.parse(Buffer.from(p, "base64url").toString("utf8")); } catch { return null; }
}

const sameResource = (r) => r === resourceUri() || r === `${resourceUri()}/`;
const redirectAllowed = (u) => env("MG_OAUTH_REDIRECT_URIS").split(",").map((s) => s.trim()).filter(Boolean).includes(u);

// ---------- Discovery documents ----------

/** /.well-known/oauth-protected-resource (RFC 9728): which authorization server guards /mcp. */
export const protectedResourceMetadata = () => ({
  resource: resourceUri(),
  authorization_servers: [base()],
  scopes_supported: ["mcp:tools"],
  bearer_methods_supported: ["header"],
  resource_name: "Money Guardian",
});

/** /.well-known/oauth-authorization-server (RFC 8414). */
export const authorizationServerMetadata = () => ({
  issuer: base(),
  authorization_endpoint: `${base()}/oauth/authorize`,
  token_endpoint: `${base()}/oauth/token`,
  response_types_supported: ["code"],
  grant_types_supported: ["client_credentials", "authorization_code", "refresh_token"],
  code_challenge_methods_supported: ["S256"],
  token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"],
  scopes_supported: ["mcp:service", "mcp:tools"],
});

// ---------- Tokens ----------

/** The simulator on this same server is Alexa+ for the demo: it gets a token no one else can know. */
const INTERNAL = b64(randomBytes(32));
export const internalToken = () => INTERNAL;

function accessToken({ sub, scope, cid }) {
  return seal("access", { t: "access", sub, scope, cid, aud: resourceUri(), exp: Math.floor(Date.now() / 1000) + ACCESS_TTL, jti: b64(randomBytes(9)) });
}

/** Who a bearer token speaks for, or null. { sub, scope, internal } */
export function readBearer(header) {
  const m = /^Bearer ([A-Za-z0-9._~+/=-]+)$/.exec(String(header || ""));
  if (!m) return null;
  if (same(m[1], INTERNAL)) return { sub: "simulator", scope: "mcp:service mcp:tools", internal: true };
  if (!oauthEnabled()) return null;
  const t = unseal("access", m[1]);
  if (!t || t.t !== "access" || t.aud !== resourceUri() || !(t.exp > Date.now() / 1000)) return null;
  return { sub: t.sub, scope: t.scope, cid: t.cid };
}

/**
 * May this MCP request go ahead? Every request needs a token; a call to a household tool needs a
 * linked household (scope mcp:tools). Returns null when allowed, or the 401 to send.
 */
export function checkMcp(auth, body) {
  if (!oauthEnabled() && !auth) return null; // a laptop: /mcp is open
  if (!auth) return deny("A valid access token is required.");
  const msgs = Array.isArray(body) ? body : [body];
  const needsUser = msgs.some((m) => m?.method === "tools/call" && USER_TOOLS.has(m.params?.name));
  if (needsUser && !auth.scope.split(" ").includes("mcp:tools")) return deny("Access token required to use this tool. Link your Money Guardian household first.");
  return null;
}
const deny = (message) => ({ status: 401, body: { error: "unauthorized", message } }); // no WWW-Authenticate: Alexa+ does not support it

// ---------- Refresh tokens: stored hashed, replaced on every use ----------

const storeFile = () => env("MG_OAUTH_STORE") || join(dirname(env("MG_LEDGER") || join(ROOT, "data", "ledger.json")), "oauth.json");
function loadStore() {
  try { return JSON.parse(readFileSync(storeFile(), "utf8")); } catch { return { refresh: {} }; }
}
function saveStore(s) {
  for (const [h, r] of Object.entries(s.refresh)) if (r.exp < Date.now()) delete s.refresh[h];
  mkdirSync(dirname(storeFile()), { recursive: true });
  const tmp = `${storeFile()}.tmp`;
  writeFileSync(tmp, JSON.stringify(s), { mode: 0o600 });
  renameSync(tmp, storeFile());
}
function newRefresh(entry) {
  const token = b64(randomBytes(32));
  const s = loadStore();
  s.refresh[sha256(token).toString("hex")] = { ...entry, exp: Date.now() + REFRESH_TTL_MS };
  saveStore(s);
  return token;
}
function useRefresh(token) {
  const s = loadStore();
  const h = sha256(String(token)).toString("hex");
  const r = s.refresh[h];
  if (!r) return null;
  delete s.refresh[h]; // single use
  saveStore(s);
  return r.exp > Date.now() ? r : null;
}

// ---------- Authorization codes (in memory, five minutes, single use) ----------

const codes = new Map();
function newCode(entry) {
  for (const [c, v] of codes) if (v.exp < Date.now()) codes.delete(c);
  const code = b64(randomBytes(32));
  codes.set(sha256(code).toString("hex"), { ...entry, exp: Date.now() + CODE_TTL_MS });
  return code;
}
function useCode(code) {
  const h = sha256(String(code)).toString("hex");
  const c = codes.get(h);
  codes.delete(h);
  return c && c.exp > Date.now() ? c : null;
}

// ---------- The sign-in page ----------

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const page = (inner) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer"><title>Link Money Guardian</title><style>
:root{--bg:#eef0f3;--card:#fff;--ink:#1d1f24;--muted:#5d6270;--ok:#1f6f5c;--line:#d6d9df;--bad:#a33a2a}
@media (prefers-color-scheme:dark){:root{--bg:#101317;--card:#1b1f26;--ink:#eceef2;--muted:#a3a9b6;--ok:#47b496;--line:#2c313b;--bad:#f07a66}}
body{margin:0;background:var(--bg);color:var(--ink);font:18px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;display:flex;justify-content:center;padding:24px 16px}
main{width:100%;max-width:440px;background:var(--card);border-radius:20px;padding:24px}h1{font-size:22px;margin:0 0 8px}p{margin:0 0 14px}
label{display:block;font-weight:600;margin:12px 0 6px}input{width:100%;box-sizing:border-box;font:inherit;font-size:22px;letter-spacing:.2em;padding:12px;border-radius:12px;border:1px solid var(--line);background:var(--bg);color:var(--ink)}
.row{display:flex;gap:10px;margin-top:16px}button{flex:1;font:inherit;font-weight:600;border:0;border-radius:12px;padding:14px;cursor:pointer}
.ok{background:var(--ok);color:#fff}.no{background:transparent;color:var(--ink);border:1px solid var(--line)}.muted{color:var(--muted);font-size:15px}.err{color:var(--bad);font-weight:600}
</style></head><body><main>${inner}</main></body></html>`;

function signInPage(form, error = "") {
  return page(`<h1>Link Money Guardian to Alexa</h1>
<p>Alexa will be able to read your household's bills, ask your trusted family member before money moves, and pay bills you approve.</p>
<p class="muted">Checking a seller, an offer, a product or a bank never needs this.</p>
<form method="post" action="/oauth/authorize">
<input type="hidden" name="req" value="${esc(form)}">
<label for="passcode">Household passcode</label>
<input id="passcode" name="passcode" type="password" inputmode="numeric" autocomplete="current-password" required autofocus>
${error ? `<p class="err" role="alert">${esc(error)}</p>` : ""}
<div class="row"><button class="ok" name="decision" value="allow">Link</button><button class="no" name="decision" value="deny" formnovalidate>Not now</button></div>
</form>`);
}
const errorPage = (msg) => page(`<h1>This link can't be used</h1><p>${esc(msg)}</p><p class="muted">Start again from the Alexa app.</p>`);

// Five wrong passcodes from one address lock it out for 15 minutes.
const failures = new Map();
const locked = (ip) => (failures.get(ip) || []).filter((t) => Date.now() - t < 15 * 60e3).length >= 5;
const fail = (ip) => { const l = (failures.get(ip) || []).filter((t) => Date.now() - t < 15 * 60e3); l.push(Date.now()); failures.set(ip, l); if (failures.size > 10_000) failures.clear(); };

const back = (redirectUri, params) => {
  const u = new URL(redirectUri);
  for (const [k, v] of Object.entries(params)) if (v != null) u.searchParams.set(k, v);
  return u.toString();
};

/**
 * GET /oauth/authorize: check what Alexa sent, then show the sign-in page.
 * Returns { status, html } or { redirect }.
 */
export function authorizeGet(q) {
  const p = Object.fromEntries(q);
  // Until the client and redirect URI are known good, never redirect anywhere: show an error.
  if (!same(p.client_id || "", env("MG_OAUTH_CLIENT_ID"))) return { status: 400, html: errorPage("Unknown app.") };
  if (!p.redirect_uri || !redirectAllowed(p.redirect_uri)) return { status: 400, html: errorPage("Unknown return address.") };
  const bad = (error, error_description) => ({ redirect: back(p.redirect_uri, { error, error_description, state: p.state }) });
  if (p.response_type !== "code") return bad("unsupported_response_type", "response_type must be code");
  if (p.code_challenge_method !== "S256" || !/^[A-Za-z0-9_-]{43}$/.test(p.code_challenge || "")) return bad("invalid_request", "PKCE with S256 is required");
  if (!sameResource(p.resource)) return bad("invalid_target", "resource must be this MCP server");
  const form = seal("form", { cid: p.client_id, ru: p.redirect_uri, st: p.state ?? null, cc: p.code_challenge, exp: Date.now() + FORM_TTL_MS });
  return { status: 200, html: signInPage(form) };
}

/** POST /oauth/authorize: the household's answer. */
export function authorizePost(fields, ip) {
  const f = unseal("form", fields.get("req"));
  if (!f || !(f.exp > Date.now()) || !redirectAllowed(f.ru)) return { status: 400, html: errorPage("This sign-in page has expired.") };
  if (fields.get("decision") === "deny") return { redirect: back(f.ru, { error: "access_denied", state: f.st }) };
  if (locked(ip)) return { status: 429, html: signInPage(fields.get("req"), "Too many tries. Please wait 15 minutes.") };
  if (!same(fields.get("passcode") || "", env("MG_HOUSEHOLD_PASSCODE"))) {
    fail(ip);
    return { status: 401, html: signInPage(fields.get("req"), "That passcode isn't right.") };
  }
  const code = newCode({ cid: f.cid, ru: f.ru, cc: f.cc, sub: "household", scope: "mcp:tools" });
  return { redirect: back(f.ru, { code, state: f.st }) };
}

// ---------- POST /oauth/token ----------

const tokenError = (status, error, error_description) => ({ status, body: { error, error_description } });

function clientFrom(header, fields) {
  const m = /^Basic ([A-Za-z0-9+/=]+)$/.exec(String(header || ""));
  if (m) {
    const raw = Buffer.from(m[1], "base64").toString("utf8");
    const i = raw.indexOf(":");
    if (i < 0) return { bad: true };
    return { id: decodeURIComponent(raw.slice(0, i)), secret: decodeURIComponent(raw.slice(i + 1)) };
  }
  return { id: fields.get("client_id"), secret: fields.get("client_secret") };
}

/** Returns { status, body } for the token endpoint. `query` must be empty: no credentials in URLs. */
export function token(header, fields, query) {
  if ([...query.keys()].length) return tokenError(400, "invalid_request", "send parameters in the request body, not the URL");
  const c = clientFrom(header, fields);
  if (c.bad || !same(c.id || "", env("MG_OAUTH_CLIENT_ID"))) return tokenError(401, "invalid_client", "unknown client");
  // A secret, when sent, must be right. Alexa+ always sends it for client_credentials; for the code
  // and refresh grants PKCE and the single-use, client-bound codes and refresh tokens protect the exchange.
  const authenticated = c.secret != null && same(c.secret, env("MG_OAUTH_CLIENT_SECRET"));
  if (c.secret != null && !authenticated) return tokenError(401, "invalid_client", "client authentication failed");

  const grant = fields.get("grant_type");
  if (grant === "client_credentials") {
    if (!authenticated) return tokenError(401, "invalid_client", "client authentication is required");
    if (!sameResource(fields.get("resource"))) return tokenError(400, "invalid_target", "resource must be this MCP server");
    const asked = (fields.get("scope") || "mcp:service").split(" ").filter(Boolean);
    if (asked.some((s) => s !== "mcp:service")) return tokenError(400, "invalid_scope", "client_credentials grants mcp:service only");
    return { status: 200, body: { access_token: accessToken({ sub: "alexa", scope: "mcp:service", cid: c.id }), token_type: "Bearer", expires_in: ACCESS_TTL, scope: "mcp:service" } };
  }
  if (grant === "authorization_code") {
    const code = useCode(fields.get("code"));
    if (!code || code.cid !== c.id) return tokenError(400, "invalid_grant", "unknown, used or expired code");
    if (fields.get("redirect_uri") !== code.ru) return tokenError(400, "invalid_grant", "redirect_uri does not match");
    const verifier = fields.get("code_verifier") || "";
    if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) || !same(b64(sha256(verifier)), code.cc)) return tokenError(400, "invalid_grant", "PKCE check failed");
    if (!sameResource(fields.get("resource"))) return tokenError(400, "invalid_target", "resource must be this MCP server");
    return issue(c.id, code.sub, code.scope);
  }
  if (grant === "refresh_token") {
    const r = useRefresh(fields.get("refresh_token"));
    if (!r || r.cid !== c.id) return tokenError(400, "invalid_grant", "unknown, used or expired refresh token");
    return issue(c.id, r.sub, r.scope);
  }
  return tokenError(400, "unsupported_grant_type", "use client_credentials, authorization_code or refresh_token");
}

function issue(cid, sub, scope) {
  return { status: 200, body: { access_token: accessToken({ sub, scope, cid }), token_type: "Bearer", expires_in: ACCESS_TTL, refresh_token: newRefresh({ cid, sub, scope }), scope } };
}
