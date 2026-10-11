// Public US sources, read live. Every result carries its source URL and retrieval time.
// BrokerCheck has no documented API; FINRA permits investor-protection lookups that
// do not burden the site and that credit BrokerCheck (see README "Data sources").

import net from "node:net";
import { searchSecIndex } from "./secindex.js";

// Some networks advertise IPv6 but drop it (treasurydirect.gov does this here). Node's default 250 ms
// before trying IPv4 is too short and fetch then times out. Give each address family 500 ms.
net.setDefaultAutoSelectFamilyAttemptTimeout(500);

const UA = process.env.MG_USER_AGENT || "MoneyGuardian/0.1 (+https://github.com/tbd-hackathons/money-guardian)";
const TTL_MS = 10 * 60 * 1000;
const cache = new Map();
const lastCall = new Map(); // per host, so FINRA and the SEC are each called politely but in parallel
const STALE_OK_MS = 24 * 60 * 60 * 1000;

async function fetchJson(url) {
  const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" }, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw Object.assign(new Error(`${new URL(url).host} answered HTTP ${res.status}`), { http: true });
  return res.json();
}

const inflight = new Map(); // url -> the request already on its way, shared by everyone who asks

// background: answer from a cached copy younger than a day at once, and refresh it behind the
// scenes once it is older than the TTL. For data that changes slowly (rates, the list of banks).
async function getJson(url, { throttleMs = 0, background = false } = {}) {
  if (process.env.MG_OFFLINE === "1") throw new Error("offline mode (MG_OFFLINE=1)");
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  if (background && hit && Date.now() - hit.at < STALE_OK_MS) {
    fetchShared(url, throttleMs).catch(() => {}); // the next caller gets the fresh copy
    return hit.value;
  }
  return fetchShared(url, throttleMs);
}

function fetchShared(url, throttleMs) {
  if (!inflight.has(url)) inflight.set(url, fetchFresh(url, throttleMs).finally(() => inflight.delete(url)));
  return inflight.get(url);
}

async function fetchFresh(url, throttleMs) {
  const hit = cache.get(url);
  if (throttleMs) {
    const host = new URL(url).host;
    const wait = (lastCall.get(host) || 0) + throttleMs - Date.now();
    lastCall.set(host, Date.now() + Math.max(wait, 0));
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  }
  let data;
  try {
    data = await fetchJson(url);
  } catch (e) {
    try {
      if (e.http) throw e; // a real answer from the server: do not hammer it
      data = await fetchJson(url); // one retry for a dropped connection
    } catch (e2) {
      // Last good answer, clearly marked with its own time, beats no answer. Never older than a day.
      if (hit && Date.now() - hit.at < STALE_OK_MS) return { ...hit.value, stale: true };
      throw e2;
    }
  }
  const value = { data, retrieved_at: new Date().toISOString(), url };
  cache.set(url, { at: Date.now(), value });
  return value;
}

// MG_BROKERCHECK_URL and MG_FDIC_URL exist for the tests, which run against fakes on localhost.
const BROKERCHECK = process.env.MG_BROKERCHECK_URL || "https://api.brokercheck.finra.org/search";

function registerUrl(base, kind, query) {
  const q = new URLSearchParams({ query, hl: "true", nrows: "12", start: "0", r: "25", sort: "score+desc", wt: "json" });
  return `${base}/${kind}?${q}`;
}

function personRow(s) {
  const name = [s.ind_firstname, s.ind_middlename, s.ind_lastname].filter(Boolean).join(" ");
  const employers = (s.ind_current_employments || []).map((e) => e.firm_name).filter(Boolean);
  return {
    kind: "individual",
    name,
    crd: s.ind_source_id,
    broker_status: s.ind_bc_scope || "unknown",
    adviser_status: s.ind_ia_scope || "unknown",
    has_disclosures: s.ind_bc_disclosure_fl === "Y" || s.ind_ia_disclosure_fl === "Y",
    current_firms: employers,
    other_names: s.ind_other_names || [],
    profile_url: `https://brokercheck.finra.org/individual/summary/${s.ind_source_id}`,
  };
}

function firmRow(s) {
  return {
    kind: "firm",
    name: s.firm_name,
    crd: s.firm_source_id,
    broker_status: s.firm_scope || s.firm_bc_scope || "unknown",
    adviser_status: s.firm_ia_scope || "unknown",
    has_disclosures: s.firm_bc_disclosure_fl === "Y" || s.firm_ia_disclosure_fl === "Y",
    other_names: s.firm_other_names || [],
    profile_url: `https://brokercheck.finra.org/firm/summary/${s.firm_source_id}`,
  };
}

// Words that do not identify anyone: "Mr", "LLC", "and"... A firm's "Capital" or "Partners" do count.
const FILLER = new Set(["mr", "mrs", "ms", "dr", "the", "and", "of", "inc", "llc", "co", "corp", "ltd", "lp", "&"]);
const words = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w && !FILLER.has(w));

/**
 * The registers search loosely: "Rex Halvorsen" also returns a REBECCA WITTROCK.
 * A row is a match only if every word the person heard is in its name, or in a name it used before.
 */
export function nameMatches(query, row) {
  const q = words(query);
  if (!q.length) return false;
  return [row.name, ...(row.other_names || [])].some((n) => {
    const have = new Set(words(n));
    return q.every((w) => have.has(w));
  });
}

