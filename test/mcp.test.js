import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

process.env.MG_LEDGER = join(mkdtempSync(join(tmpdir(), "mg-")), "ledger.json");
const { buildServer } = await import("../src/tools.js");

test("MCP: tools list and an offline tool call", async () => {
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await buildServer().connect(st);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(ct);
  const names = (await client.listTools()).tools.map((t) => t.name).sort();
  assert.deepEqual(names, ["approval_status", "check_bank", "check_pitch", "check_seller", "explain_product", "pay_bill", "request_family_approval", "review_bills"]);
  const r = await client.callTool({ name: "review_bills", arguments: {} });
  assert.match(r.structuredContent.say, /Ohio Power/);
  await client.close();
});
