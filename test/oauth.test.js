// OAuth 2.1 as Alexa+ uses it: a service token (client_credentials) for discovery and the public
// checks, account linking (authorization_code + PKCE S256) for the household's own tools.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLIENT = "alexa-test-client", SECRET = "test-only-client-secret", PASSCODE = "4821";
const REDIRECT = "https://alexa.amazon.example/api/skill/link/TEST1", OTHER_REDIRECT = "https://pitangui.amazon.example/api/skill/link/TEST1";
let proc, base, RESOURCE;

before(async () => {
  const port = 9500 + Math.floor(Math.random() * 100);
  base = `http://127.0.0.1:${port}`;
  RESOURCE = `${base}/mcp`;
  const env = {
    ...process.env, PORT: String(port), MG_LEDGER: join(mkdtempSync(join(tmpdir(), "mg-")), "l.json"), MG_OFFLINE: "1",
    MG_PUBLIC_URL: base, MG_LINK_SECRET: "test-only-link-secret", MG_OAUTH_CLIENT_ID: CLIENT, MG_OAUTH_CLIENT_SECRET: SECRET,
    MG_OAUTH_REDIRECT_URIS: `${REDIRECT}, ${OTHER_REDIRECT}`, MG_HOUSEHOLD_PASSCODE: PASSCODE,
  };
  for (const k of ["ANTHROPIC_API_KEY", "MG_BEDROCK_REGION", "MG_SES_REGION"]) delete env[k];
  proc = spawn(process.execPath, ["src/server.js"], { env, stdio: ["ignore", "pipe", "pipe"] });
  await new Promise((ok) => proc.stdout.once("data", ok));
});
after(() => proc.kill());

const basic = (id = CLIENT, secret = SECRET) => `Basic ${Buffer.from(`${encodeURIComponent(id)}:${encodeURIComponent(secret)}`).toString("base64")}`;
const form = (o) => new URLSearchParams(o).toString();
async function tokenReq(fields, { auth = basic(), query = "" } = {}) {
  const r = await fetch(`${base}/oauth/token${query}`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", ...(auth ? { Authorization: auth } : {}) }, body: form(fields) });
  return { status: r.status, body: await r.json(), headers: r.headers };
}
const serviceToken = async () => (await tokenReq({ grant_type: "client_credentials", scope: "mcp:service", resource: RESOURCE })).body.access_token;
async function mcp(message, bearer) {
  const r = await fetch(`${base}/mcp`, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, ...message }) });
  const text = await r.text();
  return { status: r.status, body: text ? JSON.parse(text) : null, headers: r.headers };
}
const call = (name, args, bearer) => mcp({ method: "tools/call", params: { name, arguments: args } }, bearer);

// Account linking as Alexa does it: PKCE verifier, sign-in page, code, token exchange.
async function link({ passcode = PASSCODE, redirect = REDIRECT } = {}) {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const q = new URLSearchParams({ client_id: CLIENT, redirect_uri: redirect, response_type: "code", scope: "mcp:tools", state: "st4te", code_challenge: challenge, code_challenge_method: "S256", resource: RESOURCE });
  const pageRes = await fetch(`${base}/oauth/authorize?${q}`);
  const html = await pageRes.text();
  const req = html.match(/name="req" value="([^"]+)"/)[1];
  const answer = await fetch(`${base}/oauth/authorize`, { method: "POST", redirect: "manual", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: form({ req, passcode, decision: "allow" }) });
  return { verifier, pageRes, answer, location: answer.headers.get("location") };
}

test("discovery: the protected-resource and authorization-server documents say what Alexa+ checks", async () => {
  const prm = await (await fetch(`${base}/.well-known/oauth-protected-resource`)).json();
  assert.equal(prm.resource, RESOURCE);
  assert.deepEqual(prm.authorization_servers, [base]);
  const as = await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json();
  assert.deepEqual(as.code_challenge_methods_supported, ["S256"]);
  for (const g of ["client_credentials", "authorization_code", "refresh_token"]) assert.ok(as.grant_types_supported.includes(g));
  assert.equal(as.token_endpoint, `${base}/oauth/token`);
});

test("no token: 401 with a JSON body and no WWW-Authenticate header", async () => {
  const r = await mcp({ method: "tools/list" });
  assert.equal(r.status, 401);
  assert.equal(r.body.error, "unauthorized");
  assert.equal(r.headers.get("www-authenticate"), null);
  assert.equal((await mcp({ method: "tools/list" }, "forged.token")).status, 401);
});

test("client_credentials: mcp:service only, one hour at most, no refresh token, strict client checks", async () => {
  const ok = await tokenReq({ grant_type: "client_credentials", scope: "mcp:service", resource: RESOURCE });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.token_type, "Bearer");
  assert.equal(ok.body.scope, "mcp:service");
  assert.ok(ok.body.expires_in <= 3600);
  assert.equal(ok.body.refresh_token, undefined);
  assert.equal(ok.headers.get("cache-control"), "no-store");
  assert.equal((await tokenReq({ grant_type: "client_credentials", resource: RESOURCE }, { auth: basic(CLIENT, "wrong") })).body.error, "invalid_client");
  assert.equal((await tokenReq({ grant_type: "client_credentials", resource: RESOURCE }, { auth: null })).status, 401);
  assert.equal((await tokenReq({ grant_type: "client_credentials", scope: "mcp:tools", resource: RESOURCE })).body.error, "invalid_scope");
  assert.equal((await tokenReq({ grant_type: "client_credentials", scope: "mcp:service" })).body.error, "invalid_target");
  assert.equal((await tokenReq({ grant_type: "client_credentials", resource: "https://evil.example/mcp" })).body.error, "invalid_target");
  assert.equal((await tokenReq({ grant_type: "client_credentials", resource: RESOURCE }, { query: `?client_secret=${SECRET}` })).body.error, "invalid_request");
});

