// Emails the trusted contact through Amazon SES when a request is waiting.
//
// The link in the email opens a page; only pressing Approve or Say no on that page decides. Mail
// scanners open links by themselves, so a link that decided on its own would approve payments
// nobody read. Each link carries a signed, expiring token: only someone holding the email can answer.
//
// Off unless MG_SES_REGION, MG_EMAIL_FROM, MG_FAMILY_EMAIL, MG_PUBLIC_URL and MG_LINK_SECRET are set.
// AWS credentials come from the standard AWS chain, never from this repository.

import { createHmac, timingSafeEqual } from "node:crypto";
import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import { currentDemo } from "./demo.js";
import { household } from "./guard.js";

const env = (k) => process.env[k] || "";
const LINK_DAYS = 7;
const PER_HOUR = Number(process.env.MG_EMAILS_PER_HOUR || 20);

export const emailEnabled = () =>
  ["MG_SES_REGION", "MG_EMAIL_FROM", "MG_FAMILY_EMAIL", "MG_PUBLIC_URL", "MG_LINK_SECRET"].every((k) => env(k));

// ---------- Signed links ----------

const b64 = (s) => Buffer.from(s).toString("base64url");
const sign = (payload) => createHmac("sha256", env("MG_LINK_SECRET")).update(payload).digest("base64url");

/** A token naming one approval (and its demo household), valid for LINK_DAYS. */
export function linkToken(approvalId, demo = currentDemo()) {
  const payload = b64(JSON.stringify({ a: approvalId, d: demo, exp: Date.now() + LINK_DAYS * 864e5 }));
  return `${payload}.${sign(payload)}`;
}

/** The approval a token names, or null if it is forged, malformed or expired. */
export function readToken(token) {
  if (!env("MG_LINK_SECRET") || typeof token !== "string") return null;
  const [payload, mac] = token.split(".");
  if (!payload || !mac) return null;
  const want = Buffer.from(sign(payload));
  const got = Buffer.from(mac);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  try {
    const t = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return typeof t.a === "string" && t.exp > Date.now() ? t : null;
  } catch {
    return null;
  }
}

// ---------- Sending ----------

let ses;
const sentAt = []; // times of recent emails, for the hourly cap

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

/** Email the trusted contact about a new request. Never throws: a failed email must not block the request. */
export async function notifyFamily(a) {
  if (!emailEnabled()) return { sent: false, reason: "email is not set up" };
  // The hosted demo is public: visitors' requests stay on the demo phone page, so nobody can fill the inbox.
  if (currentDemo() && env("MG_EMAIL_DEMOS") !== "1") return { sent: false, reason: "demo households don't send email" };
  const hourAgo = Date.now() - 36e5;
  while (sentAt.length && sentAt[0] < hourAgo) sentAt.shift();
  if (sentAt.length >= PER_HOUR) return { sent: false, reason: "hourly email limit reached" };

  const h = household();
  const link = `${env("MG_PUBLIC_URL").replace(/\/$/, "")}/a/${linkToken(a.approval_id)}`;
  const subject = `${h.owner.name} needs your OK: ${a.summary}`.slice(0, 120);
  const reasons = a.reasons || [];
  const text = [
    `Hi ${h.trusted_contact.name},`,
    "",
    `${h.owner.name}'s Money Guardian is holding this until you answer:`,
    "",
    a.summary,
    ...reasons.map((r) => `- ${r}`),
    "",
    `Approve or say no: ${link}`,
    "",
    `Nothing is paid or sent until you answer. The link works for ${LINK_DAYS} days.`,
    "If you weren't expecting this email, you can ignore it.",
  ].join("\n");
  const html = `<p>Hi ${esc(h.trusted_contact.name)},</p>
<p>${esc(h.owner.name)}'s Money Guardian is holding this until you answer:</p>
<p><strong>${esc(a.summary)}</strong></p>
${reasons.length ? `<ul>${reasons.map((r) => `<li>${esc(r)}</li>`).join("")}</ul>` : ""}
<p><a href="${esc(link)}" style="display:inline-block;padding:12px 20px;background:#1f6f5c;color:#fff;border-radius:10px;text-decoration:none;font-weight:600">Approve or say no</a></p>
<p style="color:#5d6270;font-size:13px">Nothing is paid or sent until you answer. The link works for ${LINK_DAYS} days. If you weren't expecting this email, you can ignore it.</p>`;

  try {
    // MG_SES_ENDPOINT exists for the tests, which run against a fake SES on localhost.
    ses ||= new SESv2Client({ region: env("MG_SES_REGION"), ...(env("MG_SES_ENDPOINT") ? { endpoint: env("MG_SES_ENDPOINT") } : {}) });
    const r = await ses.send(new SendEmailCommand({
      FromEmailAddress: env("MG_EMAIL_FROM"),
      Destination: { ToAddresses: [env("MG_FAMILY_EMAIL")] },
      Content: { Simple: { Subject: { Data: subject }, Body: { Text: { Data: text }, Html: { Data: html } } } },
    }));
    sentAt.push(Date.now());
    return { sent: true, message_id: r.MessageId };
  } catch (e) {
    console.error(`Email to the trusted contact failed: ${e.name} ${e.message}`);
    return { sent: false, reason: "the email could not be sent" };
  }
}
