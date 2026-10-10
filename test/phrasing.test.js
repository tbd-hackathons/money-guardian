// Judges will not read our example buttons. They type their own sentences. Each case below is a
// natural way of saying something, with the tool the assistant must call for it. Scripted mode, offline.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = 8900 + Math.floor(Math.random() * 100);
const base = `http://127.0.0.1:${PORT}`;
let proc;

before(async () => {
  const env = { ...process.env, PORT: String(PORT), MG_LEDGER: join(mkdtempSync(join(tmpdir(), "mg-")), "ledger.json"), MG_OFFLINE: "1" };
  delete env.ANTHROPIC_API_KEY;
  proc = spawn(process.execPath, ["src/server.js"], { env, stdio: ["ignore", "pipe", "inherit"] });
  await new Promise((ok) => proc.stdout.once("data", ok));
});
after(() => proc.kill());

let n = 0;
const say = async (text, session_id) => {
  const r = await fetch(`${base}/api/chat`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ session_id, text }) });
  return r.json();
};
const tools = (r) => r.trace.map((t) => t.tool);

// [what the person says, the tool that must be called]
const FRESH = [
  // An investment offer
  ["Someone called offering me 12 percent guaranteed on a gold investment", "check_pitch"],
  ["I got a text saying I can double my money in crypto", "check_pitch"],
  ["A nice young man wants me to put my savings in a fund that pays 2% a month. Is that legit?", "check_pitch"],
  ["My friend from church told me about a no-risk investment paying twenty percent", "check_pitch"],
  ["Should I wire $20,000 to a man who says I'll get rich?", "check_pitch"],
  ["This fellow says the opportunity closes tomorrow and I can't tell my kids", "check_pitch"],
  ["Somebody on Facebook wants me to buy bitcoin", "check_pitch"],
  ["Is this a scam? A man says I won a prize but I have to pay a fee first", "check_pitch"],
  ["He told me to keep it secret from my daughter", "check_pitch"],
  ["My nephew says I should put money into his forex trading", "check_pitch"],
  ["I'm thinking of giving Victor Langston my retirement money", "check_seller"],
  ["Is it safe to invest with Rex Halvorsen? He promised 15 percent.", "check_seller"],
  // Who is selling
  ["Is Victor Langston legit?", "check_seller"],
  ["Can you look up a broker named John Smith?", "check_seller"],
  ["Who is Rex Halvorsen?", "check_seller"],
  ["Is Edward Jones a real company?", "check_seller"],
  ["check victor langston", "check_seller"],
  ["Is my adviser Victor Langston registered?", "check_seller"],
  ["Is Rex Halvorsen a licensed broker?", "check_seller"],
  // Bills
  ["Do I have any bills?", "review_bills"],
  ["Anything due soon?", "review_bills"],
  ["Show me my bills", "review_bills"],
  ["How much is the power bill?", "review_bills"],
  ["What do I owe this month?", "review_bills"],
  // Paying
  ["Pay my electricity bill", "pay_bill"],
  ["Please pay Ohio Power", "pay_bill"],
  ["Go ahead and pay the water", "pay_bill"],
  ["Send the money for the light bill", "pay_bill"],
  ["Can you take care of the water bill?", "pay_bill"],
  // Products
  ["What's an annuity?", "explain_product"],
  ["Are CDs safe?", "explain_product"],
  ["Tell me about treasury bills", "explain_product"],
  ["Is a bond a good idea?", "explain_product"],
  ["How do annuities work?", "explain_product"],
  // Banks
  ["Is First National Bank FDIC insured?", "check_bank"],
  ["Is Silver Lake Bank legit?", "check_bank"],
];

for (const [text, tool] of FRESH) {
  test(`"${text}" → ${tool}`, async () => {
    const r = await say(text, `p${n++}`);
    assert.ok(tools(r).includes(tool), `called [${tools(r)}], replied: ${r.reply}`);
  });
}

// After an offer was flagged, these mean "yes, ask Anna".
const PITCH = "A man named Victor Langston says I'm guaranteed 18% a year, but only today.";
for (const text of ["Yes", "Sure, go ahead", "Yeah, do that", "Call my daughter", "Let Anna know", "Please text Anna", "OK", "Go on then"]) {
  test(`after a scam: "${text}" → request_family_approval`, async () => {
    const s = `p${n++}`;
    await say(PITCH, s);
    const r = await say(text, s);
    assert.ok(tools(r).includes("request_family_approval"), `called [${tools(r)}], replied: ${r.reply}`);
  });
}

test(`after a scam: "No thanks" asks no one`, async () => {
  const s = `p${n++}`;
  await say(PITCH, s);
  const r = await say("No thanks", s);
  assert.deepEqual(tools(r), [], r.reply);
  assert.match(r.reply, /won't|will not|okay/i);
});

// After Anna was asked, these mean "has she answered?".
for (const text of ["Has Anna said anything?", "Did my daughter approve?", "Any news from Anna?", "What did Anna say?", "Did she reply yet?", "Has she gotten back to me?"]) {
  test(`after asking: "${text}" → approval_status`, async () => {
    const s = `p${n++}`;
    await say(PITCH, s);
    await say("Yes, tell Anna.", s);
    const r = await say(text, s);
    assert.ok(tools(r).includes("approval_status"), `called [${tools(r)}], replied: ${r.reply}`);
  });
}

// "Tell me more" in other words.
for (const text of ["Why?", "How do you know?", "What makes you say that?", "Can you explain?", "Tell me more"]) {
  test(`after a scam: "${text}" gives the details`, async () => {
    const s = `p${n++}`;
    await say(PITCH, s);
    const r = await say(text, s);
    assert.match(r.reply, /FINRA|SEC|register/i, r.reply);
  });
}

test(`"Thank you" gets a short, polite answer`, async () => {
  const r = await say("Thank you", `p${n++}`);
  assert.match(r.reply, /welcome/i);
});
