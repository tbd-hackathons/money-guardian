import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.MG_LEDGER = join(mkdtempSync(join(tmpdir(), "mg-")), "ledger.json");
const { reviewBill, requestApproval, decide, payBill } = await import("../src/guard.js");
const { scanPitch, claimedRate } = await import("../src/redflags.js");
const { findProduct } = await import("../src/products.js");

test("normal bill is fine to pay, once", () => {
  assert.equal(reviewBill("bill-oct-water").verdict, "ok_to_pay");
  const first = payBill("bill-oct-water");
  assert.equal(first.status, "paid");
  const again = payBill("bill-oct-water");
  assert.equal(again.confirmation, first.confirmation, "never pays twice");
});

test("changed account and 4x amount hold the bill until family approves", () => {
  const r = reviewBill("bill-oct-power");
  assert.equal(r.verdict, "hold");
  assert.ok(r.reasons.some((x) => x.includes("account to pay changed")));
  assert.ok(r.reasons.some((x) => x.includes("times the usual")));
  assert.equal(payBill("bill-oct-power").status, "blocked");
  const a = requestApproval({ subject_id: "bill-oct-power", summary: "Power bill" });
  assert.equal(requestApproval({ subject_id: "bill-oct-power", summary: "again" }).approval_id, a.approval_id, "asking twice reuses the request");
  assert.equal(payBill("bill-oct-power", a.approval_id).status, "waiting");
  decide(a.approval_id, "deny");
  assert.equal(payBill("bill-oct-power", a.approval_id).status, "denied");
});

test("classic scam pitch is high risk", () => {
  const p = "A man called me out of the blue. 12% guaranteed, risk-free, but only today. Keep this between us and pay with gift cards.";
  const s = scanPitch(p);
  assert.equal(s.level, "high");
  for (const id of ["guarantee", "high_return", "pressure", "secrecy", "odd_payment", "unsolicited"]) assert.ok(s.flags.some((f) => f.id === id), id);
  assert.equal(claimedRate(p), 12);
  assert.equal(scanPitch("My bank offered a 12-month CD.").level, "none");
});

test("product lookup prefers the specific product", () => {
  assert.equal(findProduct("they want me in a variable annuity"), "variable_annuity");
  assert.equal(findProduct("an annuity"), "fixed_annuity");
  assert.equal(findProduct("T-bills"), "treasury_bill");
  assert.equal(findProduct("crypto"), null);
});
