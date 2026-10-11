// Regulator warnings through Tavily, end to end: the real server, called over HTTP the way Claude or Alexa
// calls it (/mcp) and the way the simulator does (/api/chat). Only the outside services are fake, on
// localhost: Tavily, Token Factory, FINRA and TreasuryDirect.
//
// The ways this feature could fail, written down first. Each case below guards against one or more:
//   F1  The seller's name goes to Tavily although the household never turned the search on.
//   F2  The search is set up (with a key, or keyless) but the tool is not offered.
//   F3  A page that is not on a regulator's own site (a forum, a review site) is reported as a warning.
//   F4  A regulator's page that does not name this seller is reported.
//   F5  A list naming many firms counts as a warning about this one although nobody read it.
//   F6  The model calls a page a warning, but its proof is not on the page: an innocent firm is accused.
//   F7  The listed firm is missed because Margaret said "and" and the list writes "&".
//   F8  The key is not sent, or keyless mode sends no keyless header, so Tavily refuses every search.
//   F9  A repeat ask spends another search.
//   F10 No hits are spoken as if the seller were safe.
//   F11 An outage is spoken as "no warnings": a false all-clear.
//   F12 A failed search is cached, so the outage lasts six hours.
//   F13 The router hears only part of a name with "and" in it ("Kent Consultants") and checks the wrong firm.
//   F14 The warning is buried, the reply is too long to hear, or it never reaches Anna's request.
//
// It leaves test/artifacts/warnings.json: every case, what it asked, what came back, and what Tavily received.
import assert from "node:assert/strict";
import { before, after } from "node:test";
import { createServer } from "node:http";
import { createServer as netServer } from "node:net";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { e2eSuite } from "./artifact.js";

const e2e = e2eSuite("warnings", "Regulator warnings through Tavily, read by Nemotron 3 Super, over the real /mcp and /api/chat endpoints.");

const FCA = "https://www.fca.org.uk/news/warnings/bramwell-kent-consultants-llc";
const PAUSE_LIST = "https://www.sec.gov/enforcement-litigation/public-alerts-unregistered-soliciting-entities?page=2";
const FORUM = "https://scam-reviews.example/bramwell-kent";
const IOSCO = "https://www.iosco.org/i-scan?page=55";
const FILING = "https://www.sec.gov/Archives/edgar/data/1/0001/filing.htm";
const PAGES = {
  bramwell: [
    { url: FCA, title: "Bramwell & Kent Consultants LLC | FCA", content: "This firm is not authorised by us and is targeting people in the UK. Unauthorised firm - Bramwell & Kent Consultants LLC. Address: 745 7th Avenue, New York." },
    { url: PAUSE_LIST, title: "SEC.gov | Public Alert: Unregistered Soliciting Entities (PAUSE)", content: "| Brady & Bell Acquisition Ltd. | Unregistered Soliciting Entities | | Bramwell & Kent Consultants, LLC. | Unregistered Soliciting Entities |" },
    { url: FORUM, title: "Bramwell & Kent Consultants review", content: "Bramwell & Kent Consultants is a scam, says a forum." }, // not a regulator
    { url: IOSCO, title: "IOSCO", content: "Apel Investments (CLONE) | Ireland - Central Bank of Ireland" }, // the name is not on the page
  ],
  halvard: [
    { url: PAUSE_LIST, title: "SEC.gov | Public Alert: Unregistered Soliciting Entities (PAUSE)", content: "These are entities that falsely claim to be registered. | Halvard Crane Partners | Unregistered Soliciting Entities |" },
    { url: FILING, title: "Form S-4", content: "Halvard Crane Partners, a client of the registrant, signed the agreement." },
  ],
};

