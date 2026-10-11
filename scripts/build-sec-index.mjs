// Builds registers/sec-iapd.tsv.gz from the SEC's daily IAPD compilation files: every investment
// adviser representative and adviser firm, reduced to what check_seller needs.
//
//   node scripts/build-sec-index.mjs IA_INDVL_Feed_<date>.xml.zip IA_FIRM_SEC_Feed_<date>.xml.gz IA_FIRM_STATE_Feed_<date>.xml.gz
//
// Download the files from https://adviserinfo.sec.gov/compilation (the list is at
// https://reports.adviserinfo.sec.gov/reports/CompilationReports/CompilationReports.manifest.json).
// The people file is a zip of ~1 GB of XML, so everything is streamed; nothing is held whole.

import { spawn } from "node:child_process";
import { createReadStream, createWriteStream, mkdirSync } from "node:fs";
import { createGunzip, createGzip } from "node:zlib";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";

const OUT = new URL("../registers/sec-iapd.tsv.gz", import.meta.url);

const ENT = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const unxml = (s) => s.replace(/&(#\d+|#x[0-9a-f]+|\w+);/gi, (m, e) =>
  e[0] === "#" ? String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : ENT[e] ?? m);
const attrs = (tag) => Object.fromEntries([...tag.matchAll(/(\w+)="([^"]*)"/g)].map(([, k, v]) => [k, unxml(v)]));
const clean = (s) => String(s || "").replace(/[\t\n\r|]/g, " ").replace(/\s+/g, " ").trim();
const fullName = (a) => clean([a.firstNm, a.midNm, a.lastNm, a.sufNm].filter(Boolean).join(" "));

/** Yield each <tag>...</tag> element of a large XML stream, decoded from ISO-8859-1. */
async function* elements(stream, tag) {
  const close = `</${tag}>`;
  let buf = "";
  for await (const chunk of stream) {
    buf += chunk.toString("latin1");
    let end;
    while ((end = buf.indexOf(close)) !== -1) {
      const start = buf.lastIndexOf(`<${tag}>`, end);
      yield buf.slice(start, end + close.length);
      buf = buf.slice(end + close.length);
    }
  }
}

// One line per person or firm: kind, CRD, name, other names, current firms, disclosures, status.
function person(xml) {
  const info = attrs(xml.match(/<Info [^>]*>/)[0]);
  const others = [...xml.matchAll(/<OthrNm [^>]*>/g)].map((m) => fullName(attrs(m[0]))).filter(Boolean);
  const firms = [...xml.matchAll(/<CrntEmp [^>]*>/g)].map((m) => clean(attrs(m[0]).orgNm)).filter(Boolean);
  const drp = /<DRP /.test(xml) ? "Y" : "N";
  return ["individual", info.indvlPK, fullName(info), others.join("|"), [...new Set(firms)].join("|"), drp, info.actvAGReg === "Y" ? "active" : "inactive"];
}

function firm(xml) {
  const info = attrs(xml.match(/<Info [^>]*>/)[0]);
  const rg = attrs(xml.match(/<Rgstn [^>]*>/)?.[0] || "");
  const item11 = [...xml.matchAll(/<Item11\w* [^>]*>/g)].some((m) => /="Y"/.test(m[0]));
  const names = [...new Set([clean(info.BusNm), clean(info.LegalNm)].filter(Boolean))];
  return ["firm", info.FirmCrdNb, names[0], names.slice(1).join("|"), "", item11 ? "Y" : "N", clean(`${rg.FirmType || ""} ${rg.St || ""}`).toLowerCase()];
}

async function main() {
  const [zip, ...firmFiles] = process.argv.slice(2);
  if (!zip || !firmFiles.length) throw new Error("usage: build-sec-index.mjs <IA_INDVL zip> <IA_FIRM gz>...");
  const generated = (zip.match(/(\d\d)_(\d\d)_(\d{4})/) || []).slice(1);
  const asOf = generated.length ? `${generated[2]}-${generated[0]}-${generated[1]}` : "unknown";

  const rows = [];
  const seen = new Set();
  const add = (r) => { const key = `${r[0]}:${r[1]}`; if (r[1] && r[2] && !seen.has(key)) { seen.add(key); rows.push(r); } };

  // unzip -p writes every file in the archive to stdout, one after another.
  const unzip = spawn("unzip", ["-p", zip], { stdio: ["ignore", "pipe", "inherit"] });
  for await (const x of elements(unzip.stdout, "Indvl")) add(person(x));
  for (const f of firmFiles) for await (const x of elements(createReadStream(f).pipe(createGunzip()), "Firm")) add(firm(x));

  const people = rows.filter((r) => r[0] === "individual").length;
  const header = `# SEC IAPD compilation as of ${asOf}: ${people} people, ${rows.length - people} firms. Source: https://adviserinfo.sec.gov/compilation\n` +
    "# kind\tcrd\tname\tother_names\tcurrent_firms\thas_disclosures\tstatus\n";
  mkdirSync(new URL("../registers/", import.meta.url), { recursive: true });
  const lines = (function* () { yield header; for (const r of rows) yield r.join("\t") + "\n"; })();
  await pipeline(Readable.from(lines), createGzip({ level: 9 }), createWriteStream(OUT));
  console.log(`${people} people and ${rows.length - people} firms, as of ${asOf} -> registers/sec-iapd.tsv.gz`);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
