// Claude mode, end to end, against a fake Messages API on localhost: the real agent loop, the real
// Bedrock and Claude API clients, and real tool calls into our MCP server. Only the model is fake.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ---------- The fake API ----------
// "refuse" in the user's words: the main model declines, any other model answers.
// "break" in the user's words: the API fails.

const seen = [];
const fake = createServer(async (req, res) => {
  let raw = "";
  for await (const c of req) raw += c;
  const body = JSON.parse(raw || "{}");
  seen.push({ path: req.url, headers: req.headers, body });
  const last = body.messages.at(-1);
  const firstText = typeof body.messages[0].content === "string" ? body.messages[0].content : "";
  const msg = (content, stop_reason, extra = {}) => res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({
    id: `msg_${seen.length}`, type: "message", role: "assistant", model: body.model, content, stop_reason, stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 5 }, ...extra,
  }));
  if (/break/.test(firstText)) return res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "fake failure" } }));
  if (/refuse/.test(firstText) && body.model.endsWith("claude-opus-5-5")) {
    return msg([], "refusal", { stop_details: { type: "refusal", category: null, explanation: "fake decline", fallback_credit_token: null, fallback_has_prefill_claim: false } });
  }
  if (Array.isArray(last.content) && last.content[0]?.type === "tool_result") {
    return msg([{ type: "text", text: `Fake Claude on ${body.model} read the tool result.` }], "end_turn");
  }
  return msg([{ type: "tool_use", id: "toolu_1", name: "check_pitch", input: { pitch: firstText } }], "tool_use");
});

// ---------- Two Money Guardian servers: one on Bedrock, one on the Claude API ----------

const procs = [];
let FAKE;
async function start(port, extraEnv) {
  const env = { ...process.env, PORT: String(port), MG_LEDGER: join(mkdtempSync(join(tmpdir(), "mg-")), "l.json"), MG_OFFLINE: "1", MG_AI_BASE_URL: FAKE, ...extraEnv };
  if (!extraEnv.ANTHROPIC_API_KEY) delete env.ANTHROPIC_API_KEY;
  if (!extraEnv.MG_BEDROCK_REGION) delete env.MG_BEDROCK_REGION;
  const p = spawn(process.execPath, ["src/server.js"], { env, stdio: ["ignore", "pipe", "pipe"] });
  procs.push(p);
  await new Promise((ok) => p.stdout.once("data", ok));
  return `http://127.0.0.1:${port}`;
}
let bedrock, claudeApi;
before(async () => {
  await new Promise((ok) => fake.listen(0, "127.0.0.1", ok));
  FAKE = `http://127.0.0.1:${fake.address().port}`;
  const base = 9200 + Math.floor(Math.random() * 100);
  bedrock = await start(base, { MG_BEDROCK_REGION: "us-east-1", MG_AI_SKIP_AUTH: "1" });
  claudeApi = await start(base + 1, { ANTHROPIC_API_KEY: "test-key-not-real" });
});
after(() => { procs.forEach((p) => p.kill()); fake.close(); });

const say = async (base, text, session_id) =>
  (await fetch(`${base}/api/chat`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ session_id, text }) })).json();

const PITCH = "A man says I'm guaranteed 18% a year, but only today.";

test("Bedrock: Claude calls an MCP tool and answers from its result", async () => {
  seen.length = 0;
  const r = await say(bedrock, PITCH, "b1");
  assert.equal(r.mode, "claude");
  assert.equal(r.reply, "Fake Claude on anthropic.claude-opus-5-5 read the tool result.");
  assert.equal(r.trace[0].tool, "check_pitch");
  assert.equal(r.trace[0].result.risk, "high"); // the real tool ran
  const [first, second] = seen;
  assert.equal(first.body.model, "anthropic.claude-opus-5-5");
  assert.equal(first.body.tools.length, 8);
  assert.equal(first.body.fallbacks, undefined); // not on Bedrock: the middleware does it
  assert.equal(second.body.messages.at(-1).content[0].tool_use_id, "toolu_1");
  assert.equal((await (await fetch(`${bedrock}/healthz`)).json()).ai, "bedrock");
});

test("Bedrock: a declined request is answered by the fallback model", async () => {
  seen.length = 0;
  const r = await say(bedrock, `Please refuse this. ${PITCH}`, "b2");
  assert.match(r.reply, /anthropic\.claude-opus-4-8/);
  assert.equal(seen[0].body.model, "anthropic.claude-opus-5-5");
  assert.ok(seen.some((x) => x.body.model === "anthropic.claude-opus-4-8"));
});

test("Claude API: server-side fallback is requested, and the loop works", async () => {
  seen.length = 0;
  const r = await say(claudeApi, PITCH, "c1");
  assert.equal(r.reply, "Fake Claude on claude-opus-5-5 read the tool result.");
  assert.equal(seen[0].body.model, "claude-opus-5-5");
  assert.equal(seen[0].body.fallbacks, "default");
  assert.match(seen[0].headers["anthropic-beta"], /server-side-fallback-2026-07-01/);
});

test("when the AI fails, the scripted router still answers, and the next turn works", async () => {
  const r = await say(bedrock, `This will break. ${PITCH}`, "b3");
  assert.equal(r.mode, "scripted");
  assert.match(r.reply, /scam/);
  const again = await say(bedrock, PITCH, "b3");
  assert.equal(again.mode, "claude");
});
