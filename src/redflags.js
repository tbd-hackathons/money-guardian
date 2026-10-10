// Red flags of investment fraud, written from the regulators' own warnings. Each flag names the page it comes from.

const FINRA = "https://www.finra.org/investors/protect-your-money/avoid-fraud/red-flags-fraud";
const SEC_PONZI = "https://www.investor.gov/protect-your-investments/fraud/types-fraud/ponzi-scheme";
const SEC_ENDORSE = "https://www.investor.gov/news-alerts/investor-alerts/investor-alert-beware-investment-offers-implying-sec-endorsement";
const SEC_CRYPTO = "https://www.investor.gov/introduction-investing/general-resources/news-alerts/alerts-bulletins/investor-alerts/investor-alert-watch-out-fraudulent-digital-asset-and-crypto-trading-websites";

export const FLAGS = [
  { id: "guarantee", label: "A guaranteed return", weight: 3, source: FINRA,
    why: "Every investment carries some risk. A promise of a fixed outcome is a warning sign.",
    patterns: [/\bguarantee[ds]?\b/i, /\brisk[- ]free\b/i, /\bno risk\b/i, /\bzero risk\b/i, /\bcan'?t lose\b/i, /\babsolutely safe\b/i] },
  { id: "high_return", label: "An unusually high return", weight: 2, source: SEC_PONZI,
    why: "High returns with little risk are a classic sign of a Ponzi scheme.",
    patterns: [/\b(1[0-9]|[2-9][0-9])(\.\d+)?\s?(%|percent\b)/i, /\bdouble your money\b/i] },
  { id: "pressure", label: "Pressure to act right now", weight: 2, source: FINRA,
    why: "Scammers rush you so you cannot check them out or ask anyone.",
    patterns: [/\b(today only|only today)\b/i, /\bact (now|fast|quickly)\b/i, /\bright now\b/i, /\blimited time\b/i, /\bbefore (it'?s|the) (gone|too late)\b/i, /\bonly \w+ spots?\b/i, /\bexpires? (today|tonight)\b/i] },
  { id: "secrecy", label: "A request to keep it secret", weight: 3, source: FINRA,
    why: "A real professional will never ask you to keep secrets or hide it from family.",
    patterns: [/\bkeep (this|it) (between us|secret|quiet)\b/i, /\bdon'?t tell\b/i, /\bconfidential opportunity\b/i] },
  { id: "recruit", label: "A request to bring in others", weight: 2, source: FINRA,
    why: "Asking you to recruit friends is a sign of a pyramid or Ponzi scheme.",
    patterns: [/\b(bring|refer|recruit) (in )?(your )?(friends|family|others)\b/i, /\breferral bonus\b/i] },
  { id: "unsolicited", label: "An offer you did not ask for", weight: 1, source: FINRA,
    why: "Cold calls, texts and social media offers are how most scams start.",
    patterns: [/\b(called|texted|messaged|emailed) me\b/i, /\bout of the blue\b/i, /\bcold call\b/i, /\bon (facebook|instagram|whatsapp|telegram)\b/i] },
  { id: "odd_payment", label: "Payment by gift card, wire, crypto or a payment app", weight: 3, source: SEC_CRYPTO,
    why: "Scammers ask for payments that are hard to trace and hard to reverse.",
    patterns: [/\bgift cards?\b/i, /\bwire (it|the money|transfer)\b/i, /\b(bitcoin|crypto|usdt|tether)\b/i, /\bzelle\b/i, /\bcash ?app\b/i, /\bwestern union\b/i, /\bmoneygram\b/i] },
  { id: "fake_endorsement", label: "A claim of government approval", weight: 3, source: SEC_ENDORSE,
    why: "The SEC never endorses an investment. Saying it does is false.",
    patterns: [/\b(sec|government|federal) (approved|endorsed|backed|insured)\b/i, /\bapproved by the (sec|government)\b/i] },
  { id: "fees_to_withdraw", label: "A fee to get your money out", weight: 3, source: SEC_CRYPTO,
    why: "Being asked to pay taxes or fees to withdraw 'profits' is a known scam step.",
    patterns: [/\b(pay|fee|tax)\b.{0,30}\b(withdraw|release|unlock)\b/i, /\bunlock (your|the) (funds|profits)\b/i] },
];

/** Find red flags in what the person was told. Returns the flags with the words that triggered them. */
export function scanPitch(text) {
  const hits = [];
  for (const f of FLAGS) {
    const quotes = f.patterns.map((p) => text.match(p)?.[0]).filter(Boolean);
    if (quotes.length) hits.push({ id: f.id, label: f.label, why: f.why, heard: [...new Set(quotes)], source_url: f.source, weight: f.weight });
  }
  const score = hits.reduce((s, h) => s + h.weight, 0);
  const level = score >= 5 ? "high" : score >= 2 ? "medium" : hits.length ? "low" : "none";
  return { level, flags: hits.map(({ weight, ...h }) => h) };
}

/** Pull a claimed yearly return out of the pitch, e.g. "12% guaranteed" -> 12. */
export function claimedRate(text) {
  const m = text.match(/(\d{1,2}(?:\.\d+)?)\s?(%|percent)/i);
  return m ? Number(m[1]) : null;
}
