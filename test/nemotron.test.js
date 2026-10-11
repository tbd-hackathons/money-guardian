// Nemotron mode, end to end, against a fake Token Factory on localhost: the real agent loop, real tool
// calls into our MCP server over HTTP, and the family brief. Only the models are fake.
//
// The ways this feature could fail, written down first. Each case below guards against one or more:
//   N1  Calls go to the wrong model, or without the key, so Token Factory refuses them.
//   N2  The tools are not in the OpenAI function format Token Factory expects, so the model can't call them.
//   N3  A tool result is not tied back to its call (tool_call_id), so the model loops or errors.
//   N4  The model's own words stand in for the tool's facts: the real tool never ran.
//   N5  What each model call cost is not reported, so nobody can see the bill.
//   N6  Markdown is read aloud: "asterisk asterisk careful".
//   N7  Tool arguments that don't parse crash the turn.
//   N8  Token Factory is down and Margaret gets no answer.
//   N9  One failed turn leaves broken history behind, so every later turn fails too.
//   N10 The request to Anna waits for the slow brief.
//   N11 The model's thinking is shown to Anna.
//   N12 The brief cites a source no tool found.
//   N13 The brief decides by itself: the request is no longer waiting for Anna.
//   N14 Calls go on after the day's token budget is spent, so the free credits run out before judging ends.
//   N15 Over the budget, Margaret gets no answer.
//   N16 Over the budget, the warnings check stops counting a regulator's warning.
//   N17 Over the budget, Anna's request waits for a brief that never comes.
//   N18 The budget never resets. Not tested here: it needs a clock. The count is kept per UTC date.
//
// It leaves test/artifacts/nemotron.json: every case, what it asked, what came back, and what the models received.
import assert from "node:assert/strict";
import { before, after } from "node:test";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createServer as netServer } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { e2eSuite } from "./artifact.js";

const e2e = e2eSuite("nemotron", "Nemotron 3.5 Lightning runs the voice turn and Nemotron 3 Ultra writes the family brief, through the real /api/chat endpoint and MCP server.");

const FAST = "nvidia/Nemotron-3_5-Lightning", DEEP = "nvidia/Nemotron-3-Ultra-550b-a55b";
const FINRA_RED_FLAGS = "https://www.finra.org/investors/protect-your-money/avoid-fraud/red-flags-fraud";
const FCA = "https://www.fca.org.uk/news/warnings/bramwell-kent-consultants-llc";

