// The demo story end to end over HTTP: the simulator talks to /api/chat, which is an MCP client of /mcp.
// Runs offline (MG_OFFLINE=1: every public source "fails"), in scripted mode (no AI key).
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
  const env = { ...process.env, PORT: String(PORT), MG_LEDGER: join(mkdtempSync(join(tmpdir(), "mg-")), "ledger.json"), MG_OFFLINE: "1" };
  delete env.ANTHROPIC_API_KEY;
  proc = spawn(process.execPath, ["src/server.js"], { env, stdio: ["ignore", "pipe", "inherit"] });
  await new Promise((ok) => proc.stdout.once("data", ok));
});
after(() => proc.kill());

const say = async (text, session_id = "t1") => {
  const r = await fetch(`${base}/api/chat`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ session_id, text }) });
  return r.json();
};

test("unusual bill is held, family approves, it is paid once", async () => {
  let r = await say("What bills do I have?");
  assert.match(r.reply, /Ohio Power bill looks wrong/);
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

const words = (s) => s.trim().split(/\s+/).length;

test("every spoken answer is short enough to listen to", async () => {
  const story = [
    "A man named Victor Langston called me. He says I'm guaranteed 18% a year, but only today, and I should keep it between us.",
    "Yes, tell Anna.", "What is an annuity?", "What bills do I have?", "Pay the power bill.", "Yes please.", "Did Anna answer?",
  ];
  for (const text of story) {
    const r = await say(text, "short");
    assert.ok(words(r.reply) <= 40, `${words(r.reply)} words for "${text}": ${r.reply}`);
  }
  const more = await say("Tell me more.", "short");
  assert.ok(words(more.reply) <= 75, `${words(more.reply)} words of detail`);
});

test("an unreadable register is never reported as 'not registered'", async () => {
  const r = await say("A man named Victor Langston called me. He says I'm guaranteed 18% a year, but only today, and I should keep it between us.", "offline");
  assert.match(r.reply, /couldn't reach the registers/);
  assert.doesNotMatch(r.reply, /not registered/);
  assert.match(r.reply, /scam/); // the pitch itself is still judged
});

test("two hosted-demo visitors never see each other's approvals", async () => {
  const chatAs = (demo, text) => fetch(`${base}/api/chat?demo=${demo}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ session_id: demo, text }) }).then((r) => r.json());
  await chatAs("judgeaaa1", "Pay the power bill.");
  await chatAs("judgeaaa1", "Yes please.");
  const a = await (await fetch(`${base}/api/approvals?demo=judgeaaa1`)).json();
  const b = await (await fetch(`${base}/api/approvals?demo=judgebbb2`)).json();
  assert.equal(a.length, 1);
  assert.equal(b.length, 0);
  // and judge B cannot approve judge A's request
  const r = await (await fetch(`${base}/api/approvals/${a[0].approval_id}?demo=judgebbb2`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ decision: "approve" }) })).json();
  assert.match(r.error, /No approval/);
});
