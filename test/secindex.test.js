// The SEC adviser register, read from the SEC's daily compilation files (a five-row sample here).
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

process.env.MG_SEC_INDEX = fileURLToPath(new URL("../fixtures/sec-iapd-sample.tsv.gz", import.meta.url));
const { searchSecIndex, secIndexDate } = await import("../src/secindex.js");
const { nameMatches } = await import("../src/sources.js");

test("the index says which day's compilation it is", () => {
  assert.equal(secIndexDate(), "2026-10-10");
});

test("a person is found by their name or a name they used before, with a link to their SEC record", () => {
  const [r] = searchSecIndex("Bill Renye");
  assert.equal(r.crd, "4247501");
  assert.equal(r.name, "WILLIAM GERARD RENYE");
  assert.equal(r.profile_url, "https://adviserinfo.sec.gov/individual/summary/4247501");
  assert.deepEqual(r.current_firms, ["CAMBRIDGE INVESTMENT RESEARCH ADVISORS, INC."]);
  assert.equal(searchSecIndex("william renye")[0].crd, "4247501"); // case does not matter
});

test("every word heard must match: two Jeff Webbs, no Jeff Smith", () => {
  assert.deepEqual(searchSecIndex("Jeff Webb").map((r) => r.crd).sort(), ["3120179", "4247492"]);
  assert.equal(searchSecIndex("Jeff Smith").length, 0);
  assert.equal(searchSecIndex("Jeff Renye").length, 0); // "Renye" alone is not enough
  assert.equal(searchSecIndex("Victor Langston").length, 0);
  for (const r of searchSecIndex("Jeff Webb")) assert.ok(nameMatches("Jeff Webb", r));
});

test("firms carry their disclosures, and the kind filter works", () => {
  const [v] = searchSecIndex("Vanguard", "firm");
  assert.equal(v.has_disclosures, true);
  assert.equal(v.profile_url, "https://adviserinfo.sec.gov/firm/summary/105958");
  assert.equal(searchSecIndex("Vanguard", "individual").length, 0);
  assert.equal(searchSecIndex("Rabenold Advisors")[0].has_disclosures, false);
});
