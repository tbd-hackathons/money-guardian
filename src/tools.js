// The Money Guardian MCP tools. Each returns plain sentences for the voice reply plus the raw facts and sources.

import { readFileSync } from "node:fs";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { searchRegisters, treasuryBillYields, fdicBank, ATTRIBUTION } from "./sources.js";
import { scanPitch, claimedReturn } from "./redflags.js";
import { PRODUCTS, findProduct } from "./products.js";
import { reviewBill, requestApproval, approvalStatus, payBill, household } from "./guard.js";
import { notifyFamily } from "./notify.js";

const spokenDate = (ymd) => new Date(`${ymd}T12:00:00Z`).toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "UTC" });

const shortPayee = (name) => String(name).replace(/\s+(Co\.|Company|Inc\.?|LLC)$/i, "");

// The MCP App card (SEP-1865) a screen device shows next to the spoken reply. Hosts without MCP Apps
// ignore the _meta and still get the full answer in content and structuredContent.
export const CARD_URI = "ui://money-guardian/card.html";
export const CARD_MIME = "text/html;profile=mcp-app";
const CARD_HTML = readFileSync(new URL("../web/card.html", import.meta.url), "utf8");
const ui = { ui: { resourceUri: CARD_URI } };

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

  server.registerResource("money_guardian_card", CARD_URI, {
    title: "Money Guardian card",
    description: "The card a screen shows with each answer: the verdict, the key facts, and their official sources.",
    mimeType: CARD_MIME,
  }, async () => ({
    // No csp: the card loads nothing from the network, so the spec's most restrictive default applies.
    contents: [{ uri: CARD_URI, mimeType: CARD_MIME, text: CARD_HTML, _meta: { ui: { prefersBorder: true } } }],
  }));

  server.registerTool("check_seller", {
    title: "Check a seller's registration",
    description: "Look up a person or firm selling investments in FINRA BrokerCheck and the SEC adviser register. Use when someone was pitched an investment by a named person or company.",
    inputSchema: { name: z.string().min(2).describe("Seller's name as the person heard it"), kind: z.enum(["individual", "firm", "any"]).default("any") },
    annotations: { readOnlyHint: true, openWorldHint: true },
    _meta: ui,
  }, async ({ name, kind }) => {
    const { matches, similar = [], errors } = await searchRegisters(name, kind);
    const facts = { matches, similar, errors, attribution: ATTRIBUTION };
    // One register down, the other answered with nobody: say what we know, and that the check is incomplete.
    const failed = new Set(errors.map((e) => e.split(" (")[0]));
    const answered = ["FINRA BrokerCheck", "SEC IAPD"].filter((r) => !failed.has(r));
    if (errors.length && !matches.length && answered.length) {
      const [ok, down] = answered[0] === "FINRA BrokerCheck" ? ["FINRA", "the SEC adviser register"] : ["The SEC", "FINRA BrokerCheck"];
      return reply(`${ok} has nobody named ${name} registered to sell investments. I couldn't reach ${down}, so please don't decide yet.`,
        { status: "not_found_partial", answered, more: `Selling investments without registration is against the law. Ask for their CRD number, the ID every registered professional has. (${errors.join("; ")})`, ...facts });
    }
    if (errors.length && !matches.length) {
      return reply(`I couldn't reach the registers, so I can't check ${name} yet.`,
        { status: "unreadable", more: `The FINRA and SEC registers did not answer, so please don't decide until we can check. (${errors.join("; ")})`, ...facts });
    }
    if (!matches.length) {
      return reply(`${name} is not registered to sell investments.`,
        { status: "not_found", more: `Neither FINRA nor the SEC has anyone by that name${similar.length ? `; the closest was a different person, ${similar[0].name}` : ""}. Selling investments without registration is against the law.`, ...facts });
    }
    const flagged = matches.filter((m) => m.has_disclosures);
    if (matches.length > 1) {
      return reply(`There are ${matches.length} registered people or firms called ${name}. Ask for their CRD number so I can check the right one.`,
        { status: "several", more: `${flagged.length ? `${flagged.length} of them have disclosures, such as complaints or regulatory actions. ` : ""}A CRD number is the ID FINRA gives every registered person. A real professional will tell you theirs.`, ...facts });
    }
    const m = matches[0];
    return reply(`${m.name} is registered, CRD ${m.crd}. ${m.has_disclosures ? "Their record shows complaints or actions, so read it first." : "Their record shows no complaints."}`,
      { status: "found", more: `Registered with ${m.registers.join(" and ")}${m.current_firms?.length ? `, working for ${m.current_firms.join(", ")}` : ""}. Being registered does not make an offer a good one; check what they are selling too.`, ...facts });
  });

  server.registerTool("check_pitch", {
    title: "Check what a seller said",
    description: "Scan the words of an investment offer for the red flags regulators warn about, and compare any promised return with today's risk-free Treasury bill rate.",
    inputSchema: { pitch: z.string().min(5).describe("What the person was told, in their own words") },
    annotations: { readOnlyHint: true, openWorldHint: true },
    _meta: ui,
  }, async ({ pitch }) => {
    const scan = scanPitch(pitch);
    const promised = claimedReturn(pitch);
    const rate = promised?.annual_pct ?? null;
    const y = await bestBillYield();
    const top = scan.flags.filter((f) => f.id !== "high_return").slice(0, 2).map((f) => f.short);
    const list = top.length > 1 ? `${top[0]} and ${top[1]}` : top[0] || "a return far above safe rates";
    const vsSafe = rate != null && rate > 8 && y.top ? ` They promised ${promised.heard === `${rate}%` ? `${rate}%` : `${promised.heard}, about ${rate}% a year`}; safe Treasury bills pay about ${y.top.yield_pct.toFixed(1)}%.` : "";
    const say = scan.level === "high" ? `This sounds like a scam: ${list}.${vsSafe}`
      : scan.level === "medium" || scan.level === "low" ? `One thing worries me: ${list}. Let's check who is selling it first.`
      : "I didn't hear the usual warning signs. Let's still check who is selling it.";
    const rest = scan.flags.filter((f) => !top.includes(f.short) && f.id !== "high_return").map((f) => f.short);
    const more = [
      rate != null && y.top ? `A US Treasury bill paid ${y.top.yield_pct.toFixed(2)}% at its latest sale, on ${spokenDate(y.top.auction_date)}. A promise far above that is not safe, whatever they say.` : "",
      y.error ? "I couldn't read today's Treasury rate." : "",
      rest.length ? `I also heard ${rest.join(" and ")}.` : "",
      NOT_ADVICE,
    ].filter(Boolean).join(" ");
    return reply(say, { risk: scan.level, flags: scan.flags, claimed_rate_pct: rate, treasury: y, more });
  });

  server.registerTool("explain_product", {
    title: "Explain an investment product",
    description: "Explain a product in plain words (Treasury bill, CD, fixed or variable annuity, bond or bond fund), its risks, the questions to ask, and today's Treasury bill rate for comparison.",
    inputSchema: { product: z.string().min(2).describe("The product as the person named it, e.g. 'an annuity'") },
    annotations: { readOnlyHint: true, openWorldHint: true },
    _meta: ui,
  }, async ({ product }) => {
    const id = findProduct(product);
    if (!id) return reply(`I can explain Treasury bills, CDs, annuities and bonds. Which one?`, { known: Object.keys(PRODUCTS) });
    const p = PRODUCTS[id];
    const y = await bestBillYield();
    const more = [
      `It suits ${p.good_for.charAt(0).toLowerCase() + p.good_for.slice(1)}`,
      `Before you buy, ask: ${p.ask[0]}`,
      y.top ? `For comparison, a Treasury bill paid ${y.top.yield_pct.toFixed(2)}% at its latest sale.` : "",
      NOT_ADVICE,
    ].filter(Boolean).join(" ");
    const plainName = p.name.replace(/ \(.*\)$/, "").replace(/^(Fixed|Variable|Certificate|Bond)/, (w) => w.toLowerCase());
    return reply(`A ${plainName} is ${p.short}`, { product: { id, ...p }, treasury: y, more });
  });

  server.registerTool("check_bank", {
    title: "Check a bank is FDIC-insured",
    description: "Check whether a bank named in an offer is an active FDIC-insured bank.",
    inputSchema: { bank: z.string().min(2) },
    annotations: { readOnlyHint: true, openWorldHint: true },
    _meta: ui,
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
    _meta: ui,
  }, async ({ bill_id }) => {
    if (!bill_id) {
      const bills = household().pending_bills.map((b) => reviewBill(b.id));
      const holds = bills.filter((b) => b.verdict === "hold");
      const say = holds.length
        ? `You have ${bills.length} bills due. The ${holds.map((b) => shortPayee(b.payee)).join(" and ")} bill looks wrong, so I'd hold it.`
        : `You have ${bills.length} bills due, and they all look normal.`;
      return reply(say, { bills, more: bills.map((b) => `${b.payee}: $${b.amount_usd.toFixed(2)}, due ${spokenDate(b.due)}. ${b.reasons.join(" ") || "Looks normal."}`).join(" ") });
    }
    const r = reviewBill(bill_id);
    if (r.error) return reply(r.error, r);
    if (r.verdict !== "hold") return reply(`${shortPayee(r.payee)}, $${r.amount_usd.toFixed(2)}, looks normal.`, r);
    const why = [];
    if (r.usual_amount_usd && r.amount_usd > r.usual_amount_usd * 2) why.push(`it's ${(r.amount_usd / r.usual_amount_usd).toFixed(1)} times the usual amount`);
    if (r.reasons.some((x) => /account to pay changed/.test(x))) why.push(`the account changed${r.reasons.some((x) => /by a message/.test(x)) ? " by email" : ""}`);
    if (!why.length) why.push("it's over your approval limit");
    return reply(`Let's not pay this yet: ${why.join(", and ")}.`, { ...r, more: `${r.reasons.join(" ")} ${r.next_step}` });
  });

  server.registerTool("request_family_approval", {
    title: "Ask the trusted family member",
    description: "Ask the household's trusted contact to approve a payment or an investment before any money moves. Asking twice returns the same request.",
    inputSchema: { subject_id: z.string().describe("The bill id, or a short id for the investment offer"), summary: z.string(), reasons: z.array(z.string()).default([]), amount_usd: z.number().optional() },
    _meta: ui,
  }, async (args) => {
    const a = requestApproval(args);
    const email = a.note ? null : await notifyFamily(a); // a new request only: asking twice sends nothing twice
    const how = email?.sent ? "emailed" : "asked";
    return reply(`I've ${how} ${a.asked}, your ${a.relation}, to look at this. Nothing goes ahead until ${a.asked} answers.`, { ...a, ...(email ? { email } : {}) });
  });

  server.registerTool("approval_status", {
    title: "Check the family's answer",
    description: "See whether the trusted contact has approved or declined a request.",
    inputSchema: { approval_id: z.string() },
    annotations: { readOnlyHint: true },
    _meta: ui,
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
    _meta: ui,
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
