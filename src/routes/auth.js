import { smsConfigured, sendSms } from "../lib/sms.js";
import crypto from "node:crypto";
import { Router } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { pool, query, withTransaction, writeAudit } from "../lib/db.js";
import { ApiError, asyncRoute, hashOtp, verifyOtp, normalizePhone } from "../lib/helpers.js";
import { signToken, authenticate } from "../middleware/auth.js";

export const authRouter = Router();

// رمز من 4 خانات (التطبيقات تتحقق من الطول 4 وترسل تلقائيًا عند اكتماله) — مولَّد بمصدر عشوائي آمن
const generateOtp = () => String(crypto.randomInt(0, 10000)).padStart(4, "0");

const OTP_MAX_ATTEMPTS = 5; // بعدها يُحرق الرمز ويلزم طلب رمز جديد

// الـ limiters مفصولة (طلب الرمز ≠ التحقق منه) والمفتاح = IP + رقم الهاتف، عشان شبكة موبايل
// مشتركة ما تقفل كل المستخدمين. وفوقها سقف أوسع حسب IP وحده ضد من يجرب أرقام كثيرة.
const phoneIpKey = (req) => `${req.ip}|${normalizePhone(req.body?.phone) || "-"}`;
const ipKey = (req) => String(req.ip);
// وضع التجربة المؤقت: أرقام التجربة (TEST_OTP_PHONES) فقط تُعفى من سقف الدخول عشان نقدر نجرب ضغط
// عدد كبير من الحسابات من جهاز واحد. أي رقم ثاني يبقى عليه السقف العادي. يتعطل بمسح TEST_SKIP_OTP.
const skipForTestPhones = (req) => {
  try {
    if (process.env.TEST_SKIP_OTP !== "1") return false;
    return Boolean(testOtpFor(normalizePhone(req.body?.phone)));
  } catch { return false; }
};
const makeLimiter = (windowMs, max, keyGenerator) => rateLimit({
  windowMs, max, keyGenerator, skip: skipForTestPhones,
  standardHeaders: true, legacyHeaders: false,
  message: { error: "محاولات كثيرة، يرجى المحاولة بعد قليل" },
});
const otpRequestLimiters = [
  makeLimiter(15 * 60 * 1000, 5, phoneIpKey),
  makeLimiter(15 * 60 * 1000, 40, ipKey),
];
const otpVerifyLimiters = [
  makeLimiter(15 * 60 * 1000, 10, phoneIpKey),
  makeLimiter(15 * 60 * 1000, 100, ipKey),
];

// تسجيل مختصر لفشل الدخول بسجل التدقيق — ما يوقف الطلب لو فشل التسجيل نفسه
async function auditAuthFailure(action, accountType, user, req) {
  try {
    await writeAudit(pool, {
      actorType: accountType, actorId: user.id, actorName: user.name,
      action, entityType: accountType, entityId: user.id, entityLabel: user.name, ip: req.ip,
    });
  } catch (e) { console.error("[auth audit]", e.message); }
}

// حماية إضافية حسب رقم الهاتف نفسه (مو بس الـ IP): تمنع إغراق رقم معيّن برسائل
// متكررة مهما كان مصدر الطلب.
const OTP_COOLDOWN_SECONDS = 45;
const OTP_MAX_PER_HOUR = 5;

async function checkOtpPhoneLimit(phone, accountType) {
  const { rows: lastReq } = await query(
    `SELECT created_at FROM otp_requests WHERE phone = $1 ORDER BY created_at DESC LIMIT 1`,
    [phone]
  );
  if (lastReq.length) {
    const secondsSince = (Date.now() - new Date(lastReq[0].created_at).getTime()) / 1000;
    if (secondsSince < OTP_COOLDOWN_SECONDS) {
      throw new ApiError(429, `يرجى الانتظار ${Math.ceil(OTP_COOLDOWN_SECONDS - secondsSince)} ثانية قبل إعادة الإرسال`);
    }
  }
  const { rows: hourRows } = await query(
    `SELECT COUNT(*)::int AS c FROM otp_requests WHERE phone = $1 AND created_at > now() - interval '1 hour'`,
    [phone]
  );
  if (hourRows[0].c >= OTP_MAX_PER_HOUR) {
    throw new ApiError(429, "تجاوزت عدد محاولات طلب رمز التحقق لهذا الرقم، يرجى المحاولة بعد ساعة");
  }
  await query(`INSERT INTO otp_requests (phone, account_type) VALUES ($1,$2)`, [phone, accountType]);
}


