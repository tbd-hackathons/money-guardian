// The demo story end to end over HTTP: the simulator talks to /api/chat, which is an MCP client of /mcp.
// Bills only, so it runs offline. Scripted mode (no AI key).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = 8800 + Math.floor(Math.random() * 100);
const base = `http://127.0.0.1:${PORT}`;
let proc;

before(async () => {
  const env = { ...process.env, PORT: String(PORT), MG_LEDGER: join(mkdtempSync(join(tmpdir(), "mg-")), "ledger.json") };
  delete env.ANTHROPIC_API_KEY;
  proc = spawn(process.execPath, ["src/server.js"], { env, stdio: ["ignore", "pipe", "inherit"] });
  await new Promise((ok) => proc.stdout.once("data", ok));
});
after(() => proc.kill());

const say = async (text) => {
  const r = await fetch(`${base}/api/chat`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ session_id: "t1", text }) });
  return r.json();
};

test("unusual bill is held, family approves, it is paid once", async () => {
  let r = await say("What bills do I have?");
  assert.match(r.reply, /1 looks unusual/);
  r = await say("Pay the power bill.");
  assert.match(r.reply, /not pay this yet/i);
  assert.ok(!r.trace.some((t) => t.result?.status === "paid"));
  r = await say("Yes please.");
  assert.match(r.reply, /asked Anna/);
  const [a] = await (await fetch(`${base}/api/approvals`)).json();
  assert.equal(a.status, "pending");
  r = await say("Pay it.");
  assert.match(r.reply, /Waiting for Anna/);
  await fetch(`${base}/api/approvals/${a.approval_id}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ decision: "approve" }) });
  r = await say("Did Anna answer?");
  assert.match(r.reply, /approved/);
  r = await say("Pay it.");
  assert.match(r.reply, /Confirmation SIM-/);
  r = await say("Pay the power bill.");
  assert.match(r.reply, /Not paying twice/);
});

test("normal bill pays without asking", async () => {
  const r = await say("Pay the water bill.");
  assert.match(r.reply, /Confirmation SIM-/);
});

test("pages are served as HTML", async () => {
  for (const path of ["/", "/family"]) {
    const r = await fetch(base + path);
    assert.match(r.headers.get("content-type"), /text\/html/);
    assert.match(await r.text(), /^<!doctype html>/i);
  }
});
