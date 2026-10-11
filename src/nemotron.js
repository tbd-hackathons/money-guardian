// NVIDIA Nemotron on Nebius Token Factory: three open models, each used where it fits.
//
//   fast   Nemotron 3.5 Lightning (30B, 3B active). The voice turn: picks the tools and says two short sentences.
//   judge  Nemotron 3 Super (120B, 12B active). Reads regulator pages and decides whether one warns about this exact seller.
//   deep   Nemotron 3 Ultra (550B, 55B active). Writes the family's case brief, off the voice path, so nobody waits for it.
//
// Token Factory speaks the OpenAI chat-completions protocol, so this is plain fetch and no SDK: any
// OpenAI-compatible server (vLLM, NIM, a Nebius dedicated endpoint) can stand in by changing the base URL.
// On when NEBIUS_API_KEY is set. MG_NEBIUS_BASE_URL also exists for the tests, which run against a fake API on localhost.

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

// Reasoning models may think out loud. The listener only ever hears the answer.
const stripThinking = (s) => (typeof s === "string" ? s.replace(/<think>[\s\S]*?<\/think>/g, "").replace(/^[\s\S]*?<\/think>/, "").trim() : "");

/**
 * One chat completion on a tier. Returns the message and what it cost: model, milliseconds, tokens.
 * Throws on any HTTP error or timeout; callers decide what an honest fallback is.
 */
export async function complete(tier, { messages, tools, json = false, maxTokens = 1024, temperature, timeoutMs = 20_000 }) {
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
