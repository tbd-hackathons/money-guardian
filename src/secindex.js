// The SEC adviser register (IAPD), read from the SEC's own daily compilation files instead of the
// live site. registers/sec-iapd.tsv.gz is built by scripts/build-sec-index.mjs; it lists every
// investment adviser representative and adviser firm with their CRD numbers.

import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";

const FILE = process.env.MG_SEC_INDEX || new URL("../registers/sec-iapd.tsv.gz", import.meta.url);

let index; // { asOf, lines: raw TSV rows, words: Map(word -> row numbers) }

const wordsOf = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length > 1);

function load() {
  if (index) return index;
  const text = gunzipSync(readFileSync(FILE)).toString("utf8");
  const asOf = text.match(/as of (\d{4}-\d\d-\d\d)/)?.[1] || "unknown";
  const lines = text.split("\n").filter((l) => l && l[0] !== "#");
  // Each word of every name a row is known by points back to the row.
  const words = new Map();
  lines.forEach((line, i) => {
    const [, , name, others] = line.split("\t", 4);
    for (const w of new Set(wordsOf(`${name} ${others}`))) {
      const list = words.get(w);
      if (list) list.push(i); else words.set(w, [i]);
    }
  });
  index = { asOf, lines, words };
  return index;
}

/** When the compilation was published, e.g. "2026-10-10". */
export const secIndexDate = () => load().asOf;

/**
 * Candidate rows for a name: every word the person heard appears among the row's names.
 * The caller still applies its own exact rule (nameMatches) to each candidate.
 */
export function searchSecIndex(query, kind = "any", limit = 25) {
  const { asOf, lines, words } = load();
  const q = [...new Set(wordsOf(query))];
  if (!q.length) return [];
  const lists = q.map((w) => words.get(w) || []).sort((a, b) => a.length - b.length);
  const rest = lists.slice(1).map((l) => new Set(l));
  const out = [];
  for (const i of lists[0]) {
    if (!rest.every((set) => set.has(i))) continue;
    const [k, crd, name, others, firms, drp, status] = lines[i].split("\t");
    if (kind !== "any" && k !== kind) continue;
    out.push({
      kind: k,
      name,
      crd,
      adviser_status: status,
      has_disclosures: drp === "Y",
      ...(k === "individual" ? { current_firms: firms ? firms.split("|") : [] } : {}),
      other_names: others ? others.split("|") : [],
      profile_url: `https://adviserinfo.sec.gov/${k === "firm" ? "firm" : "individual"}/summary/${crd}`,
      retrieved_at: `${asOf} (SEC daily compilation)`,
    });
    if (out.length >= limit) break;
  }
  return out;
}