test("a service token lists tools and runs the public checks, but a household tool asks for linking", async () => {
  const t = await serviceToken();
  assert.equal((await mcp({ method: "tools/list" }, t)).body.result.tools.length, 8);
  const pitch = await call("check_pitch", { pitch: "guaranteed 18% a year, only today" }, t);
  assert.equal(pitch.status, 200);
  assert.equal(pitch.body.result.structuredContent.risk, "high");
  const bills = await call("review_bills", {}, t);
  assert.equal(bills.status, 401); // Alexa+ starts account linking on this
  assert.match(bills.body.message, /Access token required/);
  assert.equal(bills.headers.get("www-authenticate"), null);
});

test("account linking: passcode, code, PKCE, then the household's own tools work", async () => {
  const { pageRes, location, verifier } = await link();
  assert.equal(pageRes.headers.get("x-frame-options"), "DENY");
  // Browsers apply form-action to the redirect after the post: Alexa's addresses must be allowed.
  const csp = pageRes.headers.get("content-security-policy");
  for (const u of [REDIRECT, OTHER_REDIRECT]) assert.ok(csp.split(";").find((d) => d.trim().startsWith("form-action")).includes(new URL(u).origin), csp);
  const back = new URL(location);
  assert.equal(`${back.origin}${back.pathname}`, REDIRECT);
  assert.equal(back.searchParams.get("state"), "st4te");
  const code = back.searchParams.get("code");

  // Wrong verifier: refused, and the code is spent.
  const wrong = await tokenReq({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id: CLIENT, code_verifier: randomBytes(32).toString("base64url"), resource: RESOURCE });
  assert.equal(wrong.body.error, "invalid_grant");

  const again = await link();
  const code2 = new URL(again.location).searchParams.get("code");
  const t = await tokenReq({ grant_type: "authorization_code", code: code2, redirect_uri: REDIRECT, client_id: CLIENT, code_verifier: again.verifier, resource: RESOURCE });
  assert.equal(t.status, 200);
  assert.equal(t.body.scope, "mcp:tools");
  assert.ok(t.body.refresh_token, "a refresh token with every access token");
  assert.ok(t.body.expires_in <= 3600);
  const reuse = await tokenReq({ grant_type: "authorization_code", code: code2, redirect_uri: REDIRECT, client_id: CLIENT, code_verifier: again.verifier, resource: RESOURCE });
  assert.equal(reuse.body.error, "invalid_grant", "a code works once");

  const bills = await call("review_bills", {}, t.body.access_token);
  assert.equal(bills.status, 200);
  assert.match(bills.body.result.structuredContent.say, /Ohio Power/);

  // Refresh: a new pair; the old refresh token is spent.
  const r1 = await tokenReq({ grant_type: "refresh_token", refresh_token: t.body.refresh_token });
  assert.equal(r1.status, 200);
  assert.ok(r1.body.refresh_token && r1.body.refresh_token !== t.body.refresh_token);
  assert.equal((await tokenReq({ grant_type: "refresh_token", refresh_token: t.body.refresh_token })).body.error, "invalid_grant");
  assert.equal((await call("review_bills", {}, r1.body.access_token)).status, 200);
});

test("the sign-in page never sends anyone to an unregistered address, and 'Not now' is honoured", async () => {
  const q = (o) => new URLSearchParams({ client_id: CLIENT, redirect_uri: REDIRECT, response_type: "code", state: "s", code_challenge: "a".repeat(43), code_challenge_method: "S256", resource: RESOURCE, ...o });
  const evil = await fetch(`${base}/oauth/authorize?${q({ redirect_uri: "https://evil.example/cb" })}`, { redirect: "manual" });
  assert.equal(evil.status, 400);
  assert.equal(evil.headers.get("location"), null);
  assert.equal((await fetch(`${base}/oauth/authorize?${q({ client_id: "someone-else" })}`, { redirect: "manual" })).status, 400);
  const plain = await fetch(`${base}/oauth/authorize?${q({ code_challenge_method: "plain" })}`, { redirect: "manual" });
  assert.match(plain.headers.get("location"), /error=invalid_request/);
  // The other registered Alexa region works too: the exact redirect_uri sent is used.
  const other = await link({ redirect: OTHER_REDIRECT });
  assert.ok(other.location.startsWith(`${OTHER_REDIRECT}?`));

  const html = await (await fetch(`${base}/oauth/authorize?${q({})}`)).text();
  const req = html.match(/name="req" value="([^"]+)"/)[1];
  const no = await fetch(`${base}/oauth/authorize`, { method: "POST", redirect: "manual", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: form({ req, decision: "deny" }) });
  assert.match(no.headers.get("location"), /error=access_denied&state=s/);
  // A tampered form is refused.
  const tampered = req.slice(0, -2) + (req.endsWith("AA") ? "BB" : "AA");
  assert.equal((await fetch(`${base}/oauth/authorize`, { method: "POST", redirect: "manual", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: form({ req: tampered, passcode: PASSCODE, decision: "allow" }) })).status, 400);
});

test("five wrong passcodes lock the address out, even with the right one after", async () => {
  for (let i = 0; i < 5; i++) assert.equal((await link({ passcode: "0000" })).answer.status, 401);
  const r = await link();
  assert.equal(r.answer.status, 429);
  assert.equal(r.location, null);
});

test("the simulator on the same server still works with OAuth on", async () => {
  const r = await (await fetch(`${base}/api/chat`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ session_id: "o1", text: "What bills do I have?" }) })).json();
  assert.match(r.reply, /Ohio Power/);
});
