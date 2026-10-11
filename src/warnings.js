// Regulator warnings, searched through Tavily. The registers say who is licensed to sell investments;
// this says who regulators have publicly warned about: the SEC's list of unregistered soliciting firms
// (PAUSE), the UK FCA's warning list, state securities regulators, IOSCO's alerts from regulators
// worldwide, and enforcement actions.
//
// Web search is loose too, so three gates stand between a search hit and "regulators warn about them":
//   1. the page is on a regulator's own site (Tavily's include_domains, checked again here);
//   2. every word of the name heard is on the page, the same rule as the registers;
//   3. Nemotron 3 Super reads the page and says whether it warns about this exact seller, and the words
//      it quotes as proof must really be on the page. Without Nemotron, only a regulator's page about
//      that one firm (its address names the firm) counts.
// If Tavily can't be reached, the answer is "I couldn't search", never "no warnings".
//
// Opt-in, because the seller's name goes to a third-party search service: set TAVILY_API_KEY, or
// MG_TAVILY=keyless for Tavily's free keyless mode (rate-limited). MG_TAVILY_URL exists for the tests.

import { mentionsName } from "./sources.js";
import { complete, nemotronEnabled, parseJson } from "./nemotron.js";

export const warningsEnabled = () => !!(process.env.TAVILY_API_KEY || process.env.MG_TAVILY === "keyless");

// Official sites only. The spoken name is how Margaret would hear it.
export const REGULATORS = [
  ["sec.gov", "the SEC"], ["investor.gov", "the SEC"], ["finra.org", "FINRA"], ["cftc.gov", "the CFTC"],
  ["nfa.futures.org", "the NFA"], ["nasaa.org", "the state securities regulators"], ["consumer.ftc.gov", "the FTC"], ["ftc.gov", "the FTC"],
  ["consumerfinance.gov", "the CFPB"], ["justice.gov", "the Justice Department"], ["fbi.gov", "the FBI"], ["ic3.gov", "the FBI"],
  ["com.ohio.gov", "Ohio's securities regulator"], ["dfpi.ca.gov", "California's financial regulator"], ["ssb.texas.gov", "Texas's securities board"],
  ["flofr.gov", "Florida's financial regulator"], ["fca.org.uk", "the UK's FCA"], ["iosco.org", "IOSCO"], ["asic.gov.au", "Australia's ASIC"],
  ["moneysmart.gov.au", "Australia's ASIC"], ["securities-administrators.ca", "Canada's securities regulators"], ["osc.ca", "Ontario's securities regulator"],
].map(([domain, name]) => ({ domain, name }));

export function regulatorOf(url) {
  let host;
  try { host = new URL(url).hostname.replace(/^www\./, ""); } catch { return null; }
  return REGULATORS.filter((r) => host === r.domain || host.endsWith(`.${r.domain}`)).sort((a, b) => b.domain.length - a.domain.length)[0] || null;
}

// A regulator's page about one firm: its address names the firm. These count even without Nemotron.
const ONE_FIRM_PAGES = [
  /^https:\/\/www\.sec\.gov\/enforcement-litigation\/public-alerts-unregistered-soliciting-entities\/([a-z0-9-]+)$/,
  /^https:\/\/www\.fca\.org\.uk\/news\/warnings\/([a-z0-9-]+)$/,
];
function onePageFor(name, url) {
  const slug = ONE_FIRM_PAGES.map((re) => url.match(re)?.[1]).find(Boolean);
  return !!slug && mentionsName(name, slug.replace(/-/g, " "));
}

const TAVILY = () => process.env.MG_TAVILY_URL || "https://api.tavily.com";
const TTL_MS = 6 * 3600e3; // warning lists change slowly; a repeat ask costs no search credits
const cache = new Map();
const inflight = new Map();

// Tavily's exact match treats "&" as a word, and people say "and": "Bramwell and Kent" is listed as "Bramwell & Kent".
function phrasings(name) {
  const n = String(name).replace(/\s+/g, " ").replace(/["“”]/g, "").trim();
  const amp = n.replace(/\s+and\s+/gi, " & ");
  const and = n.replace(/\s*&\s*/g, " and ");
  return [...new Set([amp, and])];
}

async function tavilySearch(phrase) {
  const headers = { "Content-Type": "application/json" };
  if (process.env.TAVILY_API_KEY) headers.Authorization = `Bearer ${process.env.TAVILY_API_KEY}`;
  else headers["X-Tavily-Access-Mode"] = "keyless";
  const res = await fetch(`${TAVILY()}/search`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      query: `"${phrase}"`, exact_match: true, search_depth: "basic", chunks_per_source: 3, max_results: 8,
      include_domains: REGULATORS.map((r) => r.domain),
    }),
    signal: AbortSignal.timeout(Number(process.env.MG_WARNINGS_TIMEOUT_MS || 8000)),
  });
  if (!res.ok) throw new Error(`Tavily answered HTTP ${res.status}`);
  return (await res.json()).results || [];
}