// ---------- The fake Token Factory ----------
// Lightning: calls check_pitch for an offer, request_family_approval for "tell Anna", then answers from the tool result.
// "break" in the user's words: the API fails. "markdown": a reply full of formatting. "badjson": tool arguments that don't parse.
const seen = [];
const lastUser = (msgs) => [...msgs].reverse().find((m) => m.role === "user")?.content || "";
const fake = createServer(async (req, res) => {
  let raw = "";
  for await (const c of req) raw += c;
  const body = JSON.parse(raw || "{}");
  // For the server that runs online: Tavily, TreasuryDirect, FINRA and FDIC, all fake.
  if (req.url.startsWith("/treasury")) return res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify([{ securityTerm: "4-Week", highInvestmentRate: "4.62", auctionDate: "2026-10-06T00:00:00" }]));
  if (req.url.startsWith("/finra/") || req.url.startsWith("/fdic")) return res.writeHead(404).end();
  if (req.url === "/tavily/search") {
    return res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ results: [
      { url: FCA, title: "Bramwell & Kent Consultants LLC | FCA", content: "Unauthorised firm - Bramwell & Kent Consultants LLC. This firm is not authorised by us." }] }));
  }
  seen.push({ headers: req.headers, body });
  const answer = (message, usage = { prompt_tokens: 1200, completion_tokens: 40 }) =>
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ id: `c${seen.length}`, model: body.model, choices: [{ index: 0, message: { role: "assistant", ...message }, finish_reason: message.tool_calls ? "tool_calls" : "stop" }], usage }));
  if (body.model === DEEP) {
    return answer({ content: `<think>Weigh the register result against the pitch.</think>${JSON.stringify({
      headline: "Say no to this investment offer", what_happened: "A caller promised Mom a guaranteed 18% a year.",
      checks: [{ fact: "A guaranteed return is a red flag of fraud.", source_url: FINRA_RED_FLAGS }, { fact: "Invented fact.", source_url: "https://evil.example/fake" }],
      assessment: "Several warning signs together.", suggestion: "say_no", suggestion_why: "Guarantees and secrecy are classic scam signs.", ask_mom: ["Did you send any money yet?"],
    })}` }, { prompt_tokens: 3000, completion_tokens: 500 });
  }
  const user = lastUser(body.messages);
  const last = body.messages.at(-1);
  if (/break/.test(user)) return res.writeHead(500, { "Content-Type": "application/json" }).end(JSON.stringify({ detail: "fake failure" }));
  if (last.role === "tool") {
    if (/markdown/.test(user)) return answer({ content: "**Careful!**\n\n- This sounds like a scam.\n- Please don't send money." });
    let said;
    try { said = JSON.parse(last.content).say; } catch { said = last.content; }
    return answer({ content: `Fake Nemotron on ${body.model} read: ${said}` });
  }
  const call = (name, args) => answer({ content: "", tool_calls: [{ id: `call_${seen.length}`, type: "function", function: { name, arguments: typeof args === "string" ? args : JSON.stringify(args) } }] });
  if (/badjson/.test(user)) return call("check_pitch", "{not json");
  if (/tell Anna/.test(user)) return call("request_family_approval", { subject_id: "offer-caller", summary: "Investment offer from a caller", reasons: ["A guaranteed return"] });
  return call("check_pitch", { pitch: user });
});

const freePort = () => new Promise((ok) => { const s = netServer().listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => ok(port)); }); });
const procs = [];
async function start(extra) {
  const port = await freePort();
  const env = { ...process.env, PORT: String(port), MG_LEDGER: join(mkdtempSync(join(tmpdir(), "mg-")), "l.json"), MG_OFFLINE: "1",
    NEBIUS_API_KEY: "nb-test-not-real", MG_NEBIUS_BASE_URL: `http://127.0.0.1:${fake.address().port}/v1` };
  for (const k of ["ANTHROPIC_API_KEY", "MG_BEDROCK_REGION", "MG_SES_REGION", "TAVILY_API_KEY", "MG_TAVILY", "MG_NEMOTRON_DAILY_TOKENS"]) delete env[k];
  const p = spawn(process.execPath, ["src/server.js"], { env: { ...env, ...extra }, stdio: ["ignore", "pipe", "pipe"] });
  procs.push(p);
  await new Promise((ok) => p.stdout.once("data", ok));
  return `http://127.0.0.1:${port}`;
}
let base;
before(async () => {
  await new Promise((ok) => fake.listen(0, "127.0.0.1", ok));
  base = await start({});
});
after(() => { procs.forEach((p) => p.kill()); fake.close(); });

const say = async (text, session_id, at = base) =>
  (await fetch(`${at}/api/chat`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ session_id, text }) })).json();
const briefFor = async (at, subject) => {
  let b;
  for (let i = 0; i < 50 && (!b || b.status === "writing"); i++) {
    b = (await (await fetch(`${at}/api/approvals`)).json()).find((a) => a.subject_id === subject)?.brief;
    if (!b || b.status === "writing") await new Promise((ok) => setTimeout(ok, 100));
  }
  return b;
};
// What each model call received, without the key itself.
const calls = () => seen.map(({ headers, body }) => ({ model: body.model, auth: headers.authorization ? "bearer key" : "none",
  tools: body.tools?.map((t) => t.function?.name) ?? null, last_message: body.messages.at(-1).role, json_mode: body.response_format?.type ?? null }));
const usage = (ai) => ai.map(({ job, label, input_tokens, output_tokens, error }) => ({ job, label, input_tokens, output_tokens, error }));

const PITCH = "A man says I'm guaranteed 18% a year, but only today.";

