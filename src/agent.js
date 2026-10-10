// The voice assistant behind the Alexa+ simulator. It is an MCP client of our own /mcp endpoint,
// exactly as Alexa+ would be. With ANTHROPIC_API_KEY set, Claude picks the tools; without it,
// a small scripted router does, so judges can run the demo with no key at all.

import Anthropic from "@anthropic-ai/sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { household } from "./guard.js";

const MODEL = process.env.MG_MODEL || "claude-opus-5-5";
const MAX_TURNS = 8; // budget cap: tool rounds per spoken request

const SYSTEM = `You are Money Guardian, a voice assistant on an Alexa+ device for an older adult in the US.
Speak in short, warm, plain sentences. Two to four sentences per reply. No lists, no markdown: this is read aloud.
You help the person check investment offers and pay household bills safely. Use the tools; never guess facts.
Each tool result has a "say" field written for the listener. Build your reply from it; keep its warnings.
Rules you never break:
- Never pay a bill whose review says "hold" until the family request for it is approved. If blocked, offer to ask the trusted contact.
- Never pay a bill twice. If a payment is "maybe_paid", tell the person to check with the payee.
- When a register or rate source could not be read, say you could not check. Never say it is fine.
- You give information, not financial advice. Say so when you discuss an investment.
- Do not repeat full account numbers. The last four digits are fine.`;

export const mode = () => (process.env.ANTHROPIC_API_KEY ? "claude" : "scripted");

