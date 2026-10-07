// WebAuthn (بصمة الوجه / البصمة / قفل الجهاز) بدون مكتبات خارجية: node:crypto فقط.
// ندعم ES256 و RS256 مع attestation من نوع none (يكفي لتسجيل الدخول).
import crypto from "node:crypto";
import { ApiError } from "./helpers.js";

const b64u = (buf) => Buffer.from(buf).toString("base64url");
const fromB64u = (s) => Buffer.from(String(s || ""), "base64url");
const sha256 = (b) => crypto.createHash("sha256").update(b).digest();

// ---------- CBOR مبسّط (يكفي للـ attestationObject ومفتاح COSE) ----------
function cborDecode(buf, off = 0) {
  const ib = buf[off++];
  const major = ib >> 5;
  let info = ib & 31;
  const readLen = () => {
    if (info < 24) return info;
    if (info === 24) return buf[off++];
    if (info === 25) { const v = buf.readUInt16BE(off); off += 2; return v; }
    if (info === 26) { const v = buf.readUInt32BE(off); off += 4; return v; }
    throw new ApiError(400, "بيانات البصمة غير مدعومة");
  };
  if (major === 7) {
    if (info === 20) return [false, off];
    if (info === 21) return [true, off];
    if (info === 22 || info === 23) return [null, off];
    throw new ApiError(400, "بيانات البصمة غير مدعومة");
  }
  const n = readLen();
  if (major === 0) return [n, off];
  if (major === 1) return [-1 - n, off];
  if (major === 2) { const v = buf.subarray(off, off + n); return [v, off + n]; }
  if (major === 3) { const v = buf.subarray(off, off + n).toString("utf8"); return [v, off + n]; }
  if (major === 4) {
    const arr = [];
    for (let i = 0; i < n; i++) { const [v, o] = cborDecode(buf, off); arr.push(v); off = o; }
    return [arr, off];
  }
  if (major === 5) {
    const m = new Map();
    for (let i = 0; i < n; i++) {
      const [k, o1] = cborDecode(buf, off);
      const [v, o2] = cborDecode(buf, o1);
      m.set(k, v); off = o2;
    }
    return [m, off];
  }
  throw new ApiError(400, "بيانات البصمة غير مدعومة");
}

// ---------- أصل الموقع (rpId) ----------
// نقبل فقط jomla-ly.com ونطاقاته الفرعية (و localhost للتطوير). الـ rpId = اسم نطاق الصفحة نفسها.
export function originInfo(req) {
  const origin = String(req.headers.origin || "");
  let u;
  try { u = new URL(origin); } catch { throw new ApiError(400, "مصدر الطلب غير معروف"); }
  const host = u.hostname;
  const okHost = host === "jomla-ly.com" || host.endsWith(".jomla-ly.com") || host === "localhost";
  const okScheme = u.protocol === "https:" || host === "localhost";
  if (!okHost || !okScheme) throw new ApiError(400, "بصمة الوجه تعمل فقط من روابط جملة الرسمية (jomla-ly.com)");
  return { origin: u.origin, rpId: host };
}

// ---------- التحدي (challenge) بدون تخزين: nonce + انتهاء + توقيع HMAC ----------
const SECRET = () => process.env.JWT_SECRET;
const usedNonces = new Map();
function mac(purpose, scope, body) {
  return crypto.createHmac("sha256", SECRET()).update(`${purpose}|${scope}|`).update(body).digest().subarray(0, 16);
}
export function makeChallenge(purpose, scope = "") {
  const nonce = crypto.randomBytes(16);
  const exp = Buffer.alloc(4); exp.writeUInt32BE(Math.floor(Date.now() / 1000) + 300);
  const body = Buffer.concat([nonce, exp]);
  return b64u(Buffer.concat([body, mac(purpose, scope, body)]));
}
function checkChallenge(ch, purpose, scope = "") {
  const buf = fromB64u(ch);
  if (buf.length !== 36) throw new ApiError(400, "انتهت صلاحية العملية، حاول من جديد");
  const body = buf.subarray(0, 20);
  if (!crypto.timingSafeEqual(buf.subarray(20), mac(purpose, scope, body))) throw new ApiError(400, "انتهت صلاحية العملية، حاول من جديد");
  if (buf.readUInt32BE(16) < Date.now() / 1000) throw new ApiError(400, "انتهت صلاحية العملية، حاول من جديد");
  const key = b64u(buf.subarray(0, 16));
  if (usedNonces.has(key)) throw new ApiError(400, "انتهت صلاحية العملية، حاول من جديد");
  usedNonces.set(key, Date.now());
  if (usedNonces.size > 2000) for (const [k, t] of usedNonces) if (Date.now() - t > 400_000) usedNonces.delete(k);
}

