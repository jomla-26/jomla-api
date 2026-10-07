// إشعارات الهاتف (Web Push) بدون مكتبات خارجية: توقيع VAPID بـ ES256 من crypto المدمج.
// نرسل "نبضة" فارغة، والخدمة (service worker) تسأل السيرفر عن نص الإشعار — فما نحتاجش تشفير حمولة.
import crypto from "node:crypto";
import { query } from "./db.js";

const b64u = (buf) => Buffer.from(buf).toString("base64url");

export function pushConfigured() {
  return Boolean(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);
}
export const vapidPublicKey = () => process.env.VAPID_PUBLIC_KEY || "";

// توليد زوج مفاتيح VAPID (يُستعمل مرة وحدة وتنحط القيم في Railway)
export function generateVapidKeys() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const pub = publicKey.export({ format: "jwk" });
  const prv = privateKey.export({ format: "jwk" });
  const raw = Buffer.concat([Buffer.from([4]), Buffer.from(pub.x, "base64url"), Buffer.from(pub.y, "base64url")]);
  return { publicKey: b64u(raw), privateKey: prv.d };
}

function vapidHeader(endpoint) {
  const aud = new URL(endpoint).origin;
  const pubRaw = Buffer.from(process.env.VAPID_PUBLIC_KEY, "base64url");
  const key = crypto.createPrivateKey({
    key: { kty: "EC", crv: "P-256", d: process.env.VAPID_PRIVATE_KEY, x: b64u(pubRaw.subarray(1, 33)), y: b64u(pubRaw.subarray(33, 65)) },
    format: "jwk",
  });
  const head = b64u(JSON.stringify({ typ: "JWT", alg: "ES256" }));
  const body = b64u(JSON.stringify({
    aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    sub: process.env.VAPID_SUBJECT || "mailto:admin@jomla-ly.com",
  }));
  const sig = crypto.sign("sha256", Buffer.from(`${head}.${body}`), { key, dsaEncoding: "ieee-p1363" });
  return `vapid t=${head}.${body}.${b64u(sig)}, k=${process.env.VAPID_PUBLIC_KEY}`;
}

async function sendPulse(endpoint) {
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { Authorization: vapidHeader(endpoint), TTL: "3600", Urgency: "high", "Content-Length": "0" },
    signal: AbortSignal.timeout(15_000),
  });
  return res.status;
}

// يرسل نبضة لكل جهاز مشترك عنده إشعار جديد (آخر 10 دقايق) لم تُرسل له نبضة
export async function dispatchPushQueue() {
  if (!pushConfigured()) return;
  const { rows } = await query(
    `UPDATE notifications SET push_sent_at = now()
      WHERE id IN (
        SELECT n.id FROM notifications n
         WHERE n.push_sent_at IS NULL AND n.created_at > now() - interval '10 minutes'
           AND EXISTS (SELECT 1 FROM push_subscriptions s WHERE s.actor_type = n.recipient_type AND s.actor_id = n.recipient_id)
         ORDER BY n.created_at LIMIT 100 FOR UPDATE SKIP LOCKED)
      RETURNING recipient_type, recipient_id`
  );
  const seen = new Set();
  for (const r of rows) {
    const k = `${r.recipient_type}:${r.recipient_id}`;
    if (seen.has(k)) continue; seen.add(k);
    const { rows: subs } = await query(
      `SELECT id, endpoint FROM push_subscriptions WHERE actor_type = $1 AND actor_id = $2`, [r.recipient_type, r.recipient_id]
    );
    for (const s of subs) {
      try {
        const st = await sendPulse(s.endpoint);
        if (st === 404 || st === 410) await query(`DELETE FROM push_subscriptions WHERE id = $1`, [s.id]);
        else if (st >= 400) console.error("[push] status", st);
      } catch (e) { console.error("[push]", e.message); }
    }
  }
}

// الخدمة تسأل: شن الإشعارات الجديدة لجهازي؟ (العنوان نفسه سر غير قابل للتخمين)
export async function peekForEndpoint(endpoint) {
  const { rows: [sub] } = await query(
    `SELECT id, actor_type, actor_id, last_peek_at FROM push_subscriptions WHERE endpoint = $1`, [endpoint]);
  if (!sub) return [];
  const { rows } = await query(
    `SELECT id, title, body, order_id FROM notifications
      WHERE recipient_type = $1 AND recipient_id = $2 AND created_at > COALESCE($3, now() - interval '10 minutes')
        AND created_at > now() - interval '1 hour'
      ORDER BY created_at DESC LIMIT 3`,
    [sub.actor_type, sub.actor_id, sub.last_peek_at]
  );
  await query(`UPDATE push_subscriptions SET last_peek_at = now() WHERE id = $1`, [sub.id]);
  return rows;
}
