// Plain-language explanations of common products older Americans are pitched.
// General education, not advice. Each card links to the regulator's own explainer.

export const PRODUCTS = {
  treasury_bill: {
    name: "Treasury bill (T-bill)",
    aliases: ["t-bill", "t bill", "treasury bill", "treasury", "t-bills"],
    plain: "A short loan to the US government, from 4 weeks to 1 year. You buy it below face value and get the full amount back at the end.",
    good_for: "Money you want safe and available within a year.",
    risks: ["If you sell before it ends, the price can be a little lower.", "The return is fixed, so it can fall behind inflation."],
    ask: ["Am I buying it directly at TreasuryDirect, or through a broker, and what is the fee?"],
    learn_more: "https://www.treasurydirect.gov/marketable-securities/treasury-bills/",
  },
  cd: {
    name: "Certificate of deposit (CD)",
    aliases: ["cd", "certificate of deposit", "certificate"],
    plain: "You leave money at a bank for a set time and get a fixed rate. Insured by the FDIC up to $250,000 per bank, per owner.",
    good_for: "Money you will not need until the CD ends.",
    risks: ["Taking money out early usually costs a penalty.", "A 'brokered CD' sold by a broker can lose value if sold early."],
    ask: ["Is the bank FDIC-insured, and what is the early-withdrawal penalty?", "Is this a bank CD or a brokered CD?"],
    learn_more: "https://www.investor.gov/introduction-investing/investing-basics/investment-products/certificates-deposit-cds",
  },
  fixed_annuity: {
    name: "Fixed annuity",
    aliases: ["annuity", "fixed annuity", "income annuity"],
    plain: "A contract with an insurance company. You pay in, and it promises a set rate or a stream of income. It is not FDIC-insured; the promise depends on the insurer.",
    good_for: "People who want guaranteed lifetime income and will not need the money back soon.",
    risks: ["Surrender charges if you take money out in the first years, often 7 to 10 years.", "Your money can be locked up for a long time."],
    ask: ["What is the surrender charge each year, and for how many years?", "How much commission does the seller earn?", "What is the insurer's financial-strength rating?"],
    learn_more: "https://www.investor.gov/introduction-investing/investing-basics/investment-products/insurance-products/annuities",
  },
  variable_annuity: {
    name: "Variable annuity",
    aliases: ["variable annuity"],
    plain: "An insurance contract whose value goes up and down with the investments inside it, usually funds that hold stocks and bonds.",
    good_for: "Long-term savers who have already used up tax-advantaged accounts like a 401(k) or IRA.",
    risks: ["Fees often add up to 2% to 3% a year or more.", "You can lose money.", "Surrender charges if you leave early."],
    ask: ["What are all the yearly fees added together?", "What do I lose if I leave in year 1, 3 or 5?"],
    learn_more: "https://www.investor.gov/introduction-investing/investing-basics/investment-products/insurance-products/variable-annuities",
  },
  bond: {
    name: "Bond or bond fund",
    aliases: ["bond", "bonds", "bond fund", "corporate bond", "municipal bond"],
    plain: "A loan to a company or government that pays interest. A bond fund holds many bonds and its price moves every day.",
    good_for: "Steadier income than stocks, for money you can leave for a few years.",
    risks: ["When interest rates rise, bond prices fall.", "A company can fail to pay back.", "A bond fund has no fixed end date or fixed price."],
    ask: ["Who is borrowing the money, and what is their credit rating?", "What are the yearly fees?"],
    learn_more: "https://www.investor.gov/introduction-investing/investing-basics/investment-products/bonds-or-fixed-income-products/bonds",
  },
};

export function findProduct(text) {
  const t = text.toLowerCase();
  // Longest alias first, so "variable annuity" wins over "annuity".
  const all = Object.entries(PRODUCTS).flatMap(([id, p]) => p.aliases.map((a) => [a, id])).sort((a, b) => b[0].length - a[0].length);
  const hit = all.find(([a]) => new RegExp(`\\b${a.replace(/[-\s]/g, "[-\\s]?")}\\b`).test(t));
  return hit ? hit[1] : null;
}