// ── وضع تجربة مؤقت (معطّل افتراضيًا) ────────────────────────────────────────
// لو المالك أضاف المتغيرين TEST_OTP_PHONES (أرقام مفصولة بفواصل) و TEST_OTP_CODE (4 أرقام) في Railway،
// فهذي الأرقام بالذات يكون رمزها هو الكود الثابت ولا يُرسل لها واتساب. أي رقم ثاني يمشي عادي.
// لإغلاق الباب: امسح المتغيرين من Railway. بدونهما هذا الكود لا يفعل شي.
function testOtpFor(normalizedPhone) {
  const code = (process.env.TEST_OTP_CODE || "").trim();
  if (!/^\d{4}$/.test(code)) return null;
  const list = (process.env.TEST_OTP_PHONES || "").split(",").map((x) => x.trim()).filter(Boolean).map(normalizePhone);
  return list.includes(normalizedPhone) ? code : null;
}

const TABLES = {
  employee: { table: "employees", nameCol: "name",          activeClause: "AND is_active" },
  customer: { table: "customers", nameCol: "business_name", activeClause: "AND status = 'approved'" },
  supplier: { table: "suppliers", nameCol: "business_name", activeClause: "AND status = 'approved'" },
};

const requestSchema = z.object({
  accountType: z.enum(["employee", "customer", "supplier"]),
  phone: z.string().min(9).max(20),
});

