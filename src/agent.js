// The voice assistant behind the Alexa+ simulator. It is an MCP client of our own /mcp endpoint,
// exactly as Alexa+ would be. Claude picks the tools when it is configured (Amazon Bedrock or the
// Claude API); otherwise a small scripted router does, so judges can run the demo with no key at all.

import Anthropic, { betaRefusalFallbackMiddleware, BetaFallbackState } from "@anthropic-ai/sdk";
import { AnthropicBedrockMantle } from "@anthropic-ai/bedrock-sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { household } from "./guard.js";
import { scanPitch } from "./redflags.js";
import { findProduct } from "./products.js";
import { internalToken } from "./oauth.js";

const MODEL = process.env.MG_MODEL || "claude-opus-5-5";
const FALLBACK = process.env.MG_FALLBACK_MODEL || "claude-opus-4-8"; // Bedrock only: used if MODEL declines
const MAX_TURNS = 8; // budget cap: tool rounds per spoken request

const SYSTEM = `You are Money Guardian, a voice assistant on an Alexa+ device for an older adult in the US.
Speak in short, warm, plain sentences: at most two sentences, about 35 words. No lists, no markdown: this is read aloud.
You help the person check investment offers and pay household bills safely. Use the tools; never guess facts.
Each tool result has a "say" field written for the listener; build your reply from it and keep its warnings. Its "more" field holds the details: use it only when the person asks why or wants more.
Rules you never break:
- Never pay a bill whose review says "hold" until the family request for it is approved. If blocked, offer to ask the trusted contact.
- Never pay a bill twice. If a payment is "maybe_paid", tell the person to check with the payee.
- When a register or rate source could not be read, say you could not check. Never say it is fine.
- You give information, not financial advice. Say so when you discuss an investment.
- Do not repeat full account numbers. The last four digits are fine.`;

// Where Claude runs. Amazon Bedrock when MG_BEDROCK_REGION is set: AWS credentials come from the
// standard AWS chain (an IAM role when hosted), never from this repository. The Claude API when
// ANTHROPIC_API_KEY is set. Neither: the scripted router.
export const provider = () => (process.env.MG_BEDROCK_REGION ? "bedrock" : process.env.ANTHROPIC_API_KEY ? "anthropic" : null);
export const mode = () => (provider() ? "claude" : "scripted");

async function connect(mcpUrl) {
  const client = new Client({ name: "alexa-plus-simulator", version: "0.1.0" });
  // The simulator stands in for Alexa+ on this same server, so it carries the server's own token.
  await client.connect(new StreamableHTTPClientTransport(new URL(mcpUrl), { requestInit: { headers: { Authorization: `Bearer ${internalToken()}` } } }));
  return client;
}

