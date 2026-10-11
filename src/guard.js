// Bill checks and the family approval ledger.
// Rules from the agent-automation playbook: a payment counts only once it is confirmed,
// an unclear result is recorded as "maybe paid" and never retried blindly, and nothing pays twice.

import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { currentDemo } from "./demo.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const HOUSEHOLD = process.env.MG_HOUSEHOLD || join(ROOT, "fixtures", "household.json");
const LEDGER = process.env.MG_LEDGER || join(ROOT, "data", "ledger.json");
// One ledger per hosted-demo visitor; the shared one when no demo id is given (local use, other MCP clients).
const ledgerPath = () => (currentDemo() ? join(dirname(LEDGER), "demos", `${currentDemo()}.json`) : LEDGER);

export function household() {
  return JSON.parse(readFileSync(HOUSEHOLD, "utf8"));
}

function loadLedger() {
  const path = ledgerPath();
  if (!existsSync(path)) return { approvals: {}, payments: {} };
  return JSON.parse(readFileSync(path, "utf8"));
}

function saveLedger(l) {
  const path = ledgerPath();
  mkdirSync(dirname(path), { recursive: true });
  const tmp = path + ".tmp";
  writeFileSync(tmp, JSON.stringify(l, null, 2));
  renameSync(tmp, path); // atomic: a crash never leaves half a ledger
}

const median = (xs) => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

/** Check one bill against the household's own history. */
export function reviewBill(billId) {
  const h = household();
  const bill = h.pending_bills.find((b) => b.id === billId);
  if (!bill) return { error: `No pending bill ${billId}`, pending: h.pending_bills.map((b) => b.id) };
  const payee = h.payees.find((p) => p.id === bill.payee);
  const past = h.history.filter((x) => x.payee === bill.payee).map((x) => x.amount);
  const usual = past.length ? median(past) : null;
  const reasons = [];
  if (usual && bill.amount > usual * 2) reasons.push(`This bill is $${bill.amount.toFixed(2)}, about ${(bill.amount / usual).toFixed(1)} times the usual $${usual.toFixed(2)}.`);
  if (payee && bill.pay_to_account_last4 !== payee.account_last4) reasons.push(`The account to pay changed: it was ending ${payee.account_last4}, now ending ${bill.pay_to_account_last4}.`);
  if (bill.note && /email|text|call/i.test(bill.note) && /updat|chang/i.test(bill.note)) reasons.push(`The payment details were changed by a message: "${bill.note}" This is a common scam.`);
  if (bill.amount >= h.approval_threshold_usd) reasons.push(`It is over the $${h.approval_threshold_usd} limit Margaret set for paying without a check.`);
  const paid = loadLedger().payments[billId];
  return {
    bill_id: bill.id, payee: payee?.name || bill.payee, amount_usd: bill.amount, due: bill.due,
    usual_amount_usd: usual, past_payments: past.length,
    verdict: reasons.length ? "hold" : "ok_to_pay",
    reasons,
    already: paid ? paid.status : null,
    next_step: paid?.status === "paid" ? "Already paid. Do not pay again."
      : reasons.length ? `Hold the payment and ask ${h.trusted_contact.name} (${h.trusted_contact.relation}) to approve.` : "Fine to pay.",
  };
}

/** Ask the trusted contact to approve. Idempotent per subject: asking twice returns the same request. */
export function requestApproval({ subject_id, summary, reasons = [], amount_usd = null }) {
  const h = household();
  const l = loadLedger();
  const open = Object.values(l.approvals).find((a) => a.subject_id === subject_id && a.status === "pending");
  if (open) return { ...open, note: "An approval request for this is already waiting." };
  const a = {
    approval_id: randomUUID().slice(0, 8), subject_id, summary, reasons, amount_usd,
    status: "pending", asked: h.trusted_contact.name, relation: h.trusted_contact.relation,
    created_at: new Date().toISOString(), decided_at: null,
  };
  l.approvals[a.approval_id] = a;
  saveLedger(l);
  return a;
}

export function approvalStatus(approvalId) {
  return loadLedger().approvals[approvalId] || { error: `No approval ${approvalId}` };
}

export function listApprovals() {
  return Object.values(loadLedger().approvals).sort((a, b) => b.created_at.localeCompare(a.created_at));
}

/** Attach the family's case brief to a request (see brief.js). It advises only: decide() ignores it. */
export function attachBrief(approvalId, brief) {
  const l = loadLedger();
  const a = l.approvals[approvalId];
  if (!a) return null;
  a.brief = brief;
  saveLedger(l);
  return a;
}

export function decide(approvalId, decision) {
  const l = loadLedger();
  const a = l.approvals[approvalId];
  if (!a) return { error: `No approval ${approvalId}` };
  if (a.status !== "pending") return a;
  a.status = decision === "approve" ? "approved" : "denied";
  a.decided_at = new Date().toISOString();
  saveLedger(l);
  return a;
}

/**
 * Pay a bill. Payment is simulated (no bank connection in this demo), but the bookkeeping is real:
 * "paying" is recorded first, then "paid" with a confirmation, so a crash leaves "maybe paid", never a double payment.
 */
export function payBill(billId, approvalId = null) {
  const review = reviewBill(billId);
  if (review.error) return review;
  const l = loadLedger();
  const prior = l.payments[billId];
  if (prior?.status === "paid") return { ...prior, note: "Already paid. Not paying twice." };
  if (prior?.status === "paying") return { ...prior, status: "maybe_paid", note: "A payment was started but not confirmed. Check with the payee before trying again." };
  if (review.verdict === "hold") {
    const a = approvalId ? l.approvals[approvalId] : null;
    if (!a || a.subject_id !== billId) return { status: "blocked", reasons: review.reasons, next_step: "Needs family approval first: call request_family_approval." };
    if (a.status !== "approved") return { status: a.status === "denied" ? "denied" : "waiting", approval_id: a.approval_id, next_step: a.status === "denied" ? `${a.asked} said no. Do not pay.` : `Waiting for ${a.asked}.` };
  }
  l.payments[billId] = { bill_id: billId, status: "paying", started_at: new Date().toISOString() };
  saveLedger(l);
  const confirmation = `SIM-${randomUUID().slice(0, 6).toUpperCase()}`;
  l.payments[billId] = { ...l.payments[billId], status: "paid", confirmation, paid_at: new Date().toISOString(), amount_usd: review.amount_usd };
  saveLedger(l);
  return l.payments[billId];
}

/** Demo only: start the story again with an empty ledger. */
export function resetLedger() {
  saveLedger({ approvals: {}, payments: {} });
}