const JUDGE = `You check whether official regulator web pages warn the public about one specific seller of investments.
Be careful in both directions: a wrong "warning" accuses an innocent person, and a missed warning lets a scam through.
For each page, choose one verdict:
- "warning": the regulator publicly warns about this seller: an investor alert, a warning list entry, a notice that the firm is unauthorised, unregistered or a clone.
- "action": a regulator, court or prosecutor acted against this seller: charges, a bar, a fine, an order, a conviction.
- "mention": the seller's name appears for another reason, such as a filing, a register entry or a comment letter.
- "different": the page is about a different person or firm whose name only looks similar.
Decide only from the page text. A list of warned firms is a "warning" only if this seller's own name is on it. When unsure, choose "mention".
Answer with JSON only: {"pages":[{"id":1,"verdict":"warning","about":"the seller's name as the page writes it","date":"YYYY-MM-DD or null","quote":"the exact words, copied from the page, at most 25 words, that show the verdict"}]}`;

const squash = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** Nemotron 3 Super reads the pages. Its verdict stands only if its quote is really on the page. */
async function judge(name, pages, ai) {
  const r = await complete("judge", {
    messages: [
      { role: "system", content: JUDGE },
      { role: "user", content: JSON.stringify({ seller: name, pages: pages.map((p) => ({ id: p.id, regulator: p.regulator, url: p.url, title: p.title, text: p.text })) }) },
    ],
    json: true, temperature: 0, maxTokens: 1200, timeoutMs: Number(process.env.MG_JUDGE_TIMEOUT_MS || 20_000),
  });
  ai.push({ ...r.usage, job: "read the regulator pages" });
  const out = parseJson(r.message.content)?.pages;
  if (!Array.isArray(out)) throw new Error("Nemotron's answer was not the JSON we asked for");
  return pages.map((p) => {
    const v = out.find((x) => Number(x?.id) === p.id);
    const verdict = ["warning", "action", "mention", "different"].includes(v?.verdict) ? v.verdict : "mention";
    if (verdict !== "warning" && verdict !== "action") return { ...p, verdict, checked_by: r.usage.label };
    const quote = String(v.quote || "").slice(0, 300);
    const onPage = squash(quote).length >= 12 && squash(`${p.title} ${p.text}`).includes(squash(quote));
    if (!onPage) return { ...p, verdict: "mention", checked_by: r.usage.label, note: "The model's quote was not on the page, so this does not count." };
    return { ...p, verdict, about: v.about || null, date: /^\d{4}-\d{2}-\d{2}$/.test(v.date || "") ? v.date : null, quote, checked_by: r.usage.label };
  });
}

/** Search the regulators' sites for warnings about a seller. Never throws. */
export async function searchWarnings(name) {
  const key = squash(name);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return { ...hit.value, cached: true };
  if (!inflight.has(key)) inflight.set(key, lookUp(name).finally(() => inflight.delete(key)));
  const value = await inflight.get(key);
  if (value.status !== "unreadable") cache.set(key, { at: Date.now(), value });
  return value;
}

async function lookUp(name) {
  const ai = [];
  const searched = { provider: "Tavily", sites: REGULATORS.length, queries: phrasings(name).map((p) => `"${p}"`) };
  let results;
  try {
    if (process.env.MG_OFFLINE === "1") throw new Error("offline mode (MG_OFFLINE=1)");
    results = (await Promise.all(phrasings(name).map(tavilySearch))).flat();
  } catch (e) {
    return { status: "unreadable", error: e.message, warnings: [], mentions: [], searched, ai };
  }
  // Gates 1 and 2: a regulator's own page, with every word of the name on it. One entry per address.
  const byUrl = new Map();
  for (const r of results) {
    const regulator = regulatorOf(r.url);
    const text = String(r.content || "").slice(0, 2000);
    if (!regulator || byUrl.has(r.url) || !mentionsName(name, `${r.title} ${text}`)) continue;
    byUrl.set(r.url, { url: r.url, title: r.title || "", text, regulator: regulator.name, published: r.published_date || null });
  }
  const pages = [...byUrl.values()].slice(0, 5).map((p, i) => ({ id: i + 1, ...p }));
  // Gate 3: Nemotron reads them. Without it, or if it fails, only a page about this one firm counts.
  let read;
  if (pages.length && nemotronEnabled()) {
    try { read = await judge(name, pages, ai); } catch (e) { ai.push({ job: "read the regulator pages", error: e.message }); }
  }
  read ||= pages.map((p) => ({ ...p, verdict: onePageFor(name, p.url) ? "warning" : "mention", checked_by: "page address rule" }));
  const pick = ({ text, id, ...p }) => p;
  const warnings = read.filter((p) => p.verdict === "warning" || p.verdict === "action").map(pick);
  const mentions = read.filter((p) => p.verdict === "mention").map(pick);
  return {
    status: warnings.length ? "warned" : "none_found",
    warnings, mentions, different: read.filter((p) => p.verdict === "different").length,
    searched, retrieved_at: new Date().toISOString(), ai,
  };
}
