// Each E2E suite leaves a record of what it did: the ways the feature could fail, and for each one what
// was asked, what came back and what reached the fake outside services. Times, ports and ids are left
// out, so a re-run writes the same bytes and the sha256 printed at the end matches across runs and machines.
import { test, after } from "node:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";

export function e2eSuite(name, about) {
  const cases = [];
  after(() => {
    const dir = new URL("./artifacts/", import.meta.url);
    mkdirSync(dir, { recursive: true });
    const text = `${JSON.stringify({ suite: name, about, repeat: `node --test test/${name}.test.js`, cases }, null, 2)}\n`;
    writeFileSync(new URL(`${name}.json`, dir), text);
    console.log(`E2E artifact test/artifacts/${name}.json sha256 ${createHash("sha256").update(text).digest("hex")}`);
  });
  /** A test that records its evidence: `fn(record)`, where record(key, value) adds to the artifact. */
  return (title, guardsAgainst, fn) => test(title, async () => {
    const c = { case: title, guards_against: guardsAgainst, passed: false, evidence: {} };
    cases.push(c);
    try {
      await fn((key, value) => { c.evidence[key] = value; });
      c.passed = true;
    } catch (e) {
      c.error = String(e.message).split("\n")[0];
      throw e;
    }
  });
}