authRouter.post("/otp/request", ...otpRequestLimiters, asyncRoute(async (req, res) => {
  const { accountType, phone } = requestSchema.parse(req.body);
  const cfg = TABLES[accountType];
  const normalized = normalizePhone(phone);
  const statusCol = accountType === "employee" ? "is_active" : "status";

  // سقف حسب الرقم نفسه — قبل أي شي ثاني، عشان يحمي حتى لو المهاجم يجرب أرقام
  // مو مسجّلة بالنظام
  if (!testOtpFor(normalized)) await checkOtpPhoneLimit(normalized, accountType); // أرقام التجربة معفاة من سقف الطلب (متغيرات مؤقتة)

  const { rows } = await query(
    `SELECT id, ${cfg.nameCol} AS name, ${statusCol} AS account_status
       FROM ${cfg.table} WHERE phone = $1 LIMIT 1`,
    [normalized]
  );

  // قرار المالك: رسالة "هذا الرقم غير مسجل" تبقى كما هي
  if (!rows.length) {
    throw new ApiError(404, "هذا الرقم غير مسجل");
  }

  const user = rows[0];
  const isBlocked = accountType === "employee"
    ? user.account_status === false
    : user.account_status === "suspended";

  if (isBlocked) {
    throw new ApiError(403, "تم إيقاف هذا الحساب، يرجى التواصل مع الدعم الفني");
  }

  const isApproved = accountType === "employee"
    ? user.account_status === true
    : user.account_status === "approved";

  if (!isApproved) {
    throw new ApiError(403, "حسابك لم يُعتمد بعد — بانتظار موافقة الإدارة");
  }

  const fixedTestOtp = testOtpFor(normalized);
  const otp = fixedTestOtp ?? generateOtp();
  const hash = await hashOtp(otp);
  // رمز جديد = عدّاد محاولات جديد
  await query(
    `UPDATE ${cfg.table}
        SET otp_hash = $1, otp_expires_at = now() + interval '5 minutes', otp_attempts = 0
      WHERE id = $2`,
    [hash, user.id]
  );

  if (!fixedTestOtp && process.env.NODE_ENV !== "production") console.log(`[OTP] ${normalized} → ${otp}`);

  // إرسال الرمز عبر واتساب (سيرفس Baileys المستقل) — لا نوقف الطلب لو فشل الإرسال،
  // فقط نسجّل الخطأ، عشان مشكلة مؤقتة بواتساب ما توقفش تسجيل الدخول بالكامل
  if (fixedTestOtp) {
    console.log(`[AUTH] رقم تجربة (${normalized}): كود ثابت، بدون إرسال واتساب`);
  } else if (smsConfigured()) {
    // رسالة نصية (SMS) هي الطريقة الأساسية لو مضبوطة؛ لو فشلت وواتساب مضبوط نجرب واتساب كاحتياط
    const msg = `رمز التحقق الخاص بك في جملة: ${otp}\nصالح لمدة 5 دقائق. لا تشاركه مع أي شخص.`;
    sendSms(normalized, msg).catch((err) => {
      console.error("[SMS] فشل الإرسال:", err.message);
      if (process.env.WHATSAPP_SERVICE_URL && process.env.WHATSAPP_SECRET_KEY) {
        fetch(`${process.env.WHATSAPP_SERVICE_URL}/send`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-secret-key": process.env.WHATSAPP_SECRET_KEY },
          body: JSON.stringify({ phone: normalized, message: msg }),
        }).catch(() => {});
      }
    });
  } else if (process.env.WHATSAPP_SERVICE_URL && process.env.WHATSAPP_SECRET_KEY) {
    fetch(`${process.env.WHATSAPP_SERVICE_URL}/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-secret-key": process.env.WHATSAPP_SECRET_KEY },
      body: JSON.stringify({
        phone: normalized,
        message: `رمز التحقق الخاص بك في جملة: ${otp}\nصالح لمدة 5 دقائق. لا تشاركه مع أي شخص.`,
      }),
    }).then(async (r) => {
      const body = await r.json().catch(() => ({}));
      console.log(`[WHATSAPP] استجابة السيرفس (${r.status}):`, JSON.stringify(body));
    }).catch((err) => console.error("[WHATSAPP] فشل الاتصال بسيرفس واتساب:", err));
  } else {
    console.log("[WHATSAPP] المتغيرات غير موجودة — تم تجاوز الإرسال");
  }

  // وضع "دخول مباشر" المؤقت: لو TEST_SKIP_OTP=1 ورقم التجربة في TEST_OTP_PHONES، التطبيق يدخل فورًا بدون كتابة الرمز
  if (fixedTestOtp && process.env.TEST_SKIP_OTP === "1") {
    return res.json({ sent: true, skipOtp: true, otp: fixedTestOtp, message: "دخول مباشر (وضع تجربة)" });
  }
  res.json({ sent: true, message: "تم إرسال رمز التحقق" });
}));

const verifySchema = requestSchema.extend({ otp: z.string().length(4) });

authRouter.post("/otp/verify", ...otpVerifyLimiters, asyncRoute(async (req, res) => {
  const { accountType, phone, otp } = verifySchema.parse(req.body);
  const cfg = TABLES[accountType];
  const normalized = normalizePhone(phone);
  const statusCol = accountType === "employee" ? "is_active" : "status";

  const { rows } = await query(
    `SELECT id, ${cfg.nameCol} AS name, ${statusCol} AS account_status
       FROM ${cfg.table} WHERE phone = $1 LIMIT 1`,
    [normalized]
  );

  const user = rows[0];
  const INVALID = "الرمز غير صالح أو منتهي الصلاحية";
  if (!user) throw new ApiError(401, INVALID);

  const isBlocked = accountType === "employee"
    ? user.account_status === false
    : user.account_status === "suspended";
  if (isBlocked) {
    throw new ApiError(403, "تم إيقاف هذا الحساب، يرجى التواصل مع الدعم الفني");
  }
  const isApproved = accountType === "employee"
    ? user.account_status === true
    : user.account_status === "approved";
  if (!isApproved) {
    throw new ApiError(403, "حسابك لم يُعتمد بعد — بانتظار موافقة الإدارة");
  }

  // نستهلك محاولة بشكل ذرّي (UPDATE واحد) قبل المقارنة، فالتخمين المتوازي ما يتجاوزش السقف
  const { rows: att } = await query(
    `UPDATE ${cfg.table}
        SET otp_attempts = otp_attempts + 1
      WHERE id = $1 AND otp_hash IS NOT NULL AND otp_expires_at > now() AND otp_attempts < $2
      RETURNING otp_hash, otp_attempts`,
    [user.id, OTP_MAX_ATTEMPTS]
  );
  if (!att.length) {
    // إما لا يوجد رمز، أو منتهي، أو استُنفدت المحاولات — احرق أي رمز متبقي
    await query(
      `UPDATE ${cfg.table} SET otp_hash = NULL WHERE id = $1 AND otp_hash IS NOT NULL AND otp_attempts >= $2`,
      [user.id, OTP_MAX_ATTEMPTS]
    );
    throw new ApiError(401, INVALID);
  }

  if (!(await verifyOtp(otp, att[0].otp_hash))) {
    const used = att[0].otp_attempts;
    if (used >= OTP_MAX_ATTEMPTS) {
      await query(`UPDATE ${cfg.table} SET otp_hash = NULL, otp_expires_at = NULL WHERE id = $1`, [user.id]);
      await auditAuthFailure("auth.otp_locked", accountType, user, req);
      throw new ApiError(401, "تجاوزت عدد المحاولات المسموحة، يرجى طلب رمز جديد");
    }
    await auditAuthFailure("auth.otp_failed", accountType, user, req);
    throw new ApiError(401, "الرمز غير صحيح");
  }

  const consumed = await withTransaction(async (client) => {
    // نحرق الرمز فقط لو لسا هو نفسه (يمنع استعمال نفس الرمز مرتين بالتوازي)
    const upd = await client.query(
      `UPDATE ${cfg.table} SET otp_hash = NULL, otp_expires_at = NULL, otp_attempts = 0
       ${accountType === "employee" ? ", last_login_at = now()" : ""}
        WHERE id = $1 AND otp_hash = $2`,
      [user.id, att[0].otp_hash]
    );
    if (!upd.rowCount) return false;
    await writeAudit(client, {
      actorType: accountType, actorId: user.id, actorName: user.name,
      action: "auth.login", entityType: accountType, entityId: user.id,
      entityLabel: user.name, ip: req.ip,
    });
    return true;
  });
  if (!consumed) throw new ApiError(401, INVALID);

  let role = null;
  if (accountType === "employee") {
    const r = await query(
      `SELECT r.code FROM employees e JOIN roles r ON r.id = e.role_id WHERE e.id = $1`,
      [user.id]
    );
    role = r.rows[0]?.code || null;
  }

  const token = signToken({ sub: user.id, type: accountType, name: user.name, role });
  res.json({ token, actor: { id: user.id, type: accountType, name: user.name, role } });
}));

authRouter.get("/me", authenticate, asyncRoute(async (req, res) => {
  if (!req.actor) throw new ApiError(401, "يلزم تسجيل الدخول");

  if (req.actor.type === "supplier") {
    const { rows } = await query(
      `SELECT s.id, s.name, s.slug, s.image_url,
              EXISTS(SELECT 1 FROM sections c WHERE c.parent_id = s.id AND c.is_active) AS has_subsections
         FROM supplier_sections ss
         JOIN sections s ON s.id = ss.section_id
        WHERE ss.supplier_id = $1 AND ss.enabled AND s.is_active
        ORDER BY s.sort_order`,
      [req.actor.id]
    );
    return res.json({ actor: req.actor, sections: rows });
  }

  if (req.actor.type === "customer") {
    const { rows } = await query(
      `SELECT s.id, s.name, s.slug, s.image_url,
              EXISTS(SELECT 1 FROM sections c WHERE c.parent_id = s.id AND c.is_active) AS has_subsections
         FROM customer_sections cs
         JOIN sections s ON s.id = cs.section_id
        WHERE cs.customer_id = $1 AND cs.enabled AND s.is_active
        ORDER BY s.sort_order`,
      [req.actor.id]
    );

    // بيانات الآجل (السقف والرصيد الحالي) — عشان تطبيق العميل يعرضها قبل ما يكمل
    // الطلب، مش يفاجئه برفض بعد ما يحاول يأكد
    const { rows: custRows } = await query(
      `SELECT credit_enabled, credit_limit, credit_days, latitude, longitude FROM customers WHERE id = $1`,
      [req.actor.id]
    );
    const { rows: balRows } = await query(
      `SELECT COALESCE(SUM(debit),0)::numeric - COALESCE(SUM(credit),0)::numeric AS balance
         FROM v_customer_ledger WHERE customer_id = $1`,
      [req.actor.id]
    );
    const credit = custRows.length
      ? {
          enabled: custRows[0].credit_enabled,
          limit: Number(custRows[0].credit_limit ?? 0),
          days: custRows[0].credit_days,
          balance: Number(balRows[0]?.balance ?? 0),
        }
      : null;
    const location = custRows.length && custRows[0].latitude != null
      ? { lat: Number(custRows[0].latitude), lng: Number(custRows[0].longitude) }
      : null;

    return res.json({ actor: req.actor, sections: rows, credit, location });
  }

  if (req.actor.type === "employee") {
    const { rows } = await query(
      `SELECT p.code
         FROM employees e
         JOIN role_permissions rp ON rp.role_id = e.role_id
         JOIN permissions p       ON p.id = rp.permission_id
        WHERE e.id = $1`,
      [req.actor.id]
    );
    // الصلاحيات الفردية (منح/سحب) تتفوق على صلاحيات الدور
    const { rows: ovr } = await query(
      `SELECT p.code, o.granted FROM employee_permission_overrides o
         JOIN permissions p ON p.id = o.permission_id WHERE o.employee_id = $1`,
      [req.actor.id]
    );
    const set = new Set(rows.map((r) => r.code));
    for (const o of ovr) { if (o.granted) set.add(o.code); else set.delete(o.code); }
    return res.json({ actor: req.actor, permissions: [...set] });
  }

  res.json({ actor: req.actor });
}));