e2e("Lightning calls an MCP tool over Token Factory's OpenAI-style API and answers from its result", ["N1", "N2", "N3", "N4", "N5"], async (record) => {
  seen.length = 0;
  const r = await say(PITCH, "n1");
  const m = await (await fetch(`${base}/api/mode`)).json();
  record("reply", r.reply);
  record("tools_called", r.trace.map((x) => ({ tool: x.tool, risk: x.result.risk })));
  record("model_calls", calls());
  record("usage", usage(r.ai));
  record("mode", { mode: m.mode, ai: m.ai, models: m.models });
  assert.equal(r.mode, "nemotron");
  assert.match(r.reply, /^Fake Nemotron on nvidia\/Nemotron-3_5-Lightning read: This sounds like a scam/);
  assert.equal(r.trace[0].tool, "check_pitch");
  assert.equal(r.trace[0].result.risk, "high"); // the real tool ran
  const [first, second] = seen;
  assert.equal(first.body.model, FAST);
  assert.equal(first.headers.authorization, "Bearer nb-test-not-real");
  assert.equal(first.body.messages[0].role, "system");
  assert.equal(first.body.tools.length, 8); // no search service set up here, so no check_warnings
  assert.ok(!first.body.tools.some((t) => t.function.name === "check_warnings"));
  assert.equal(first.body.tools[0].type, "function");
  assert.ok(first.body.tools.every((t) => t.function.name && t.function.parameters?.type === "object"));
  assert.equal(second.body.messages.at(-1).role, "tool");
  assert.equal(second.body.messages.at(-1).tool_call_id, second.body.messages.at(-2).tool_calls[0].id);
  // What each model call cost is reported for the "Behind the scenes" sheet.
  assert.deepEqual(r.ai.map((a) => [a.label, a.input_tokens, a.output_tokens]), [["Nemotron 3.5 Lightning", 1200, 40], ["Nemotron 3.5 Lightning", 1200, 40]]);
  assert.equal(m.ai, "nebius");
  assert.equal(m.models.deep.model, DEEP);
});

e2e("a reply full of formatting is cleaned for the ear", ["N6"], async (record) => {
  const r = await say(`Please use markdown. ${PITCH}`, "n2");
  record("reply", r.reply);
  assert.equal(r.reply, "Careful! This sounds like a scam. Please don't send money.");
});

e2e("arguments that don't parse go back to the model as an error, not a crash", ["N7"], async (record) => {
  seen.length = 0;
  const r = await say(`badjson ${PITCH}`, "n3");
  record("mode", r.mode);
  record("tools_run", r.trace.length);
  record("model_got_back", seen[1]?.body.messages.at(-1).content);
  assert.equal(r.mode, "nemotron");
  assert.equal(r.trace.length, 0);
  assert.match(seen[1].body.messages.at(-1).content, /not valid JSON/);
});

e2e("when Token Factory fails, the scripted router still answers, and the next turn works", ["N8", "N9"], async (record) => {
  const r = await say(`This will break. ${PITCH}`, "n4");
  record("failed_turn", { mode: r.mode, reply: r.reply, usage: usage(r.ai) });
  assert.equal(r.mode, "scripted");
  assert.match(r.reply, /scam/);
  assert.ok(r.ai.some((a) => a.error));
  const again = await say(PITCH, "n4");
  record("next_turn", { mode: again.mode, reply: again.reply });
  assert.equal(again.mode, "nemotron");
});