const dmy = (ymd) => new Date(`${ymd}T12:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

const sayOf = (result) => result.structuredContent?.say ?? result.content?.[0]?.text ?? "";

// ---------- Claude mode ----------

let ai;
function claude() {
  if (ai) return ai;
  // MG_AI_BASE_URL and MG_AI_SKIP_AUTH exist for the tests, which run against a fake API on localhost.
  const common = { baseURL: process.env.MG_AI_BASE_URL || undefined, maxRetries: 1, timeout: 30_000 }; // a voice reply can't wait long
  if (provider() === "bedrock") {
    // Server-side fallbacks are not available on Bedrock, so the SDK middleware retries a declined request on FALLBACK.
    const onBedrock = (m) => (m.includes("anthropic.") ? m : `anthropic.${m}`);
    ai = {
      client: new AnthropicBedrockMantle({ ...common, awsRegion: process.env.MG_BEDROCK_REGION, skipAuth: process.env.MG_AI_SKIP_AUTH === "1",
        middleware: [betaRefusalFallbackMiddleware([{ model: onBedrock(FALLBACK) }])] }),
      model: onBedrock(MODEL), extra: {},
    };
  } else {
    // Claude API: if the model declines, the API retries on a fallback model itself.
    ai = { client: new Anthropic(common), model: MODEL, extra: { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" } };
  }
  return ai;
}

async function claudeTurn(client, session, text, trace) {
  const { client: api, model, extra } = claude();
  const history = session.history;
  session.fallbackState ||= new BetaFallbackState(); // Bedrock: stay on the fallback model once it was needed
  const { tools: mcpTools } = await client.listTools();
  const tools = mcpTools.map((t) => ({ name: t.name, description: t.description || t.title || t.name, input_schema: t.inputSchema }));
  history.push({ role: "user", content: text });

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const response = await api.beta.messages.create({
      model,
      max_tokens: 16000,
      output_config: { effort: "low" }, // voice: answer fast
      system: SYSTEM,
      tools,
      messages: history,
      ...extra,
    }, provider() === "bedrock" ? { fallbackState: session.fallbackState } : undefined);
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
  if (/power|electric|light/.test(t)) return h.pending_bills.find((b) => /power|electric/.test(b.payee))?.id;
  if (/water/.test(t)) return h.pending_bills.find((b) => /water/.test(b.payee))?.id;
  return null;
}

// Capitalised words that are never a seller: sentence openers, and names we already know.
const OPENERS = new Set(["a", "an", "the", "is", "are", "can", "could", "would", "will", "should", "check", "look", "who", "what", "how", "did", "does", "do", "has", "have",
  "i", "i'm", "i've", "my", "he", "she", "they", "we", "you", "it", "this", "that", "please", "tell", "yes", "no", "hi", "hello", "somebody", "someone", "mr", "mrs", "ms", "dr"]);
const KNOWN = /^(anna|margaret|ohio|columbus|power|water|co|medicare|treasury|t-bill|facebook|instagram|whatsapp|telegram|zelle|venmo|paypal|fdic|sec|finra|irs|amazon|alexa|bank|church|bitcoin|us|usa|america|american)$/i;
const NOT_NAME_WORDS = /^(registered|licensed|legit|real|a|an|the|my|broker|adviser|advisor|firm|company|for|me|please|out|up|bill|bills|bank|scam|safe|is|again)$/i;

function sellerName(text) {
  // "a man named Victor Langston", "a firm called Apex": one word is enough after these.
  const NAME = "([A-Z][\\w.&'-]*(?:\\s+[A-Z][\\w.&'-]*){0,3})";
  const named = text.match(new RegExp(`\\b(?:named|called)\\s+(?:is\\s+|was\\s+)?${NAME}`));
  if (named && !KNOWN.test(named[1])) return named[1].replace(/[.,]$/, "");

  // Otherwise, a run of two to four capitalised words that is not an opener or a name we know.
  let run = [];
  const runs = [];
  for (const raw of text.split(/\s+/)) {
    const word = raw.replace(/^["'(]+|["'),.!?;:]+$/g, "");
    if (/^[A-Z][\w&'-]*$/.test(word)) run.push(word);
    else { runs.push(run); run = []; }
    if (/[,.!?;:]$/.test(raw)) { runs.push(run); run = []; }
  }
  runs.push(run);
  for (let r of runs) {
    while (r.length && OPENERS.has(r[0].toLowerCase())) r = r.slice(1);
    if (r.length >= 2 && r.length <= 4 && !r.some((w) => KNOWN.test(w))) return r.join(" ");
  }

  // Typed in lower case: "check victor langston", "who is rex halvorsen".
  const low = text.trim().match(/^(?:please\s+)?(?:check(?: on)?|look up|lookup|search for|who is|who's)\s+(.+?)[.?!]*$/i);
  if (low) {
    const words = low[1].split(/\s+/).filter((w) => !NOT_NAME_WORDS.test(w));
    if (words.length >= 2 && words.length <= 3 && words.every((w) => /^[a-z][a-z'-]+$/i.test(w) && !OPENERS.has(w.toLowerCase()) && !KNOWN.test(w))) {
      return words.map((w) => w[0].toUpperCase() + w.slice(1)).join(" ");
    }
  }
  return null;
}

// Whole-utterance ways of asking for the details of the last answer.
const MORE = /^(?:(?:can|could) you |please )?(?:tell me more|more|why|why not|why is that|how do you know|how can you tell|what makes you (?:say|think) (?:that|so)|what do you mean|(?:more )?details|say more|go on|explain(?: that| it| why| more)?)(?: about (?:that|it|this))?$/;
const YES = /^(yes|yeah|yep|yup|sure|ok|okay|please|please do|do it|do that|go ahead|go on then|alright|all right|absolutely|of course|definitely|good idea)\b/;
const NO = /^(no|nope|not now|not yet|no thanks|no thank you|don't|do not|never mind|nevermind)\b/;
const MONEY_TALK = /%|\bpercent\b|\b(scam|invest\w*|opportunit\w*|crypto|bitcoin|forex|trading|stocks?|shares|gold|silver|real estate|put money into|guarantee\w*|returns?|savings|retirement|nest egg|fund|profits?|offer\w*|deal|lottery|prize|won)\b/;

async function payFlow(client, state, trace, bill, contact) {
  const approval = state.held_bill === bill ? state.approval_id : undefined;
  const r = await call(client, trace, "pay_bill", { bill_id: bill, ...(approval ? { approval_id: approval } : {}) });
  if (r.status === "blocked") {
    const rev = await call(client, trace, "review_bills", { bill_id: bill });
    Object.assign(state, { held_bill: bill, held_offer: null, held_reasons: rev.reasons, held_amount: rev.amount_usd, held_summary: `${rev.payee} bill, $${rev.amount_usd?.toFixed(2)}, due ${dmy(rev.due)}`, offer: "ask" });
    return `${rev.say} Shall I ask ${contact}?`;
  }
  state.offer = null;
  if (r.status === "paid" && state.held_bill === bill) Object.assign(state, { held_bill: null, approval_id: null });
  return r.say;
}

async function scriptedTurn(client, state, text, trace) {
  const t = text.toLowerCase().trim().replace(/[.!?]+$/, "");
  const contact = household().trusted_contact.name;
  const offer = state.offer; // what we just offered: "ask" (tell the family) or "pay"
  const flags = scanPitch(text);
  const product = findProduct(t);

  // Courtesy.
  if (/^(thanks|thank you|ty)\b/.test(t) && t.split(/\s+/).length <= 6) return "You're welcome. I'm here whenever you need me.";

  // "No" to what we just offered.
  if (offer && NO.test(t)) {
    state.offer = null;
    if (offer === "pay") return "Okay, I won't pay it yet.";
    return `Okay, I won't ask ${contact}. ${state.held_bill ? "I'll keep holding that bill." : "Please don't send any money until you're sure."}`;
  }

  // Details of the last answer, only when asked.
  if (MORE.test(t) || (/\btell me more\b/.test(t) && !product)) return state.more || "That's all I have on it.";

  // Did the family answer?
  if (state.approval_id && /\b(answer\w*|repl\w*|respond\w*|approv\w*|decid\w*|said|say|news|hear|heard|back to me|get back|got back|gotten back|word from)\b/.test(t) && /\b(did|has|have|what|any|is there|do you know)\b/.test(t)) {
    const a = await call(client, trace, "approval_status", { approval_id: state.approval_id });
    if (a.status === "approved" && state.held_bill) { state.offer = "pay"; return `${a.say} Shall I pay it now?`; }
    return a.say;
  }

  // Ask the trusted contact about the held item. "I can't tell my kids" is a pitch, not a request.
  const askFamily = new RegExp(`\\b(ask|tell|check with|send (it )?to|call|text|message|email|contact|ring|let)\\b.*\\b(${contact.toLowerCase()}|daughter|son|family|her|kids?|children)\\b`).test(t);
  const subject = state.held_bill || state.held_offer;
  if ((YES.test(t) && offer === "ask") || (askFamily && (subject || flags.level === "none"))) {
    if (!subject) return `What would you like me to ask ${contact} about?`;
    const a = await call(client, trace, "request_family_approval", {
      subject_id: subject, summary: state.held_summary || subject, reasons: state.held_reasons || [], amount_usd: state.held_amount ?? undefined,
    });
    state.approval_id = a.approval_id; state.offer = null;
    return a.say;
  }

  // "Yes" to "Shall I pay it now?"
  if (YES.test(t) && offer === "pay" && state.held_bill) return payFlow(client, state, trace, state.held_bill, contact);

  // Pay a bill. "Pay a fee to collect your prize" is a pitch, so red flags win.
  if (flags.level === "none" && /\b(pay|send (the )?(money|payment)|take care of|settle)\b/.test(t)) {
    const bill = whichBill(t) || (/\b(it|that)\b/.test(t) ? state.held_bill : null);
    if (bill) return payFlow(client, state, trace, bill, contact);
    const r = await call(client, trace, "review_bills", {});
    return `${r.say} Which one should I pay?`;
  }

  // Explain a product: "What's an annuity?", "Are CDs safe?". An offer with red flags is a pitch instead.
  if (product && flags.level === "none" && /\b(what|what's|explain|tell me|how|safe|good|idea|worth|risk\w*|should|are|is|work|mean)\b/.test(t)) {
    return (await call(client, trace, "explain_product", { product: text })).say;
  }

  // Bills overview.
  if (/\bbills?\b|\bdue\b|\bowe\b|\bpayments?\b/.test(t)) {
    const r = await call(client, trace, "review_bills", {});
    const hold = r.bills?.find((b) => b.verdict === "hold");
    if (hold) Object.assign(state, { held_bill: hold.bill_id, held_offer: null, held_reasons: hold.reasons, held_amount: hold.amount_usd, held_summary: `${hold.payee} bill, $${hold.amount_usd.toFixed(2)}, due ${dmy(hold.due)}`, offer: null });
    return r.say;
  }

  // A bank in an offer.
  const bank = text.match(/\b([A-Z][\w&'-]*(?:\s+[A-Z][\w&'-]*){0,3}\s+Bank)\b/);
  if (bank && /\b(real|insured|fdic|legit|safe|check|trust\w*)\b/.test(t)) return (await call(client, trace, "check_bank", { bank: bank[1] })).say;

  // An investment offer: scan the words, and check the seller if we heard a name.
  const name = sellerName(text);
  if (flags.level !== "none" || MONEY_TALK.test(t) || (name && /\b(money|\$\d)/.test(t))) {
    const parts = [];
    const [p, seller] = await Promise.all([
      call(client, trace, "check_pitch", { pitch: text }),
      name ? call(client, trace, "check_seller", { name }) : null,
    ]);
    if (seller) parts.push(seller.say);
    parts.push(p.say);
    if (p.risk === "high" || seller?.status === "not_found") {
      Object.assign(state, { held_offer: "offer-" + (name || "unknown").toLowerCase().replace(/\W+/g, "-"), held_bill: null, held_reasons: [...(seller?.status === "not_found" ? [`${name} is not registered to sell investments`] : []), ...p.flags.map((f) => f.label)], held_amount: null, held_summary: `Investment offer${name ? ` from ${name}` : ""}: "${text.slice(0, 160)}"`, offer: "ask" });
      parts.push(`Please don't send money. Shall I tell ${contact}?`);
    }
    return parts.join(" ");
  }

  // A name on its own: check registration.
  if (name) return (await call(client, trace, "check_seller", { name })).say;
  if (/\b(check|look up|who is|registered|licensed|legit)\b/.test(t)) return "Who should I look up? Tell me their full name.";

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
    let reply;
    let used = mode();
    if (used === "claude") {
      const before = s.history.length;
      try {
        reply = await claudeTurn(client, s, text, trace);
      } catch (e) {
        // The AI is unreachable or misconfigured: answer with the scripted router rather than not at all.
        // Drop this turn's partial history, so a tool call without its result never reaches the API again.
        console.error(`Claude unavailable (${provider()}): ${e.status ?? ""} ${e.message}`);
        s.history.length = before;
        used = "scripted";
      }
    }
    if (used === "scripted") reply = await scriptedTurn(client, s.state, text, trace);
    // A screen device shows the card each tool names in its _meta (MCP Apps), next to the reply.
    const cards = await toolCards(client);
    for (const t of trace) if (cards[t.tool]) t.ui = cards[t.tool];
    // Who is selling comes before what they said.
    const order = (x) => (x.tool === "check_seller" ? 0 : 1);
    const more = [...trace].sort((a, b) => order(a) - order(b)).map((x) => x.result?.more).filter(Boolean).join(" ");
    if (more) s.state.more = more;
    return { reply, trace, mode: used };
  } finally {
    await client.close();
  }
}

// tool name -> the ui:// card it names, read once from tools/list as a host would.
let cardsByTool;
async function toolCards(client) {
  if (!cardsByTool) {
    const { tools } = await client.listTools();
    cardsByTool = Object.fromEntries(tools.filter((t) => t._meta?.ui?.resourceUri).map((t) => [t.name, t._meta.ui.resourceUri]));
  }
  return cardsByTool;
}

/** Read a ui:// card over MCP (resources/read), as an Alexa+ device with a screen would. */
export async function readCard({ uri, mcpUrl }) {
  const client = await connect(mcpUrl);
  try {
    const { contents } = await client.readResource({ uri });
    return contents[0];
  } finally {
    await client.close();
  }
}

export function resetSession(sessionId) {
  sessions.delete(sessionId);
}
