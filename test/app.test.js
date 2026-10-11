// The MCP App card (SEP-1865): tools name it, the server serves it as a ui:// resource, and the
// simulator reads it over MCP the way an Alexa+ device with a screen would.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

process.env.MG_LEDGER = join(mkdtempSync(join(tmpdir(), "mg-")), "ledger.json");
const { buildServer, CARD_URI } = await import("../src/tools.js");

async function connected() {
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await buildServer().connect(st);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(ct);
  return client;
}

test("every tool names the card, and the card is a ui:// resource with the MCP App MIME type", async () => {
  const client = await connected();
  const { tools } = await client.listTools();
  for (const t of tools) assert.equal(t._meta?.ui?.resourceUri, CARD_URI, `${t.name} names the card`);
  const { resources } = await client.listResources();
  const card = resources.find((r) => r.uri === CARD_URI);
  assert.ok(card, "the card is listed");
  assert.equal(card.mimeType, "text/html;profile=mcp-app");
  const { contents: [c] } = await client.readResource({ uri: CARD_URI });
  assert.equal(c.mimeType, "text/html;profile=mcp-app");
  assert.match(c.text, /^<!doctype html>/i);
  assert.match(c.text, /"ui\/initialize"/);
  assert.match(c.text, /ui\/notifications\/tool-result/);
  assert.doesNotMatch(c.text, /\bfetch\(|XMLHttpRequest|<script[^>]+src=/, "the card loads nothing from the network");
  await client.close();
});

test("tool results still carry the full answer as text, for hosts without a screen", async () => {
  const client = await connected();
  const r = await client.callTool({ name: "review_bills", arguments: {} });
  assert.match(r.content[0].text, /Ohio Power/);
  assert.match(r.structuredContent.say, /Ohio Power/);
  await client.close();
});

let proc, base;
before(async () => {
  const port = 9400 + Math.floor(Math.random() * 100);
  base = `http://127.0.0.1:${port}`;
  const env = { ...process.env, PORT: String(port), MG_LEDGER: join(mkdtempSync(join(tmpdir(), "mg-")), "l.json"), MG_OFFLINE: "1" };
  for (const k of ["ANTHROPIC_API_KEY", "MG_BEDROCK_REGION", "MG_SES_REGION"]) delete env[k];
  proc = spawn(process.execPath, ["src/server.js"], { env, stdio: ["ignore", "pipe", "pipe"] });
  await new Promise((ok) => proc.stdout.once("data", ok));
});
after(() => proc.kill());

test("the simulator's chat trace names each call's card, and reads the card over MCP", async () => {
  const r = await (await fetch(`${base}/api/chat`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ session_id: "u1", text: "What bills do I have?" }) })).json();
  assert.ok(r.trace.length);
  for (const t of r.trace) assert.equal(t.ui, CARD_URI);
  const card = await (await fetch(`${base}/api/ui?uri=${encodeURIComponent(CARD_URI)}`)).json();
  assert.equal(card.mimeType, "text/html;profile=mcp-app");
  assert.match(card.text, /Money Guardian card/);
  assert.equal((await fetch(`${base}/api/ui?uri=${encodeURIComponent("file:///etc/passwd")}`)).status, 404);
  assert.equal((await fetch(`${base}/api/ui?uri=${encodeURIComponent("ui://money-guardian/nope.html")}`)).status >= 400, true);
});