e2e("Ultra writes the family a brief in the background, citing only sources the tools found", ["N10", "N11", "N12", "N13"], async (record) => {
  await say(PITCH, "n5");
  const asked = await say("Yes, tell Anna.", "n5");
  record("reply_to_tell_anna", asked.reply);
  assert.equal(asked.trace[0].tool, "request_family_approval");
  assert.match(asked.reply, /Nothing goes ahead until Anna answers/); // the request does not wait for the brief
  let brief;
  for (let i = 0; i < 50 && brief?.status !== "ready"; i++) {
    const list = await (await fetch(`${base}/api/approvals`)).json();
    brief = list.find((a) => a.subject_id === "offer-caller")?.brief;
    if (brief?.status !== "ready") await new Promise((ok) => setTimeout(ok, 100));
  }
  const ultra = seen.filter((s) => s.body.model === DEEP).at(-1);
  const list = await (await fetch(`${base}/api/approvals`)).json();
  const { status, headline, what_happened, checks, assessment, suggestion, suggestion_why, ask_mom, written_by, model, tokens } = brief || {};
  record("brief", { status, headline, what_happened, checks, assessment, suggestion, suggestion_why, ask_mom, written_by, model, tokens });
  record("ultra_request", ultra && { model: ultra.body.model, json_mode: ultra.body.response_format?.type, read_tools: /check_pitch/.test(ultra.body.messages[1].content) });
  record("request_status_after_brief", list.find((a) => a.subject_id === "offer-caller")?.status);
  assert.equal(brief.status, "ready");
  assert.equal(brief.written_by, "Nemotron 3 Ultra");
  assert.equal(brief.suggestion, "say_no");
  assert.equal(brief.headline, "Say no to this investment offer"); // the model's thinking is not shown
  assert.deepEqual(brief.checks.map((c) => c.source_url), [FINRA_RED_FLAGS, null]); // a source no tool found is dropped
  assert.equal(ultra.body.response_format.type, "json_object");
  assert.match(ultra.body.messages[1].content, /check_pitch/); // it read what the tools found
  // The brief advises only: the request is still waiting for Anna.
  assert.equal(list.find((a) => a.subject_id === "offer-caller").status, "pending");
});

e2e("over the day's token budget, Nemotron stops and every answer still comes", ["N14", "N15", "N16", "N17"], async (record) => {
  const f = `http://127.0.0.1:${fake.address().port}`;
  const capped = await start({ MG_NEMOTRON_DAILY_TOKENS: "2000", MG_TAVILY: "keyless", MG_TAVILY_URL: `${f}/tavily`, MG_OFFLINE: "0",
    MG_TREASURY_URL: `${f}/treasury`, MG_BROKERCHECK_URL: `${f}/finra`, MG_FDIC_URL: `${f}/fdic` });
  seen.length = 0;
  const first = await say(PITCH, "b1", capped); // two Lightning calls of 1,240 tokens each: the budget is spent
  const second = await say(PITCH, "b1", capped);
  const client = new Client({ name: "e2e", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${capped}/mcp`)));
  const warn = (await client.callTool({ name: "check_warnings", arguments: { name: "Bramwell & Kent Consultants" } })).structuredContent;
  await client.close();
  const asked = await say("Yes, tell Anna.", "b1", capped);
  const subject = asked.trace.find((x) => x.tool === "request_family_approval")?.args.subject_id;
  const brief = await briefFor(capped, subject);
  const m = await (await fetch(`${capped}/api/mode`)).json();
  record("first_turn", { mode: first.mode, usage: usage(first.ai) });
  record("second_turn", { mode: second.mode, reply: second.reply, usage: usage(second.ai) });
  record("warnings_check", { status: warn.status, read_by: warn.warnings.map((w) => w.checked_by), model_calls: warn.ai });
  record("brief", brief);
  record("budget", m.budget);
  record("model_calls_made", seen.length);
  assert.equal(first.mode, "nemotron");
  assert.equal(second.mode, "scripted");
  assert.match(second.reply, /scam/);
  assert.match(second.ai.find((a) => a.error).error, /budget/);
  assert.equal(warn.status, "warned"); // the regulator's page about this one firm still counts
  assert.deepEqual(warn.warnings.map((w) => w.checked_by), ["page address rule"]);
  assert.match(warn.ai[0].error, /budget/);
  assert.equal(asked.trace[0].tool, "request_family_approval");
  assert.equal(brief.status, "skipped");
  assert.match(brief.note, /budget/);
  assert.equal(seen.length, 2); // nothing reached Token Factory after the budget was spent
  assert.deepEqual(m.budget, { tokens_per_day: 2000, used_today: 2480 });
});
