// NVIDIA Nemotron on Nebius Token Factory: three open models, each used where it fits.
//
//   fast   Nemotron 3.5 Lightning (30B, 3B active). The voice turn: picks the tools and says two short sentences.
//   judge  Nemotron 3 Super (120B, 12B active). Reads regulator pages and decides whether one warns about this exact seller.
//   deep   Nemotron 3 Ultra (550B, 55B active). Writes the family's case brief, off the voice path, so nobody waits for it.
//
// Token Factory speaks the OpenAI chat-completions protocol, so this is plain fetch and no SDK: any
// OpenAI-compatible server (vLLM, NIM, a Nebius dedicated endpoint) can stand in by changing the base URL.
// On when NEBIUS_API_KEY is set. MG_NEBIUS_BASE_URL also exists for the tests, which run against a fake API on localhost.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const TIERS = {
  fast: { env: "MG_NEMOTRON_FAST", model: "nvidia/Nemotron-3_5-Lightning", label: "Nemotron 3.5 Lightning" },
  judge: { env: "MG_NEMOTRON_JUDGE", model: "nvidia/nemotron-3-super-120b-a12b", label: "Nemotron 3 Super" },
  deep: { env: "MG_NEMOTRON_DEEP", model: "nvidia/Nemotron-3-Ultra-550b-a55b", label: "Nemotron 3 Ultra" },
};

export const nemotronEnabled = () => !!process.env.NEBIUS_API_KEY;
export const modelOf = (tier) => process.env[TIERS[tier].env] || TIERS[tier].model;
const labelOf = (model) => Object.values(TIERS).find((t) => t.model === model)?.label || model;
export const models = () => Object.fromEntries(Object.keys(TIERS).map((t) => [t, { model: modelOf(t), label: labelOf(modelOf(t)) }]));

const base = () => (process.env.MG_NEBIUS_BASE_URL || "https://api.tokenfactory.nebius.com/v1").replace(/\/+$/, "");

// Spending brakes for a public demo. Token Factory charges the card once the balance goes below zero, so the free
// credits last only if the app stops itself:
//   MG_NEMOTRON_DAILY_TOKENS  tokens per UTC day, so one busy day can't use up everything;
//   MG_NEMOTRON_TOTAL_USD     dollars in all, priced with PRICE below.
// Past either, no call is made, and every caller falls back as it does when Token Factory is down: scripted replies,
// the page-address rule for warnings, no case brief. What was spent is saved next to the ledger, so a restart keeps it.
// US$ per million tokens, input and output, from third-party listings of Token Factory (11 Oct 2026); check them in
// the console. Lightning's price is not confirmed, so it is priced like Super, and an unknown model like Ultra: too
// high is safe, too low is not.
const PRICE = { "nvidia/Nemotron-3_5-Lightning": [0.3, 0.9], "nvidia/nemotron-3-super-120b-a12b": [0.3, 0.9], "nvidia/Nemotron-3-Ultra-550b-a55b": [1, 3] };
const priceOf = (model) => PRICE[model] || [1, 3];
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const spendFile = () => join(dirname(process.env.MG_LEDGER || join(ROOT, "data", "ledger.json")), "nemotron-spend.json");
let spent;
function loadSpent() {
  if (!spent) { try { spent = JSON.parse(readFileSync(spendFile(), "utf8")); } catch { spent = {}; } }
  const day = new Date().toISOString().slice(0, 10);
  if (spent.day !== day) Object.assign(spent, { day, tokens: 0 });
  spent.usd ||= 0;
  return spent;
}
export function budget() {
  const perDay = Number(process.env.MG_NEMOTRON_DAILY_TOKENS || 0), total = Number(process.env.MG_NEMOTRON_TOTAL_USD || 0);
  if (!perDay && !total) return null;
  const s = loadSpent();
  return { ...(perDay ? { tokens_per_day: perDay, used_today: s.tokens } : {}), ...(total ? { usd_cap: total, usd_spent: Math.round(s.usd * 1e6) / 1e6 } : {}) };
}
function overBudget() {
  const b = budget();
  if (b?.tokens_per_day && b.used_today >= b.tokens_per_day) return "Today's Nemotron token budget is used up; it starts again at 00:00 UTC";
  if (b?.usd_cap && b.usd_spent >= b.usd_cap) return "This demo's Nemotron spending budget is used up";
  return null;
}
function addSpend(model, input, output) {
  if (!budget()) return;
  const s = loadSpent(), [pin, pout] = priceOf(model);
  s.tokens += input + output;
  s.usd += (input * pin + output * pout) / 1e6;
  try { mkdirSync(dirname(spendFile()), { recursive: true }); writeFileSync(spendFile(), JSON.stringify(s)); } catch (e) { console.error(`Could not save Nemotron spend: ${e.message}`); }
}

// Reasoning models may think out loud. The listener only ever hears the answer.
const stripThinking = (s) => (typeof s === "string" ? s.replace(/<think>[\s\S]*?<\/think>/g, "").replace(/^[\s\S]*?<\/think>/, "").trim() : "");

/**
 * One chat completion on a tier. Returns the message and what it cost: model, milliseconds, tokens.
 * Throws on any HTTP error or timeout; callers decide what an honest fallback is.
 */
export async function complete(tier, { messages, tools, json = false, maxTokens = 1024, temperature, timeoutMs = 20_000 }) {
  const over = overBudget();
  if (over) throw Object.assign(new Error(over), { budget: true });
  const model = modelOf(tier);
  const body = { model, messages, max_tokens: maxTokens };
  if (tools?.length) Object.assign(body, { tools, tool_choice: "auto" });
  if (json) body.response_format = { type: "json_object" };
  if (temperature != null) body.temperature = temperature;
  const started = Date.now();
  const res = await fetch(`${base()}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.NEBIUS_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).slice(0, 300);
    throw Object.assign(new Error(`Token Factory answered HTTP ${res.status}: ${detail}`), { status: res.status });
  }
  const data = await res.json();
  addSpend(model, data.usage?.prompt_tokens ?? 0, data.usage?.completion_tokens ?? 0);
  const choice = data.choices?.[0] || {};
  const message = { ...(choice.message || {}), content: stripThinking(choice.message?.content) };
  return {
    message,
    finish: choice.finish_reason || null,
    usage: { tier, model, label: labelOf(model), ms: Date.now() - started, input_tokens: data.usage?.prompt_tokens ?? null, output_tokens: data.usage?.completion_tokens ?? null },
  };
}

/** The JSON object in a model's answer, or null. Tolerates a code fence or a sentence around it. */
export function parseJson(text) {
  const s = String(text || "").trim();
  for (const candidate of [s, s.replace(/^```(?:json)?\s*|\s*```$/g, ""), s.slice(s.indexOf("{"), s.lastIndexOf("}") + 1)]) {
    try {
      const v = JSON.parse(candidate);
      if (v && typeof v === "object") return v;
    } catch {}
  }
  return null;
}
