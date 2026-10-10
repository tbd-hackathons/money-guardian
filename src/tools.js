// The Money Guardian MCP tools. Each returns plain sentences for the voice reply plus the raw facts and sources.

import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { searchRegisters, treasuryBillYields, fdicBank, ATTRIBUTION } from "./sources.js";
import { scanPitch, claimedRate } from "./redflags.js";
import { PRODUCTS, findProduct } from "./products.js";
import { reviewBill, requestApproval, approvalStatus, payBill, household } from "./guard.js";

const spokenDate = (ymd) => new Date(`${ymd}T12:00:00Z`).toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "UTC" });

const NOT_ADVICE = "This is general information to help you check, not financial advice.";

const reply = (say, data) => ({
  content: [{ type: "text", text: JSON.stringify({ say, ...data }, null, 2) }],
  structuredContent: { say, ...data },
});

async function bestBillYield() {
  try {
    const y = await treasuryBillYields();
    const top = y.bills.reduce((a, b) => (b.yield_pct > (a?.yield_pct ?? -1) ? b : a), null);
    return { ...y, top };
  } catch (e) {
    return { error: `Treasury rates unavailable this time: ${e.message}` };
  }
}

export function buildServer() {
  const server = new McpServer({ name: "money-guardian", version: "0.1.0" });

  server.registerTool("check_seller", {
    title: "Check a seller's registration",
    description: "Look up a person or firm selling investments in FINRA BrokerCheck and the SEC adviser register. Use when someone was pitched an investment by a named person or company.",
    inputSchema: { name: z.string().min(2).describe("Seller's name as the person heard it"), kind: z.enum(["individual", "firm", "any"]).default("any") },
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, async ({ name, kind }) => {
    const { matches, errors } = await searchRegisters(name, kind);
    if (errors.length && !matches.length) {
      return reply(`I could not reach the registers just now, so I can't say whether ${name} is registered. Please don't decide until we can check.`, { status: "unreadable", errors, attribution: ATTRIBUTION });
    }
    if (!matches.length) {
      return reply(`I found no one named ${name} registered to sell investments or give investment advice in the US. Selling securities without registration is illegal. Please do not send money.`, { status: "not_found", matches, errors, attribution: ATTRIBUTION });
    }
    const flagged = matches.filter((m) => m.has_disclosures);
    const say = matches.length > 1
      ? `I found ${matches.length} registered people or firms with that name. Ask the seller for their CRD number so we check the right one.${flagged.length ? ` ${flagged.length} of them have disclosures, such as complaints or regulatory actions.` : ""}`
      : `${matches[0].name} is registered (CRD ${matches[0].crd}).${matches[0].has_disclosures ? " Their record has disclosures, such as complaints or regulatory actions. Read them before deciding." : " Their record shows no disclosures."}`;
    return reply(say, { status: "found", matches, errors, attribution: ATTRIBUTION });
  });

  server.registerTool("check_pitch", {
    title: "Check what a seller said",
    description: "Scan the words of an investment offer for the red flags regulators warn about, and compare any promised return with today's risk-free Treasury bill rate.",
    inputSchema: { pitch: z.string().min(5).describe("What the person was told, in their own words") },
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, async ({ pitch }) => {
    const scan = scanPitch(pitch);
    const rate = claimedRate(pitch);
    const y = await bestBillYield();
    const parts = [];
    if (scan.flags.length) parts.push(`I heard ${scan.flags.length} warning sign${scan.flags.length > 1 ? "s" : ""}: ${scan.flags.map((f) => f.label.toLowerCase()).join("; ")}.`);
    if (rate != null && y.top) parts.push(`They promised ${rate}%. A US Treasury bill, which is backed by the government, paid about ${y.top.yield_pct.toFixed(2)}% at its latest sale, on ${spokenDate(y.top.auction_date)}. Anything far above that carries real risk, whatever they say.`);
    if (scan.level === "high") parts.push("This matches how investment scams usually sound. Please don't send money, and let's tell your family.");
    if (!parts.length) parts.push("I didn't hear the usual warning signs. It's still worth checking the seller's registration before you decide.");
    return reply(`${parts.join(" ")} ${NOT_ADVICE}`, { risk: scan.level, flags: scan.flags, claimed_rate_pct: rate, treasury: y });
  });

  server.registerTool("explain_product", {
    title: "Explain an investment product",
    description: "Explain a product in plain words (Treasury bill, CD, fixed or variable annuity, bond or bond fund), its risks, the questions to ask, and today's Treasury bill rate for comparison.",
    inputSchema: { product: z.string().min(2).describe("The product as the person named it, e.g. 'an annuity'") },
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, async ({ product }) => {
    const id = findProduct(product);
    if (!id) return reply(`I don't have a plain explanation for "${product}" yet. I can explain Treasury bills, CDs, fixed or variable annuities, and bonds.`, { known: Object.keys(PRODUCTS) });
    const p = PRODUCTS[id];
    const y = await bestBillYield();
    const rateLine = y.top ? ` For comparison, a ${y.top.term} Treasury bill paid about ${y.top.yield_pct.toFixed(2)}% at its latest sale, on ${spokenDate(y.top.auction_date)}.` : "";
    return reply(`${p.name}: ${p.plain} The main risk: ${p.risks[0]} A good question to ask: ${p.ask[0]}${rateLine} ${NOT_ADVICE}`, { product: { id, ...p }, treasury: y });
  });

  server.registerTool("check_bank", {
    title: "Check a bank is FDIC-insured",
    description: "Check whether a bank named in an offer is an active FDIC-insured bank.",
    inputSchema: { bank: z.string().min(2) },
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, async ({ bank }) => {
    try {
      const r = await fdicBank(bank);
      const say = r.banks.length ? `${r.banks[0].name} in ${r.banks[0].city}, ${r.banks[0].state} is an active FDIC-insured bank.` : `I found no active FDIC-insured bank named ${bank}. Be careful: fake "banks" are common in scams.`;
      return reply(say, r);
    } catch (e) {
      return reply(`I couldn't reach the FDIC just now, so I can't confirm ${bank}.`, { status: "unreadable", error: e.message });
    }
  });

  server.registerTool("review_bills", {
    title: "Review bills before paying",
    description: "List the household's pending bills, or check one bill against past payments for unusual amounts, changed payment accounts, and the approval limit.",
    inputSchema: { bill_id: z.string().optional().describe("Leave empty to list pending bills") },
    annotations: { readOnlyHint: true },
  }, async ({ bill_id }) => {
    if (!bill_id) {
      const bills = household().pending_bills.map((b) => reviewBill(b.id));
      const holds = bills.filter((b) => b.verdict === "hold");
      return reply(`You have ${bills.length} bills due. ${holds.length ? `${holds.length} looks unusual: ${holds.map((b) => b.payee).join(", ").replace(/\.$/, "")}.` : "They all look normal."}`, { bills });
    }
    const r = reviewBill(bill_id);
    return reply(r.error || (r.verdict === "hold" ? `Let's not pay this yet. ${r.reasons.join(" ")} ${r.next_step}` : `${r.payee}, $${r.amount_usd.toFixed(2)}, looks normal.`), r);
  });

  server.registerTool("request_family_approval", {
    title: "Ask the trusted family member",
    description: "Ask the household's trusted contact to approve a payment or an investment before any money moves. Asking twice returns the same request.",
    inputSchema: { subject_id: z.string().describe("The bill id, or a short id for the investment offer"), summary: z.string(), reasons: z.array(z.string()).default([]), amount_usd: z.number().optional() },
  }, async (args) => {
    const a = requestApproval(args);
    return reply(`I've asked ${a.asked}, your ${a.relation}, to look at this. Nothing goes ahead until ${a.asked} answers.`, a);
  });

  server.registerTool("approval_status", {
    title: "Check the family's answer",
    description: "See whether the trusted contact has approved or declined a request.",
    inputSchema: { approval_id: z.string() },
    annotations: { readOnlyHint: true },
  }, async ({ approval_id }) => {
    const a = approvalStatus(approval_id);
    const say = a.error || ({ pending: `${a.asked} hasn't answered yet.`, approved: `${a.asked} approved it.`, denied: `${a.asked} said no.` })[a.status];
    return reply(say, a);
  });

  server.registerTool("pay_bill", {
    title: "Pay a bill",
    description: "Pay a pending bill. Unusual bills need an approved family request first. Never pays the same bill twice. Payments are simulated in this demo.",
    inputSchema: { bill_id: z.string(), approval_id: z.string().optional() },
    annotations: { destructiveHint: true, idempotentHint: true },
  }, async ({ bill_id, approval_id }) => {
    const r = payBill(bill_id, approval_id);
    const say = r.error || ({
      paid: r.note || `Paid. Confirmation ${r.confirmation}.`,
      blocked: `I won't pay this yet. ${r.reasons?.[0] || ""} ${r.next_step}`,
      waiting: r.next_step, denied: r.next_step, maybe_paid: r.note,
    })[r.status];
    return reply(say, r);
  });

  return server;
}
