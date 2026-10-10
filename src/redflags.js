// Red flags of investment fraud, written from the regulators' own warnings. Each flag names the page it comes from.

const FINRA = "https://www.finra.org/investors/protect-your-money/avoid-fraud/red-flags-fraud";
const SEC_PONZI = "https://www.investor.gov/protect-your-investments/fraud/types-fraud/ponzi-scheme";
const SEC_ENDORSE = "https://www.investor.gov/news-alerts/investor-alerts/investor-alert-beware-investment-offers-implying-sec-endorsement";
const FTC_PRIZE = "https://consumer.ftc.gov/articles/fake-prize-sweepstakes-and-lottery-scams";
const SEC_CRYPTO = "https://www.investor.gov/introduction-investing/general-resources/news-alerts/alerts-bulletins/investor-alerts/investor-alert-watch-out-fraudulent-digital-asset-and-crypto-trading-websites";

export const FLAGS = [
  { id: "guarantee", short: "a guaranteed return", label: "A guaranteed return", weight: 3, source: FINRA,
    why: "Every investment carries some risk. A promise of a fixed outcome is a warning sign.",
    patterns: [/\bguarantee[ds]?\b/i, /\brisk[- ]free\b/i, /\bno risk\b/i, /\bzero risk\b/i, /\bcan'?t lose\b/i, /\babsolutely safe\b/i] },
  { id: "high_return", short: "a return far above safe rates", label: "An unusually high return", weight: 2, source: SEC_PONZI,
    why: "High returns with little risk are a classic sign of a Ponzi scheme.",
    patterns: [/\b(1[0-9]|[2-9][0-9])(\.\d+)?\s?(%|percent\b)/i, /\b\d+(\.\d+)?\s?(%|percent) (a|per|every) (month|week)\b/i, /\bdouble (your|my|their|his|her) money\b/i, /\bget rich\b/i] },
  { id: "pressure", short: "pressure to decide now", label: "Pressure to act right now", weight: 2, source: FINRA,
    why: "Scammers rush you so you cannot check them out or ask anyone.",
    patterns: [/\b(today only|only today)\b/i, /\bact (now|fast|quickly)\b/i, /\bright now\b/i, /\blimited time\b/i, /\bbefore (it'?s|the) (gone|too late)\b/i, /\bonly \w+ spots?\b/i, /\bexpires? (today|tonight)\b/i] },
  { id: "secrecy", short: "a request for secrecy", label: "A request to keep it secret", weight: 3, source: FINRA,
    why: "A real professional will never ask you to keep secrets or hide it from family.",
    patterns: [/\bkeep (this|it) (between us|a secret|secret|quiet)\b/i, /\bsecret from\b/i, /\bdon'?t tell\b/i, /\b(can'?t|cannot|not to|shouldn'?t|mustn'?t) tell (my|your|anyone|anybody|the)\b/i, /\bconfidential opportunity\b/i] },
  { id: "recruit", short: "a request to recruit others", label: "A request to bring in others", weight: 2, source: FINRA,
    why: "Asking you to recruit friends is a sign of a pyramid or Ponzi scheme.",
    patterns: [/\b(bring|refer|recruit) (in )?(your )?(friends|family|others)\b/i, /\breferral bonus\b/i] },
  { id: "unsolicited", short: "an offer out of the blue", label: "An offer you did not ask for", weight: 1, source: FINRA,
    why: "Cold calls, texts and social media offers are how most scams start.",
    patterns: [/\b(called|texted|messaged|emailed) me\b/i, /\bout of the blue\b/i, /\bcold call\b/i, /\bon (facebook|instagram|whatsapp|telegram)\b/i] },
  { id: "odd_payment", short: "a hard-to-trace way to pay", label: "Payment by gift card, wire, crypto or a payment app", weight: 3, source: SEC_CRYPTO,
    why: "Scammers ask for payments that are hard to trace and hard to reverse.",
    patterns: [/\bgift cards?\b/i, /\bwire (it|the money|money|funds|transfer|\$?\d)/i, /\b(bitcoin|crypto|usdt|tether)\b/i, /\bzelle\b/i, /\bcash ?app\b/i, /\bwestern union\b/i, /\bmoneygram\b/i] },
  { id: "fake_endorsement", short: "a false claim of government approval", label: "A claim of government approval", weight: 3, source: SEC_ENDORSE,
    why: "The SEC never endorses an investment. Saying it does is false.",
    patterns: [/\b(sec|government|federal) (approved|endorsed|backed|insured)\b/i, /\bapproved by the (sec|government)\b/i] },
  { id: "fees_to_withdraw", short: "a fee to get your money out", label: "A fee to get your money out", weight: 3, source: SEC_CRYPTO,
    why: "Being asked to pay taxes or fees to withdraw 'profits' is a known scam step.",
    patterns: [/\b(pay|fee|tax)\b.{0,30}\b(withdraw|release|unlock)\b/i, /\bunlock (your|the) (funds|profits)\b/i] },
  { id: "prize_fee", short: "a fee to collect a prize", label: "A fee to collect a prize", weight: 5, source: FTC_PRIZE,
    why: "Real prizes are free. Being asked to pay first to collect one is a scam.",
    patterns: [/\b(won|win|winner|prize|lottery|sweepstakes)\b.{0,60}\b(fee|taxes|pay|send)\b/i] },
];

// "twenty-five percent" -> "25 percent", so spoken numbers are read like written ones.
const UNITS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9 };
const TEENS = { ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19 };
const TENS = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
export function spokenNumbers(text) {
  return text
    .replace(new RegExp(`\\b(${Object.keys(TENS).join("|")})(?:[-\\s](${Object.keys(UNITS).join("|")}))?\\b`, "gi"), (_, t, u) => String(TENS[t.toLowerCase()] + (u ? UNITS[u.toLowerCase()] : 0)))
    .replace(new RegExp(`\\b(${[...Object.keys(TEENS), ...Object.keys(UNITS)].join("|")})(?=\\s?(%|percent))`, "gi"), (w) => String(TEENS[w.toLowerCase()] ?? UNITS[w.toLowerCase()]));
}

/** Find red flags in what the person was told. Returns the flags with the words that triggered them. */
export function scanPitch(text) {
  text = spokenNumbers(text);
  const hits = [];
  for (const f of [...FLAGS].sort((a, b) => b.weight - a.weight)) {
    const quotes = f.patterns.map((p) => text.match(p)?.[0]).filter(Boolean);
    if (quotes.length) hits.push({ id: f.id, short: f.short, label: f.label, why: f.why, heard: [...new Set(quotes)], source_url: f.source, weight: f.weight });
  }
  const score = hits.reduce((s, h) => s + h.weight, 0);
  const level = score >= 5 ? "high" : score >= 2 ? "medium" : hits.length ? "low" : "none";
  return { level, flags: hits.map(({ weight, ...h }) => h) };
}

/** Pull a claimed yearly return out of the pitch, e.g. "12% guaranteed" -> 12. */
export function claimedRate(text) {
  return claimedReturn(text)?.annual_pct ?? null;
}

/** The promised return as heard, and per year: "2% a month" -> { heard: "2% a month", annual_pct: 24 }. */
export function claimedReturn(text) {
  const m = spokenNumbers(text).match(/(\d{1,2}(?:\.\d+)?)\s?(%|percent)(?:\s(?:a|per|every)\s(month|week))?/i);
  if (!m) return null;
  const per = m[3]?.toLowerCase();
  const n = Number(m[1]);
  return { heard: per ? `${n}% a ${per}` : `${n}%`, annual_pct: per === "month" ? n * 12 : per === "week" ? n * 52 : n };
}
