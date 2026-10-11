// The family's case brief, written by Nemotron 3 Ultra.
//
// When Money Guardian asks Anna to approve something, her phone shows the request at once. Shortly after,
// it also shows a brief: what Mom was told, what was checked and where, what it means, and what to ask Mom.
// Ultra has time to reason here because nobody is waiting for a spoken reply. The brief advises; only
// Anna's button decides, and the server rules (hold, approve, pay once) do not depend on it.
//
// Ultra sees only what the tools found for this household in the last half hour, and every source it
// cites must be one of those tools' sources. Anything else is dropped before Anna sees it.

import { currentDemo } from "./demo.js";
import { complete, parseJson } from "./nemotron.js";
import { mentionsName } from "./sources.js";

const WINDOW_MS = 30 * 60 * 1000;
const KEEP = 12;
const EVIDENCE_TOOLS = new Set(["check_seller", "check_warnings", "check_pitch", "check_bank", "review_bills", "explain_product"]);
const evidence = new Map(); // household (demo id, or "" for the real one) -> [{ tool, args, facts, sources, at }]

function urlsIn(value, out = new Set()) {
  if (typeof value === "string") { if (/^https:\/\/\S+$/.test(value)) out.add(value); }
  else if (Array.isArray(value)) value.forEach((v) => urlsIn(v, out));
  else if (value && typeof value === "object") Object.values(value).forEach((v) => urlsIn(v, out));
  return out;
}

/** Keep what a tool found, briefly, for the brief that may follow. */
export function remember(tool, args, result) {
  if (!EVIDENCE_TOOLS.has(tool) || !result) return;
  const key = currentDemo() || "";
  const { say, more, status, risk, verdict, reasons, warnings, flags, claimed_rate_pct, amount_usd, usual_amount_usd } = result;
  const facts = { say, more, status, risk, verdict, reasons, claimed_rate_pct, amount_usd, usual_amount_usd,
    warnings: warnings?.map(({ regulator, title, date, quote, verdict: v }) => ({ regulator, title, date, quote, verdict: v })),
    flags: flags?.map((f) => f.label) };
  const list = (evidence.get(key) || []).filter((e) => Date.now() - e.at < WINDOW_MS);
  list.push({ tool, args, facts: JSON.parse(JSON.stringify(facts)), sources: [...urlsIn(result)].slice(0, 8), at: Date.now() });
  evidence.set(key, list.slice(-KEEP));
}

export const recentEvidence = () => (evidence.get(currentDemo() || "") || []).filter((e) => Date.now() - e.at < WINDOW_MS);

// Words that state what a check found: registration, or a regulator's warning or action. A reason with such
// words reaches Anna only if a tool said it. The checks' own findings about this seller are added in their words,
// so a warning reaches her even when the model leaves it out, and a finding about another firm never does.
const CLAIM = /\b(warn\w*|alerts?|regulators?|registered|unregistered|registration|licen[cs]ed|unlicen[cs]ed|authori[sz]ed|unauthori[sz]ed|charged|fined|barred|banned|convicted|sanction\w*|SEC|FINRA|FCA|FTC|CFTC|NFA|NASAA|IOSCO|ASIC|FBI|CFPB|BrokerCheck|CRD)\b/i;
const squash = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** The reasons for a request to Anna, checked against what the tools found for this household. */
export function checkReasons({ summary = "", subject_id = "", reasons = [] }) {
  const facts = recentEvidence();
  const about = `${summary} ${String(subject_id).replace(/[-_]+/g, " ")} ${reasons.join(" ")}`;
  const latest = (tool) => [...new Map(facts.filter((e) => e.tool === tool && e.args?.name && mentionsName(e.args.name, about)).map((e) => [squash(e.args.name), e])).values()];
  const found = [
    ...latest("check_seller").filter((e) => e.facts.status === "not_found").map((e) => `${e.args.name} is not registered to sell investments`),
    ...latest("check_warnings").filter((e) => e.facts.status === "warned" && e.facts.say).map((e) => e.facts.say.replace(/\.$/, "")),
  ];
  const said = new Set(facts.flatMap((e) => [e.facts.say, ...(e.facts.reasons || []), ...(e.facts.flags || [])]).filter(Boolean).map(squash));
  const kept = [], unbacked = [];
  for (const r of reasons) (CLAIM.test(r) && !said.has(squash(r)) ? unbacked : kept).push(r);
  const out = new Map([...found, ...kept].map((r) => [squash(r), r]));
  return { reasons: [...out.values()], unbacked };
}

const SYSTEM = `You write a short case brief for a grown child who must decide whether to approve a payment or an investment for an older parent.
The parent's voice assistant has already checked public records. You get the request and what the checks found.
Write for a busy, worried reader on a phone: plain English, short sentences, no jargon, no markdown.
Use only the facts you are given. Never invent a fact, a number, a name or a source. Cite a source only by copying one of the given source URLs.
You give information, not financial advice; the reader decides.
Answer with JSON only:
{"headline":"at most 12 words","what_happened":"one or two sentences","checks":[{"fact":"one sentence","source_url":"one of the given URLs, or null"}],
"assessment":"two or three sentences: what the facts mean together","suggestion":"say_no | call_first | approve","suggestion_why":"one sentence",
"ask_mom":["up to three short questions to ask the parent"]}`;

const clip = (s, n) => (typeof s === "string" ? s.replace(/\s+/g, " ").trim().slice(0, n) : "");

/** Ask Nemotron 3 Ultra for the brief. Throws if it fails or answers in the wrong shape. */
export async function writeBrief(approval, facts = recentEvidence()) {
  const allowed = new Set(facts.flatMap((f) => f.sources));
  const request = { summary: approval.summary, reasons: approval.reasons, amount_usd: approval.amount_usd, asked: approval.asked, relation: approval.relation };
  const r = await complete("deep", {
    messages: [
      { role: "system", content: SYSTEM },
      { role: "user", content: JSON.stringify({ request, checks: facts.map(({ tool, args, facts: f, sources }) => ({ tool, asked_with: args, found: f, sources })) }) },
    ],
    json: true, maxTokens: 6000, timeoutMs: Number(process.env.MG_BRIEF_TIMEOUT_MS || 90_000),
  });
  const b = parseJson(r.message.content);
  if (!b || typeof b.headline !== "string") throw new Error("Nemotron's brief was not the JSON we asked for");
  return {
    status: "ready",
    headline: clip(b.headline, 120),
    what_happened: clip(b.what_happened, 400),
    checks: (Array.isArray(b.checks) ? b.checks : []).slice(0, 6).map((c) => ({ fact: clip(c?.fact, 300), source_url: allowed.has(c?.source_url) ? c.source_url : null })).filter((c) => c.fact),
    assessment: clip(b.assessment, 600),
    suggestion: ["say_no", "call_first", "approve"].includes(b.suggestion) ? b.suggestion : "call_first",
    suggestion_why: clip(b.suggestion_why, 300),
    ask_mom: (Array.isArray(b.ask_mom) ? b.ask_mom : []).slice(0, 3).map((q) => clip(q, 200)).filter(Boolean),
    written_by: r.usage.label, model: r.usage.model, ms: r.usage.ms,
    tokens: (r.usage.input_tokens ?? 0) + (r.usage.output_tokens ?? 0) || null,
    written_at: new Date().toISOString(),
  };
}
