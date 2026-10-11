// Alexa+ wants each tool answered within 500 ms. Live sources are faked on localhost here, FINRA
// deliberately slow, to show what the time budget does.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let finraDelay = 1000, finraCalls = 0, fdicCalls = 0;
const fake = createServer((req, res) => {
  const json = (body) => res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(body));
  if (req.url.startsWith("/finra/")) { finraCalls++; return setTimeout(() => json({ hits: { hits: [] } }), finraDelay); }
  if (req.url.startsWith("/fdic")) {
    fdicCalls++;
    return json({ data: [
      { data: { NAME: "JPMorgan Chase Bank, National Association", CERT: 628, CITY: "Columbus", STALP: "OH" } },
      { data: { NAME: "Chase Valley Bank", CERT: 9, CITY: "Somewhere", STALP: "KS" } },
      { data: { NAME: "First Bank", CERT: 1, CITY: "Town", STALP: "NC" } },
    ] });
  }
  res.writeHead(404).end();
});

let callTool, src;
before(async () => {
  await new Promise((ok) => fake.listen(0, "127.0.0.1", ok));
  const base = `http://127.0.0.1:${fake.address().port}`;
  Object.assign(process.env, {
    MG_BROKERCHECK_URL: `${base}/finra`, MG_FDIC_URL: `${base}/fdic`, MG_LIVE_BUDGET_MS: "300",
    MG_SEC_INDEX: fileURLToPath(new URL("../fixtures/sec-iapd-sample.tsv.gz", import.meta.url)),
    MG_LEDGER: join(mkdtempSync(join(tmpdir(), "mg-")), "l.json"),
  });
  delete process.env.MG_OFFLINE;
  src = await import("../src/sources.js");
  const { buildServer } = await import("../src/tools.js");
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await buildServer().connect(st);
  const client = new Client({ name: "t", version: "0" });
  await client.connect(ct);
  callTool = async (name, args) => (await client.callTool({ name, arguments: args })).structuredContent;
});
after(() => fake.close());

test("a slow FINRA is not waited for: the answer comes within the budget and says FINRA didn't answer", async () => {
  const t = performance.now();
  const r = await callTool("check_seller", { name: "Victor Langston" });
  const ms = performance.now() - t;
  assert.ok(ms < 500, `answered in ${Math.round(ms)} ms`);
  assert.equal(r.status, "not_found_partial");
  assert.deepEqual(r.answered, ["SEC IAPD"]);
  assert.match(r.say, /The SEC has nobody named Victor Langston.*couldn't reach FINRA BrokerCheck/);
});

test("the slow answer still lands, and the next ask is complete and instant", async () => {
  await new Promise((ok) => setTimeout(ok, 1200)); // FINRA's late answer arrives and is cached
  const t = performance.now();
  const r = await callTool("check_seller", { name: "Victor Langston" });
  assert.ok(performance.now() - t < 50);
  assert.equal(r.status, "not_found");
  assert.match(r.say, /not registered/);
});

test("a fast FINRA answers in full within the budget", async () => {
  finraDelay = 20;
  const r = await callTool("check_seller", { name: "Jeff Webb" });
  assert.equal(r.status, "several"); // two Jeff Webbs in the SEC sample
  assert.deepEqual(r.errors, []);
});

test("banks come from one cached list of every insured bank: every word heard must match", async () => {
  const calls = fdicCalls;
  await src.warmBanks();
  const t = performance.now();
  const a = await callTool("check_bank", { bank: "Chase" });
  const b = await callTool("check_bank", { bank: "First Bank" });
  const c = await callTool("check_bank", { bank: "Chase Manhattan" });
  assert.ok(performance.now() - t < 100);
  assert.ok(fdicCalls - calls <= 1, "one request for the whole list");
  assert.deepEqual(a.banks.map((x) => x.fdic_cert), [9, 628]); // shorter name first
  assert.deepEqual(b.banks.map((x) => x.fdic_cert), [1]);
  assert.equal(c.banks.length, 0);
  assert.match(c.say || "", /no active FDIC-insured bank/i);
});
