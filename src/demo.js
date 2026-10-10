// Each visitor of the hosted demo gets their own household ledger, so judges never see each other's
// approvals or payments. The demo id travels in the URL (?demo=...) and is carried through each request.

import { AsyncLocalStorage } from "node:async_hooks";

const store = new AsyncLocalStorage();
const VALID = /^[a-z0-9]{6,24}$/;

export const cleanDemoId = (v) => (typeof v === "string" && VALID.test(v) ? v : null);
export const runWithDemo = (demo, fn) => store.run({ demo: cleanDemoId(demo) }, fn);
export const currentDemo = () => store.getStore()?.demo || null;