async function connect(mcpUrl) {
  const client = new Client({ name: "alexa-plus-simulator", version: "0.1.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(mcpUrl)));
  return client;
}

const dmy = (ymd) => new Date(`${ymd}T12:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

const sayOf = (result) => result.structuredContent?.say ?? result.content?.[0]?.text ?? "";

// ---------- Claude mode ----------

let anthropic;
async function claudeTurn(client, history, text, trace) {
  anthropic ||= new Anthropic();
  const { tools: mcpTools } = await client.listTools();
  const tools = mcpTools.map((t) => ({ name: t.name, description: t.description || t.title || t.name, input_schema: t.inputSchema }));
  history.push({ role: "user", content: text });

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const response = await anthropic.beta.messages.create({
      model: MODEL,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default", // retry on a substitute model if the requested one declines
      max_tokens: 16000,
      output_config: { effort: "low" }, // voice: answer fast
      system: SYSTEM,
      tools,
      messages: history,
    });
    history.push({ role: "assistant", content: response.content });

    if (response.stop_reason === "refusal") return "I'm sorry, I can't help with that one.";
    if (response.stop_reason === "pause_turn") continue;
    if (response.stop_reason !== "tool_use") {
      return response.content.filter((b) => b.type === "text").map((b) => b.text).join(" ").trim();
    }

    const results = [];
    for (const block of response.content.filter((b) => b.type === "tool_use")) {
      const r = await client.callTool({ name: block.name, arguments: block.input });
      trace.push({ tool: block.name, args: block.input, result: r.structuredContent });
      results.push({ type: "tool_result", tool_use_id: block.id, content: r.content, is_error: !!r.isError });
    }
    history.push({ role: "user", content: results }); // every result in one message
  }
  return "I need to stop here. Let's try that again in a moment.";
}

// ---------- Scripted mode (no key) ----------

const call = async (client, trace, name, args = {}) => {
  const r = await client.callTool({ name, arguments: args });
  trace.push({ tool: name, args, result: r.structuredContent });
  return r.structuredContent || {};
};

function whichBill(text) {
  const t = text.toLowerCase();
  const h = household();
  for (const b of h.pending_bills) {
    const payee = h.payees.find((p) => p.id === b.payee);
    const words = [b.payee, payee?.name || "", ...(payee?.aliases || [])].join(" ").toLowerCase().split(/[\s-]+/).filter((w) => w.length > 3);
    if (words.some((w) => t.includes(w))) return b.id;
  }
  if (/power|electric/.test(t)) return h.pending_bills.find((b) => /power|electric/.test(b.payee))?.id;
  if (/water/.test(t)) return h.pending_bills.find((b) => /water/.test(b.payee))?.id;
  return null;
}

function sellerName(text) {
  const m = text.match(/\b(?:named|called|from|man|woman|guy|lady|advisor|adviser|broker|company|firm)\s+(?:is\s+|was\s+)?([A-Z][\w.&'-]*(?:\s+[A-Z][\w.&'-]*){0,3})/);
  return m ? m[1].replace(/[.,]$/, "") : null;
}

async function scriptedTurn(client, state, text, trace) {
  const t = text.toLowerCase();
  const contact = household().trusted_contact.name;

  // Did the family answer?
  if (/\b(answer|answered|reply|replied|approve[ds]?|say yes|said)\b/.test(t) && state.approval_id && /\b(did|has|have|what)\b/.test(t)) {
    const a = await call(client, trace, "approval_status", { approval_id: state.approval_id });
    if (a.status === "approved" && state.held_bill) return `${a.say} Shall I pay it now? Just say "pay it".`;
    return a.say;
  }

  // Ask the trusted contact about the held item.
  if (new RegExp(`\\b(ask|tell|check with|send (it )?to)\\b.*\\b(${contact.toLowerCase()}|daughter|son|family)\\b`).test(t) || (/^(yes|yes please|please do|ok|okay)\b/.test(t) && state.offer === "ask")) {
    const subject = state.held_bill || state.held_offer;
    if (!subject) return `What would you like me to ask ${contact} about?`;
    const a = await call(client, trace, "request_family_approval", {
      subject_id: subject, summary: state.held_summary || subject, reasons: state.held_reasons || [], amount_usd: state.held_amount ?? undefined,
    });
    state.approval_id = a.approval_id; state.offer = null;
    return a.say;
  }

  // Pay a bill.
  if (/\bpay\b/.test(t)) {
    const bill = whichBill(t) || (/\bit\b/.test(t) ? state.held_bill : null);
    if (!bill) {
      const r = await call(client, trace, "review_bills", {});
      return `${r.say} Which one should I pay?`;
    }
    const approval = state.held_bill === bill ? state.approval_id : undefined;
    const r = await call(client, trace, "pay_bill", { bill_id: bill, ...(approval ? { approval_id: approval } : {}) });
    if (r.status === "blocked") {
      const rev = await call(client, trace, "review_bills", { bill_id: bill });
      Object.assign(state, { held_bill: bill, held_offer: null, held_reasons: rev.reasons, held_amount: rev.amount_usd, held_summary: `${rev.payee} bill, $${rev.amount_usd?.toFixed(2)}, due ${dmy(rev.due)}`, offer: "ask" });
      return `${rev.say} Shall I ask ${contact}?`;
    }
    if (r.status === "paid" && state.held_bill === bill) Object.assign(state, { held_bill: null, approval_id: null });
    return r.say;
  }

  // Bills overview.
  if (/\bbills?\b|\bdue\b|\bowe\b/.test(t)) {
    const r = await call(client, trace, "review_bills", {});
    const hold = r.bills?.find((b) => b.verdict === "hold");
    if (hold) {
      Object.assign(state, { held_bill: hold.bill_id, held_offer: null, held_reasons: hold.reasons, held_amount: hold.amount_usd, held_summary: `${hold.payee} bill, $${hold.amount_usd.toFixed(2)}, due ${dmy(hold.due)}`, offer: null });
      return `${r.say} ${hold.reasons[0]} I'd hold that one.`;
    }
    return r.say;
  }

  // Explain a product.
  if (/\b(what is|what's|what are|explain|tell me about|how does)\b/.test(t) && /\b(annuit|t-?bill|treasury|cd|certificate|bond)/.test(t)) {
    return (await call(client, trace, "explain_product", { product: text })).say;
  }

  // A bank in an offer.
  const bank = text.match(/\b([A-Z][\w&'-]*(?:\s+[A-Z][\w&'-]*){0,3}\s+Bank)\b/);
  if (bank && /\b(real|insured|fdic|legit|check)\b/.test(t)) return (await call(client, trace, "check_bank", { bank: bank[1] })).say;

  // An investment offer: scan the words, then check the seller if we heard a name.
  if (/%|percent|guarantee|invest|return|opportunit|crypto|bitcoin|offer|deal/.test(t)) {
    const parts = [];
    const name = sellerName(text);
    const [p, seller] = await Promise.all([
      call(client, trace, "check_pitch", { pitch: text }),
      name ? call(client, trace, "check_seller", { name }) : null,
    ]);
    parts.push(p.say);
    if (seller) parts.push(seller.say);
    if (p.risk === "high") {
      Object.assign(state, { held_offer: "offer-" + (name || "unknown").toLowerCase().replace(/\W+/g, "-"), held_bill: null, held_reasons: p.flags.map((f) => f.label), held_amount: null, held_summary: `Investment offer${name ? ` from ${name}` : ""}: "${text.slice(0, 160)}"`, offer: "ask" });
      parts.push(`Would you like me to tell ${contact}?`);
    }
    return parts.join(" ");
  }

  // A name on its own: check registration.
  if (/\b(check|look up|is .* (real|registered|legit))\b/.test(t)) {
    const name = sellerName(text) || text.replace(/^.*?\b(check|look up)\b\s*/i, "").replace(/[?.!]$/, "");
    return (await call(client, trace, "check_seller", { name })).say;
  }

  return "I can check an investment offer, look up who is selling it, explain a product like an annuity, or review your bills before you pay. What would you like?";
}

// ---------- Sessions ----------

const sessions = new Map();

/** Handle one spoken request. Returns the reply to read aloud and the tool calls made. */
export async function chat({ sessionId, text, mcpUrl }) {
  const s = sessions.get(sessionId) || { history: [], state: {} };
  sessions.set(sessionId, s);
  const trace = [];
  const client = await connect(mcpUrl);
  try {
    const reply = mode() === "claude" ? await claudeTurn(client, s.history, text, trace) : await scriptedTurn(client, s.state, text, trace);
    return { reply, trace, mode: mode() };
  } finally {
    await client.close();
  }
}

export function resetSession(sessionId) {
  sessions.delete(sessionId);
}