// ---------- The fake outside services ----------
const tavily = [];
let tavilyDown = false;
const fake = createServer(async (req, res) => {
  let raw = "";
  for await (const c of req) raw += c;
  const body = raw ? JSON.parse(raw) : {};
  const json = (code, v) => res.writeHead(code, { "Content-Type": "application/json" }).end(JSON.stringify(v));
  if (req.url === "/tavily/search") {
    tavily.push({ headers: req.headers, body });
    if (tavilyDown) return json(500, { detail: "fake outage" });
    const q = body.query.toLowerCase();
    const results = q.includes("bramwell") ? PAGES.bramwell : q.includes("halvard") ? PAGES.halvard : [];
    return json(200, { query: body.query, results: results.map((r, i) => ({ ...r, score: 0.9 - i / 10 })), images: [], answer: null, response_time: 0.1 });
  }
  if (req.url === "/nebius/chat/completions") {
    // Nemotron 3 Super, reading the pages: one honest warning, and one "action" whose quote is not on the page.
    const pages = JSON.parse(body.messages[1].content).pages;
    const verdicts = pages.map((p) => p.url === PAUSE_LIST
      ? { id: p.id, verdict: "warning", about: "Halvard Crane Partners", date: "2019-07-25", quote: "These are entities that falsely claim to be registered." }
      : { id: p.id, verdict: "action", about: "Halvard Crane Partners", date: null, quote: "charged with fraud by the SEC" });
    return json(200, { choices: [{ message: { role: "assistant", content: JSON.stringify({ pages: verdicts }) }, finish_reason: "stop" }], usage: { prompt_tokens: 900, completion_tokens: 80 }, model: body.model });
  }
  if (req.url.startsWith("/finra/")) return json(200, { hits: { hits: [] } });
  if (req.url.startsWith("/treasury")) return json(200, [{ securityTerm: "4-Week", highInvestmentRate: "4.62", auctionDate: "2026-10-06T00:00:00" }]);
  json(404, {});
});

// ---------- Three servers: search off, search with a key, search keyless with Nemotron ----------
const freePort = () => new Promise((ok) => { const s = netServer().listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => ok(port)); }); });
const procs = [];
async function start(extra) {
  const port = await freePort();
  const f = `http://127.0.0.1:${fake.address().port}`;
  const env = { ...process.env, PORT: String(port), MG_LEDGER: join(mkdtempSync(join(tmpdir(), "mg-")), "l.json"),
    MG_TAVILY_URL: `${f}/tavily`, MG_NEBIUS_BASE_URL: `${f}/nebius`, MG_BROKERCHECK_URL: `${f}/finra`, MG_TREASURY_URL: `${f}/treasury`, MG_FDIC_URL: `${f}/fdic`,
    MG_SEC_INDEX: fileURLToPath(new URL("../fixtures/sec-iapd-sample.tsv.gz", import.meta.url)) };
  for (const k of ["TAVILY_API_KEY", "MG_TAVILY", "NEBIUS_API_KEY", "ANTHROPIC_API_KEY", "MG_BEDROCK_REGION", "MG_SES_REGION", "MG_OFFLINE"]) delete env[k];
  const p = spawn(process.execPath, ["src/server.js"], { env: { ...env, ...extra }, stdio: ["ignore", "pipe", "pipe"] });
  procs.push(p);
  await new Promise((ok) => p.stdout.once("data", ok));
  return `http://127.0.0.1:${port}`;
}

let off, keyed, keyless;
before(async () => {
  await new Promise((ok) => fake.listen(0, "127.0.0.1", ok));
  off = await start({});
  keyed = await start({ TAVILY_API_KEY: "tvly-test-not-real" });
  keyless = await start({ MG_TAVILY: "keyless", NEBIUS_API_KEY: "nb-test-not-real" });
});
after(() => { procs.forEach((p) => p.kill()); fake.close(); });