/** Look a seller up in FINRA BrokerCheck (brokers) and SEC IAPD (advisers). */
export async function searchRegisters(name, kind = "any") {
  const kinds = kind === "any" ? ["individual", "firm"] : [kind];
  const results = [];
  const errors = [];
  // FINRA BrokerCheck is read live. The SEC adviser register comes from the SEC's own daily
  // compilation files (registers/sec-iapd.tsv.gz): no network call, and nothing to block.
  // One lookup sends its two FINRA queries together; the polite spacing is between lookups.
  const budget = Number(process.env.MG_LIVE_BUDGET_MS || 0);
  await Promise.all(kinds.map(async (k, i) => {
    const ask = getJson(registerUrl(BROKERCHECK, k, name), { throttleMs: i === 0 ? 1200 : 0 });
    try {
      // With a budget, a slow FINRA answer is not waited for; it still arrives and is cached for the next ask.
      const r = budget ? await Promise.race([ask, new Promise((_, no) => setTimeout(() => no(new Error(`no answer within ${budget} ms`)), budget))]) : await ask;
      for (const h of r.data?.hits?.hits || []) {
        const row = k === "individual" ? personRow(h._source) : firmRow(h._source);
        results.push({ ...row, register: "FINRA BrokerCheck", retrieved_at: r.retrieved_at });
      }
    } catch (e) {
      ask.catch(() => {});
      errors.push(`FINRA BrokerCheck (${k}): ${e.message}`);
    }
  }));
  for (const k of kinds) {
    try {
      // MG_OFFLINE=1 turns off every register lookup, local or not, so tests can rehearse "no register answered".
      if (process.env.MG_OFFLINE === "1") throw new Error("offline mode (MG_OFFLINE=1)");
      for (const row of searchSecIndex(name, k)) results.push({ ...row, register: "SEC IAPD" });
    } catch (e) {
      errors.push(`SEC IAPD (${k}): ${e.message}`);
    }
  }
  // The two registers share CRD numbers; keep one row per person or firm.
  const byCrd = new Map();
  for (const row of results) {
    const key = `${row.kind}:${row.crd}`;
    const prev = byCrd.get(key);
    byCrd.set(key, prev ? { ...prev, registers: [...new Set([...prev.registers, row.register])] } : { ...row, registers: [row.register] });
  }
  const rows = [...byCrd.values()].map(({ register, ...r }) => r);
  // "similar" are the register's loose hits: shown for transparency, never treated as the seller.
  return { matches: rows.filter((r) => nameMatches(name, r)), similar: rows.filter((r) => !nameMatches(name, r)), errors };
}

/** Latest Treasury bill auction yields: what a new buyer actually earns, risk-free. */
export async function treasuryBillYields() {
  const url = "https://www.treasurydirect.gov/TA_WS/securities/auctioned?format=json&type=Bill&pagesize=20";
  const r = await getJson(url, { background: true }); // changes only at auctions
  const latest = new Map();
  for (const a of r.data) {
    const term = a.securityTerm;
    if (!latest.has(term) && a.highInvestmentRate) {
      latest.set(term, { term, yield_pct: Number(a.highInvestmentRate), auction_date: a.auctionDate.slice(0, 10) });
    }
  }
  return { bills: [...latest.values()], source_url: "https://www.treasurydirect.gov/auctions/auction-query/", retrieved_at: r.retrieved_at, ...(r.stale ? { stale: true } : {}) };
}

// Every active FDIC-insured bank (about 4,200) in one request, refreshed daily behind the scenes.
const FDIC_ALL = `${process.env.MG_FDIC_URL || "https://api.fdic.gov/banks/institutions"}?${new URLSearchParams({ filters: "ACTIVE:1", fields: "NAME,CERT,CITY,STALP", limit: "10000", sort_by: "CERT", sort_order: "ASC" })}`;

/** Load the list of banks now, so the first question doesn't wait for it. */
export const warmBanks = () => getJson(FDIC_ALL, { background: true });

/** FDIC-insured status of a bank by name: every word heard must be in the bank's name. */
export async function fdicBank(name) {
  const r = await getJson(FDIC_ALL, { background: true });
  const q = words(name).filter((w) => w !== "bank");
  const exact = (b) => (b.name.toLowerCase() === String(name).trim().toLowerCase() ? 0 : 1);
  const banks = (r.data?.data || [])
    .map((d) => ({ name: d.data.NAME, fdic_cert: d.data.CERT, city: d.data.CITY, state: d.data.STALP }))
    .filter((b) => q.length && q.every((w) => words(b.name).includes(w)))
    .sort((a, b) => exact(a) - exact(b) || a.name.length - b.name.length)
    .slice(0, 5);
  return { banks, source_url: "https://banks.data.fdic.gov/bankfind-suite/bankfind", retrieved_at: r.retrieved_at, ...(r.stale ? { stale: true } : {}) };
}

export const ATTRIBUTION =
  "Registration data from FINRA BrokerCheck (brokercheck.finra.org) and the SEC Investment Adviser Public Disclosure site (adviserinfo.sec.gov), " +
  "as of the time shown. Check the full record on BrokerCheck before deciding; report errors to FINRA.";
