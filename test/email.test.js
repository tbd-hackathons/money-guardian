// Email to the trusted contact, end to end, against a fake Amazon SES on localhost: the real SES
// client, real signed links, and the real answer page. Only SES itself is fake.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const mails = [];
let rejectNext = false;
const ses = createServer(async (req, res) => {
  let raw = "";
  for await (const c of req) raw += c;
  if (rejectNext) {
    rejectNext = false;
    return res.writeHead(400, { "Content-Type": "application/json", "x-amzn-ErrorType": "MessageRejected" }).end(JSON.stringify({ message: "Email address is not verified." }));
  }
  mails.push({ path: req.url, signed: /AWS4-HMAC-SHA256/.test(req.headers.authorization || ""), body: JSON.parse(raw) });
  res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ MessageId: `fake-${mails.length}` }));
});

let proc, base;
before(async () => {
  await new Promise((ok) => ses.listen(0, "127.0.0.1", ok));
  const port = 9300 + Math.floor(Math.random() * 100);
  base = `http://127.0.0.1:${port}`;
  const env = {
    ...process.env, PORT: String(port), MG_LEDGER: join(mkdtempSync(join(tmpdir(), "mg-")), "l.json"), MG_OFFLINE: "1",
    MG_SES_REGION: "us-east-1", MG_SES_ENDPOINT: `http://127.0.0.1:${ses.address().port}`,
    MG_EMAIL_FROM: "guardian@example.com", MG_FAMILY_EMAIL: "anna@example.com", MG_PUBLIC_URL: base, MG_LINK_SECRET: "test-only-secret",
    // Dummy values so the SES client can sign; the fake accepts anything. Not real credentials.
    AWS_ACCESS_KEY_ID: "AKIATESTONLY", AWS_SECRET_ACCESS_KEY: "test-only", AWS_PROFILE: "",
  };
  for (const k of ["ANTHROPIC_API_KEY", "MG_BEDROCK_REGION", "AWS_SESSION_TOKEN"]) delete env[k];
  proc = spawn(process.execPath, ["src/server.js"], { env, stdio: ["ignore", "pipe", "pipe"] });
  await new Promise((ok) => proc.stdout.once("data", ok));
});
after(() => { proc.kill(); ses.close(); });

const say = async (text, session_id, demo) =>
  (await fetch(`${base}/api/chat${demo ? `?demo=${demo}` : ""}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ session_id, text }) })).json();
const PITCH = "A man named Victor Langston says I'm guaranteed 18% a year, but only today.";
const linkIn = (mail) => mail.body.Content.Simple.Body.Text.Data.match(/https?:\/\/\S+\/a\/\S+/)[0];
const approvals = async (demo) => (await fetch(`${base}/api/approvals${demo ? `?demo=${demo}` : ""}`)).json();

test("Anna gets one signed email; opening the link decides nothing; pressing Approve does", async () => {
  mails.length = 0;
  await say(PITCH, "e1");
  let r = await say("Yes, tell Anna.", "e1");
  assert.match(r.reply, /I've emailed Anna/);
  r = await say("Yes, tell Anna.", "e1"); // asking twice
  assert.equal(mails.length, 1, "asking twice must not send a second email");

  const [mail] = mails;
  assert.ok(mail.signed, "the request is signed with SigV4");
  assert.deepEqual(mail.body.Destination.ToAddresses, ["anna@example.com"]);
  assert.match(mail.body.Content.Simple.Subject.Data, /Margaret needs your OK/);
  const link = linkIn(mail);

  // A mail scanner opening the link must not approve anything.
  const page = await fetch(link);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Approve<\/button>/);
  assert.equal((await approvals())[0].status, "pending");

  const done = await fetch(link, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "decision=approve" });
  assert.match(await done.text(), /You approved this/);
  assert.equal((await approvals())[0].status, "approved");
  r = await say("Did Anna answer?", "e1");
  assert.match(r.reply, /approved/);
});

test("a forged or altered link is refused", async () => {
  mails.length = 0;
  await say(PITCH, "e2");
  await say("Yes, tell Anna.", "e2");
  const link = linkIn(mails[0]);
  const forged = link.slice(0, -2) + (link.endsWith("AA") ? "BB" : "AA");
  assert.equal((await fetch(forged)).status, 404);
  const post = await fetch(forged, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "decision=approve" });
  assert.equal(post.status, 404);
  assert.ok((await approvals()).some((a) => a.status === "pending"));
});

test("visitors of the hosted demo never trigger email", async () => {
  mails.length = 0;
  await say(PITCH, "e3", "judge12345");
  const r = await say("Yes, tell Anna.", "e3", "judge12345");
  assert.match(r.reply, /I've asked Anna/);
  assert.equal(mails.length, 0);
  assert.equal((await approvals("judge12345")).length, 1);
});

test("if SES rejects the email, the request still stands", async () => {
  mails.length = 0;
  rejectNext = true;
  await say("A woman named Dana Whitfield says I'm guaranteed 20% a year if I act now.", "e4"); // a new offer, so a new request
  const r = await say("Yes, tell Anna.", "e4");
  assert.match(r.reply, /I've asked Anna/);
  assert.ok(r.trace.some((t) => t.result?.email?.sent === false));
});
