// Public US sources, read live. Every result carries its source URL and retrieval time.
// BrokerCheck and IAPD have no documented API; FINRA permits investor-protection lookups that
// do not burden the site and that credit BrokerCheck (see README "Data sources").

import net from "node:net";

// Some networks advertise IPv6 but drop it (treasurydirect.gov does this here). Node's default 250 ms
// before trying IPv4 is too short and fetch then times out. Give each address family 500 ms.
net.setDefaultAutoSelectFamilyAttemptTimeout(500);

const UA = process.env.MG_USER_AGENT || "MoneyGuardian/0.1 (investor-protection hackathon demo)";
const TTL_MS = 10 * 60 * 1000;
const cache = new Map();
const lastCall = new Map(); // per host, so FINRA and the SEC are each called politely but in parallel
const STALE_OK_MS = 24 * 60 * 60 * 1000;

async function fetchJson(url) {
  const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" }, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw Object.assign(new Error(`${new URL(url).host} answered HTTP ${res.status}`), { http: true });
  return res.json();
}

async function getJson(url, { throttleMs = 0 } = {}) {
  if (process.env.MG_OFFLINE === "1") throw new Error("offline mode (MG_OFFLINE=1)");
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
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

const BROKERCHECK = "https://api.brokercheck.finra.org/search";
const IAPD = "https://api.adviserinfo.sec.gov/search";

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
  const queries = kinds.flatMap((k) => [["FINRA BrokerCheck", BROKERCHECK], ["SEC IAPD", IAPD]].map(([label, base]) => ({ k, label, base })));
  await Promise.all(queries.map(async ({ k, label, base }) => {
    try {
      const r = await getJson(registerUrl(base, k, name), { throttleMs: 1200 });
      for (const h of r.data?.hits?.hits || []) {
        const row = k === "individual" ? personRow(h._source) : firmRow(h._source);
        results.push({ ...row, register: label, retrieved_at: r.retrieved_at });
      }
    } catch (e) {
      errors.push(`${label} (${k}): ${e.message}`);
    }
  }));
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
  const r = await getJson(url);
  const latest = new Map();
  for (const a of r.data) {
    const term = a.securityTerm;
    if (!latest.has(term) && a.highInvestmentRate) {
      latest.set(term, { term, yield_pct: Number(a.highInvestmentRate), auction_date: a.auctionDate.slice(0, 10) });
    }
  }
  return { bills: [...latest.values()], source_url: "https://www.treasurydirect.gov/auctions/auction-query/", retrieved_at: r.retrieved_at, ...(r.stale ? { stale: true } : {}) };
}

/** FDIC-insured status of a bank by name. */
export async function fdicBank(name) {
  const q = new URLSearchParams({ filters: `NAME:"${name.replace(/"/g, "")}" AND ACTIVE:1`, fields: "NAME,CERT,CITY,STALP,ACTIVE", limit: "5" });
  const r = await getJson(`https://api.fdic.gov/banks/institutions?${q}`);
  return {
    banks: (r.data?.data || []).map((d) => ({ name: d.data.NAME, fdic_cert: d.data.CERT, city: d.data.CITY, state: d.data.STALP })),
    source_url: "https://banks.data.fdic.gov/bankfind-suite/bankfind",
    retrieved_at: r.retrieved_at,
  };
}

export const ATTRIBUTION =
  "Registration data from FINRA BrokerCheck (brokercheck.finra.org) and the SEC Investment Adviser Public Disclosure site (adviserinfo.sec.gov), " +
  "read live at the time shown. Check the full record on BrokerCheck before deciding; report errors to FINRA.";