// ---------- Talking to a server the way its clients do ----------
async function mcp(base, fn) {
  const client = new Client({ name: "e2e", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
  try { return await fn(client); } finally { await client.close(); }
}
const toolNames = (base) => mcp(base, async (c) => (await c.listTools()).tools.map((t) => t.name).sort());
const checkWarnings = (base, name) => mcp(base, async (c) => (await c.callTool({ name: "check_warnings", arguments: { name } })).structuredContent);
const chat = async (base, session_id, text) =>
  (await fetch(`${base}/api/chat`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ session_id, text }) })).json();

const STORY = "A man from Bramwell and Kent Consultants called me. He says I'm guaranteed 18% a year, but only today, and I should keep it between us.";
// What reached Tavily, without the key itself.
const sent = () => tavily.map((c) => ({ query: c.body.query, exact_match: c.body.exact_match, sites: c.body.include_domains?.length,
  auth: c.headers.authorization ? "bearer key" : c.headers["x-tavily-access-mode"] || "none" })).sort((a, b) => a.query.localeCompare(b.query));
const pages = (list) => list.map(({ url, regulator, verdict, checked_by, date, quote, note }) => ({ url, regulator, verdict, checked_by, date, quote, note }));

e2e("with search turned off, the tool is not offered and no name leaves the machine", ["F1"], async (record) => {
  tavily.length = 0;
  const names = await toolNames(off);
  const r = await chat(off, "off1", STORY);
  record("tools_offered", names);
  record("reply", r.reply);
  record("tools_called", r.trace.map((x) => x.tool));
  record("sent_to_tavily", sent());
  assert.ok(!names.includes("check_warnings"));
  assert.ok(!r.trace.some((x) => x.tool === "check_warnings"));
  assert.equal(tavily.length, 0);
  assert.doesNotMatch(r.reply, /warned/);
});

e2e("with a key or in keyless mode, the tool is offered", ["F2"], async (record) => {
  const withKey = (await toolNames(keyed)).includes("check_warnings");
  const withoutKey = (await toolNames(keyless)).includes("check_warnings");
  record("offered", { with_key: withKey, keyless: withoutKey });
  assert.ok(withKey);
  assert.ok(withoutKey);
});

e2e("without Nemotron, only a regulator's page about that one firm counts as a warning", ["F3", "F4", "F5", "F7", "F8"], async (record) => {
  tavily.length = 0;
  const r = await checkWarnings(keyed, "Bramwell and Kent Consultants");
  record("status", r.status);
  record("say", r.say);
  record("warnings", pages(r.warnings));
  record("mentions", pages(r.mentions));
  record("sent_to_tavily", sent());
  assert.equal(r.status, "warned");
  assert.deepEqual(r.warnings.map((w) => [w.url, w.regulator, w.checked_by]), [[FCA, "the UK's FCA", "page address rule"]]);
  assert.deepEqual(r.mentions.map((m) => m.url), [PAUSE_LIST]); // on the list, but nobody read it, so it is only a mention
  const reported = [...r.warnings, ...r.mentions].map((p) => p.url);
  assert.ok(!reported.includes(FORUM) && !reported.includes(IOSCO)); // not a regulator; the name is not on the page
  assert.equal(r.say, "The UK's FCA has warned the public about Bramwell and Kent Consultants.");
  // People say "and"; the warning lists write "&". Both are searched, on regulators' sites only, with the key.
  assert.deepEqual(sent(), [
    { query: '"Bramwell & Kent Consultants"', exact_match: true, sites: 22, auth: "bearer key" },
    { query: '"Bramwell and Kent Consultants"', exact_match: true, sites: 22, auth: "bearer key" },
  ]);
  assert.ok(tavily.every((c) => c.body.include_domains.includes("sec.gov") && c.body.include_domains.includes("fca.org.uk")));
});

e2e("a repeat ask is answered from the cache, without another search", ["F9"], async (record) => {
  tavily.length = 0;
  const r = await checkWarnings(keyed, "Bramwell and Kent Consultants");
  record("status", r.status);
  record("cached", r.cached);
  record("sent_to_tavily", sent());
  assert.equal(r.status, "warned");
  assert.equal(r.cached, true);
  assert.equal(tavily.length, 0);
});