function checkClientData(clientDataB64, type, purpose, scope, info) {
  const raw = fromB64u(clientDataB64);
  let cd;
  try { cd = JSON.parse(raw.toString("utf8")); } catch { throw new ApiError(400, "بيانات البصمة غير صالحة"); }
  if (cd.type !== type) throw new ApiError(400, "بيانات البصمة غير صالحة");
  if (cd.origin !== info.origin) throw new ApiError(400, "بيانات البصمة غير صالحة");
  checkChallenge(cd.challenge, purpose, scope);
  return raw;
}

function checkAuthData(ad, info, needAttested) {
  if (ad.length < 37) throw new ApiError(400, "بيانات البصمة غير صالحة");
  if (!crypto.timingSafeEqual(ad.subarray(0, 32), sha256(Buffer.from(info.rpId)))) throw new ApiError(400, "بيانات البصمة غير صالحة");
  const flags = ad[32];
  if (!(flags & 0x01) || !(flags & 0x04)) throw new ApiError(400, "لازم تتحقق ببصمة الوجه أو قفل الجهاز");
  if (needAttested && !(flags & 0x40)) throw new ApiError(400, "بيانات البصمة غير صالحة");
  return { counter: ad.readUInt32BE(33) };
}

// ---------- التسجيل ----------
export function verifyRegistration(body, { accountScope, info }) {
  const resp = body?.response || {};
  checkClientData(resp.clientDataJSON, "webauthn.create", "reg", accountScope, info);
  const att = fromB64u(resp.attestationObject);
  const [obj] = cborDecode(att, 0);
  const authData = obj?.get?.("authData");
  if (!Buffer.isBuffer(authData) && !(authData instanceof Uint8Array)) throw new ApiError(400, "بيانات البصمة غير صالحة");
  const ad = Buffer.from(authData);
  const { counter } = checkAuthData(ad, info, true);
  let off = 37 + 16;
  const idLen = ad.readUInt16BE(off); off += 2;
  const credId = ad.subarray(off, off + idLen); off += idLen;
  const [cose] = cborDecode(ad, off);
  const kty = cose.get(1), alg = cose.get(3);
  let jwk;
  if (kty === 2 && alg === -7) {
    jwk = { kty: "EC", crv: "P-256", x: b64u(cose.get(-2)), y: b64u(cose.get(-3)) };
  } else if (kty === 3 && alg === -257) {
    jwk = { kty: "RSA", n: b64u(cose.get(-1)), e: b64u(cose.get(-2)) };
  } else throw new ApiError(400, "نوع البصمة غير مدعوم على هذا الجهاز");
  const pub = crypto.createPublicKey({ key: jwk, format: "jwk" });
  return { credentialId: b64u(credId), publicKey: pub.export({ type: "spki", format: "der" }).toString("base64"), alg, counter };
}

// ---------- الدخول ----------
export function verifyAssertion(body, cred, { info }) {
  const resp = body?.response || {};
  const cdRaw = checkClientData(resp.clientDataJSON, "webauthn.get", "login", "", info);
  const ad = fromB64u(resp.authenticatorData);
  const { counter } = checkAuthData(ad, info, false);
  const signed = Buffer.concat([ad, sha256(cdRaw)]);
  const key = crypto.createPublicKey({ key: Buffer.from(cred.public_key, "base64"), format: "der", type: "spki" });
  const ok = crypto.verify("sha256", signed, key, fromB64u(resp.signature));
  if (!ok) throw new ApiError(401, "تعذر التحقق من البصمة");
  const prev = Number(cred.counter || 0);
  if ((counter || prev) && counter <= prev) throw new ApiError(401, "تعذر التحقق من البصمة");
  return { counter };
}
