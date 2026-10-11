# Money Guardian

A voice assistant for older adults in the US, built as an MCP server for Alexa+. It checks investment offers before money moves and holds unusual bills until a family member says yes.

In 2025, Americans aged 60 and over reported US$7.75 billion in losses to the FBI. Investment fraud was the largest part, at US$3.52 billion ([FBI IC3 2025 Internet Crime Report](https://www.ic3.gov/AnnualReport/Reports/2025_IC3Report.pdf)). The scams often start with a call, a text or a social media message, and the person has no quick way to check what they were told.

## What it does

Margaret, 78, says: *"A man named Victor Langston called me. He says I'm guaranteed 18% a year, but only today, and I should keep it between us."*

Money Guardian answers in one breath:

> Victor Langston is not registered to sell investments. This sounds like a scam: a guaranteed return and a request for secrecy. They promised 18%; safe Treasury bills pay about 4.6%. Please don't send money. Shall I tell Anna?

Behind that answer:

1. **Hears the red flags** the regulators warn about: a guaranteed return, pressure to act now, secrecy. Each flag links to the FINRA or SEC page it comes from.
2. **Compares the promise with a safe rate.** It reads the latest Treasury bill auction results from TreasuryDirect, live.
3. **Checks the seller** in FINRA BrokerCheck and the SEC adviser register. The registers search loosely ("Rex Halvorsen" also returns a Rebecca Wittrock), so a result counts only when every word of the name Margaret heard is in that person's name or a former name. Anything else is shown as "a different person", never as the seller.
4. **Asks Anna**, her daughter, on Anna's own phone. Nothing goes ahead until Anna answers.

It does the same for bills. The October power bill is 3.9 times the usual amount, and the account to pay was changed by email. Money Guardian holds it, asks Anna, and pays only after she approves. It never pays the same bill twice.

## Run it

Needs Node.js 20 or later. No accounts and no API keys.

```bash
npm install
make run
```

Open http://127.0.0.1:8790 for the Alexa+ simulator, and http://127.0.0.1:8790/family for Anna's phone. Click the example phrases in order, or type or talk (Chrome supports the microphone).

```bash
make test
```

### Hosting

```bash
docker build -t money-guardian . && docker run -p 8790:8790 money-guardian
```

The image runs anywhere Docker runs. Each visitor gets their own demo household (`?demo=<id>` in the
address), so judges never see each other's approvals. POST requests are limited to 30 a minute per
visitor (`MG_RATE_PER_MIN`); behind a proxy set `TRUST_PROXY=1`. `GET /healthz` reports status.

### Modes

- **Scripted (default).** A small router chooses the tools. Nothing to sign up for.
- **Claude on Amazon Bedrock.** Set `MG_BEDROCK_REGION` (for example `us-east-1`) and Claude chooses the tools and phrases the reply. AWS credentials come from the standard AWS chain: an IAM role when hosted, `aws configure` on a laptop. Default model `claude-opus-5-5` (`MG_MODEL`); if it declines a request, the SDK retries on `claude-opus-4-8` (`MG_FALLBACK_MODEL`).
- **Claude API.** Or set `ANTHROPIC_API_KEY`. Server-side fallback is on: if the model declines, the API retries on a fallback model.
- **If the AI fails** (no access yet, network, a timeout), that turn is answered by the scripted router instead of an error. `GET /healthz` reports which AI is configured.

In both modes the simulator is an MCP client of the server's own `/mcp` endpoint, the same way Alexa+ calls it.

## MCP tools

Endpoint: `POST /mcp` (Streamable HTTP, stateless, spec 2025-11-25).

| Tool | What it does | Source |
|---|---|---|
| `check_seller` | Is this person or firm registered to sell investments or give advice? | FINRA BrokerCheck, SEC IAPD |
| `check_pitch` | Red flags in what was said, and the promised return against today's T-bill rate | FINRA, investor.gov, TreasuryDirect |
| `explain_product` | A Treasury bill, CD, annuity or bond in plain words, with its risks and the questions to ask | investor.gov, TreasuryDirect |
| `check_bank` | Is this bank an active FDIC-insured bank? | FDIC BankFind |
| `review_bills` | Pending bills against the household's own history | Household data |
| `request_family_approval` | Ask the trusted contact. Asking twice returns the same request. | Ledger |
| `approval_status` | Has the trusted contact answered? | Ledger |
| `pay_bill` | Pays a bill once. A held bill needs an approved request. | Ledger (payment simulated) |

**A card for screens (MCP Apps).** Every tool names one card in `_meta.ui.resourceUri`: `ui://money-guardian/card.html`, served as `text/html;profile=mcp-app` ([SEP-1865](https://github.com/modelcontextprotocol/ext-apps)). An Alexa+ device with a screen shows it next to the spoken reply: the verdict, the promised return against the T-bill rate, the bills to hold, who was asked. The card loads nothing from the network; the host hands it the tool result, and links open through the host. The simulator is such a host: it reads the card over MCP and runs it in a sandboxed frame. Hosts without screens ignore the card and still get the full answer as text.

## How it stays safe

- **A failed check is not a pass.** If a register cannot be read, the reply says "I couldn't reach the registers", never "not registered" or "it looks fine" (a test enforces it). If only one of the two registers answers, the reply says what that one found and that the check is not complete.
- **Money counts once it is confirmed.** A payment is recorded as "paying", then "paid" with a confirmation. If it stops between the two, the next attempt reports "maybe paid" and does not pay again.
- **Anna can answer by email.** With Amazon SES set up (see `.env.example`), a new request emails Anna a link. Opening the link changes nothing; only pressing Approve or Say no on that page decides, because mail scanners open links by themselves. Each link is signed and expires after 7 days. Visitors of the hosted demo never trigger email, and sending is capped per hour.
- **The assistant cannot approve its own request.** Approving is not an MCP tool; only Anna's page calls the approval API. In this demo that page has no login: anyone holding a demo's link can answer for Anna, but only inside that one demo household. On a laptop the server listens on 127.0.0.1 only. A real deployment needs Anna to sign in.
- **Budget cap.** At most 8 tool rounds per spoken request.
- **Fast enough for Alexa+ (500 ms per tool).** Over HTTP, every tool answers in 2 to 5 ms, except a seller check, which waits on FINRA. The SEC register and the list of every FDIC-insured bank are held locally; Treasury rates are refreshed in the background. FINRA BrokerCheck has no bulk file, so it is read live: from Virginia it answers in about 150 ms (measured with Globalping from Ashburn, VA, 11 Oct 2026). The Docker image sets `MG_LIVE_BUDGET_MS=400`: a slower FINRA answer is not waited for, the reply gives the SEC result and says FINRA did not answer, and the late answer is cached for the next ask. Locally the budget is off, so a demo far from the US still gets FINRA's full answer.
- **Short answers, details on request.** Spoken answers stay under 40 words (a test enforces it). "Tell me more" gives the details and the sources.
- **Not advice.** Product explanations and the details of every investment check say they are general information, not financial advice.

## Data and attribution

- FINRA BrokerCheck, read live to check a single named seller, at a low rate, with a 10-minute cache. Set `MG_USER_AGENT` with a contact address.
- SEC Investment Adviser Public Disclosure, from the SEC's daily [compilation files](https://adviserinfo.sec.gov/compilation): every investment adviser representative and adviser firm (441,534 people and 43,727 firms on 10 Oct 2026). `scripts/build-sec-index.mjs` reduces the three files (about 190 MB compressed) to `registers/sec-iapd.tsv.gz` (12 MB): name, other names, CRD, current firms, disclosures, status. A lookup takes under a millisecond and never touches the SEC's site. To refresh, download the latest files listed in the [manifest](https://reports.adviserinfo.sec.gov/reports/CompilationReports/CompilationReports.manifest.json) and run the script on them.
- TreasuryDirect auction results (`TA_WS/securities/auctioned`). The rate shown is the investment rate at the latest auction for each term.
- FDIC BankFind Suite API.
- Red-flag wording comes from FINRA's "Red Flags of Fraud" and the SEC investor alerts linked in `src/redflags.js`.

The household in `fixtures/household.json` is fictional. Payments are simulated: there is no bank connection.

## Built during the hackathon

Everything in this repository was written for the Amazon Developer Hackathon (Alexa+ track), starting 10 Oct 2026.

## License

MIT