e2e("Nemotron reads the pages, and a verdict counts only if its quote is on the page", ["F6", "F8"], async (record) => {
  tavily.length = 0;
  const r = await checkWarnings(keyless, "Halvard Crane Partners");
  record("status", r.status);
  record("say", r.say);
  record("warnings", pages(r.warnings));
  record("mentions", pages(r.mentions));
  record("model_calls", r.ai.map(({ job, model, label, input_tokens, output_tokens }) => ({ job, model, label, input_tokens, output_tokens })));
  record("sent_to_tavily", sent());
  assert.equal(r.status, "warned");
  assert.deepEqual(r.warnings.map((w) => [w.url, w.verdict, w.checked_by, w.date]), [[PAUSE_LIST, "warning", "Nemotron 3 Super", "2019-07-25"]]);
  // The "action" verdict quoted words that are not on the filing: it is demoted, never spoken.
  assert.deepEqual(r.mentions.map((m) => m.url), [FILING]);
  assert.match(r.mentions[0].note, /quote was not on the page/);
  assert.equal(r.say, "The SEC has warned the public about Halvard Crane Partners.");
  assert.equal(r.ai[0].model, "nvidia/nemotron-3-super-120b-a12b");
  assert.ok(tavily.length > 0 && tavily.every((c) => c.headers["x-tavily-access-mode"] === "keyless" && !c.headers.authorization));
});

e2e("no hits are said carefully, and an outage is never a clean result", ["F10", "F11", "F12"], async (record) => {
  const none = await checkWarnings(keyed, "Victor Langston");
  record("no_hits", { status: none.status, say: none.say });
  assert.equal(none.status, "none_found");
  assert.match(none.say, /found no regulator warning about Victor Langston\. That alone doesn't make them safe/);
  tavilyDown = true;
  try {
    const down = await checkWarnings(keyed, "Rex Halvorsen");
    record("outage", { status: down.status, say: down.say, more: down.more });
    assert.equal(down.status, "unreadable");
    assert.match(down.say, /couldn't search/);
    assert.doesNotMatch(down.say + down.more, /no regulator warning|found no/i);
  } finally {
    tavilyDown = false;
  }
  // A failed search is not cached: the next ask tries again.
  const again = await checkWarnings(keyed, "Rex Halvorsen");
  record("after_outage", { status: again.status, cached: !!again.cached });
  assert.equal(again.status, "none_found");
});

e2e("scripted: a firm name with 'and' is heard whole, and the warning leads the reply", ["F13", "F14"], async (record) => {
  const r = await chat(keyed, "w1", STORY);
  record("mode", r.mode);
  record("reply", r.reply);
  record("words", r.reply.split(/\s+/).length);
  record("tools_called", r.trace.map((x) => ({ tool: x.tool, name: x.args.name ?? null })));
  assert.equal(r.mode, "scripted");
  assert.deepEqual(r.trace.map((x) => [x.tool, x.args.name]).filter((x) => x[1]).sort(), [["check_seller", "Bramwell and Kent Consultants"], ["check_warnings", "Bramwell and Kent Consultants"]]);
  assert.match(r.reply, /^Bramwell and Kent Consultants is not registered to sell investments, and the UK's FCA has warned the public about them\. This sounds like a scam: .*\. Please don't send money\. Shall I tell Anna\?$/);
  assert.ok(r.reply.split(/\s+/).length <= 45, r.reply);
  const asked = await chat(keyed, "w1", "Yes, tell Anna.");
  record("anna_asked_with", asked.trace[0]?.args.reasons);
  assert.equal(asked.trace[0].tool, "request_family_approval");
  assert.ok(asked.trace[0].args.reasons.includes("The UK's FCA has warned the public about Bramwell and Kent Consultants"));
});
