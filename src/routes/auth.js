import { smsConfigured, sendSms } from "../lib/sms.js";
import crypto from "node:crypto";
import { Router } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { pool, query, withTransaction, writeAudit } from "../lib/db.js";
import { ApiError, asyncRoute, hashOtp, verifyOtp, normalizePhone } from "../lib/helpers.js";
import { signToken, authenticate, requirePermission, invalidateAuthCache } from "../middleware/auth.js";
import { notifyStaffInApp } from "../lib/notify.js";

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
    const msg = `رمز جملة: ${otp}`; // أقصر نص ممكن: جزء واحد (70 حرف عربي) = أرخص
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

// يُنشئ جلسة (توكن) لحساب تم التحقق منه. المدير العام وشريكه (long_session) جلستهم مفتوحة بدون انتهاء 12 ساعة.
async function issueSession(accountType, user) {
  const cfg = TABLES[accountType];
  let role = null;
  let long = false;
  if (accountType === "employee") {
    const r = await query(
      `SELECT r.code, e.long_session FROM employees e JOIN roles r ON r.id = e.role_id WHERE e.id = $1`,
      [user.id]
    );
    role = r.rows[0]?.code || null;
    long = Boolean(r.rows[0]?.long_session);
  }
  const { rows: tv } = await query(`SELECT token_version FROM ${cfg.table} WHERE id = $1`, [user.id]);
  const token = signToken({ sub: user.id, type: accountType, name: user.name, role, v: tv[0]?.token_version ?? 0 }, { long });
  return { token, actor: { id: user.id, type: accountType, name: user.name, role } };
}

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

  res.json(await issueSession(accountType, user));
}));

authRouter.get("/me", authenticate, asyncRoute(async (req, res0) => {
  if (!req.actor) throw new ApiError(401, "يلزم تسجيل الدخول");
  // هل لازم يحط كلمة مرور؟ (أول دخول بالرمز، أو بعد رمز دخول مؤقت من الإدارة). أرقام التجربة (وضع التجربة المؤقت) معفاة.
  const pr = await query(`SELECT phone, password_set_at FROM ${TABLES[req.actor.type].table} WHERE id = $1`, [req.actor.id]);
  const hasPassword = Boolean(pr.rows[0]?.password_set_at);
  const exempt = process.env.TEST_SKIP_OTP === "1" && Boolean(testOtpFor(pr.rows[0]?.phone));
  const res = { json: (o) => res0.json({ ...o, hasPassword, needsPassword: !hasPassword && !exempt }) };

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

/* ====================================================================== *
 * الدخول بكلمة المرور (الطريقة الأساسية) — الـ SMS يُستخدم أول مرة فقط
 * نسيت كلمة المرور = طلب مراجعة للإدارة، والمدير يصدر رمز دخول مؤقت من شاشة الحسابات
 * ====================================================================== */
const PW_MAX_FAILS = 5;
const PW_LOCK_MINUTES = 15;
const BAD_LOGIN = "رقم الهاتف أو كلمة المرور غير صحيحة";
const pwLimiters = [makeLimiter(15 * 60 * 1000, 12, phoneIpKey), makeLimiter(15 * 60 * 1000, 150, ipKey)];
const strictLimiters = [makeLimiter(15 * 60 * 1000, 6, phoneIpKey), makeLimiter(15 * 60 * 1000, 40, ipKey)];

const passwordSchema = z.string().min(6, "كلمة المرور 6 أحرف على الأقل").max(100);
const loginBase = z.object({ accountType: z.enum(["employee", "customer", "supplier"]), phone: z.string().min(9).max(20) });

// رمز استرجاع للمدير العام وشريكه: 12 حرف/رقم مقروءة (بدون حروف ملتبسة)، يظهر مرة واحدة فقط
const RC_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
function makeRecoveryCode() {
  let c = "";
  for (let i = 0; i < 12; i++) c += RC_ALPHABET[crypto.randomInt(0, RC_ALPHABET.length)];
  return `${c.slice(0, 4)}-${c.slice(4, 8)}-${c.slice(8, 12)}`;
}
const cleanRecovery = (x) => String(x || "").toUpperCase().replace(/[^A-Z0-9]/g, "");

async function findLoginUser(accountType, phone) {
  const cfg = TABLES[accountType];
  const statusCol = accountType === "employee" ? "is_active" : "status";
  const { rows } = await query(
    `SELECT id, ${cfg.nameCol} AS name, ${statusCol} AS account_status, password_hash,
            temp_code_hash, temp_code_expires_at, failed_logins, locked_until
       FROM ${cfg.table} WHERE phone = $1 LIMIT 1`,
    [normalizePhone(phone)]
  );
  return rows[0] || null;
}

function assertUsable(accountType, user) {
  const blocked = accountType === "employee" ? user.account_status === false : user.account_status === "suspended";
  if (blocked) throw new ApiError(403, "تم إيقاف هذا الحساب، يرجى التواصل مع الدعم الفني");
  const approved = accountType === "employee" ? user.account_status === true : user.account_status === "approved";
  if (!approved) throw new ApiError(403, "حسابك لم يُعتمد بعد — بانتظار موافقة الإدارة");
}

function assertNotLocked(user) {
  if (user.locked_until && new Date(user.locked_until) > new Date()) {
    const mins = Math.ceil((new Date(user.locked_until) - Date.now()) / 60000);
    throw new ApiError(429, `تم إيقاف الدخول مؤقتًا بسبب محاولات خاطئة، حاول بعد ${mins} دقيقة`);
  }
}

// يسجّل محاولة فاشلة؛ بعد 5 يقفل الحساب 15 دقيقة
async function registerFail(accountType, user, req, action) {
  const cfg = TABLES[accountType];
  const { rows } = await query(
    `UPDATE ${cfg.table}
        SET failed_logins = failed_logins + 1,
            locked_until = CASE WHEN failed_logins + 1 >= $2 THEN now() + ($3 || ' minutes')::interval ELSE locked_until END
      WHERE id = $1 RETURNING failed_logins`,
    [user.id, PW_MAX_FAILS, String(PW_LOCK_MINUTES)]
  );
  if ((rows[0]?.failed_logins ?? 0) >= PW_MAX_FAILS) {
    await query(`UPDATE ${cfg.table} SET failed_logins = 0 WHERE id = $1`, [user.id]);
  }
  await auditAuthFailure(action, accountType, user, req);
}

async function finishPasswordLogin(accountType, user, req) {
  const cfg = TABLES[accountType];
  await query(
    `UPDATE ${cfg.table} SET failed_logins = 0, locked_until = NULL ${accountType === "employee" ? ", last_login_at = now()" : ""} WHERE id = $1`,
    [user.id]
  );
  await writeAudit(pool, {
    actorType: accountType, actorId: user.id, actorName: user.name, action: "auth.login",
    entityType: accountType, entityId: user.id, entityLabel: user.name, ip: req.ip,
  });
  return issueSession(accountType, user);
}

authRouter.post("/password/login", ...pwLimiters, asyncRoute(async (req, res) => {
  const { accountType, phone } = loginBase.parse(req.body);
  const password = z.string().min(1).max(100).parse(req.body?.password);
  const user = await findLoginUser(accountType, phone);
  if (!user) throw new ApiError(401, BAD_LOGIN);
  assertUsable(accountType, user);
  assertNotLocked(user);
  if (!user.password_hash) {
    throw new ApiError(400, "هذا الحساب ما عندوش كلمة مرور بعد — اطلب من الإدارة رمز دخول (أو ادخل برمز SMS) وبعدها تحط كلمة مرورك", "NO_PASSWORD");
  }
  if (!(await verifyOtp(password, user.password_hash))) {
    await registerFail(accountType, user, req, "auth.password_failed");
    throw new ApiError(401, BAD_LOGIN);
  }
  res.json(await finishPasswordLogin(accountType, user, req));
}));

// رمز دخول مؤقت أصدره المدير: يدخل به ثم يُجبَر على وضع كلمة مرور جديدة
authRouter.post("/password/login-code", ...strictLimiters, asyncRoute(async (req, res) => {
  const { accountType, phone } = loginBase.parse(req.body);
  const code = z.string().regex(/^\d{6}$/).parse(String(req.body?.code || "").replace(/\s/g, ""));
  const user = await findLoginUser(accountType, phone);
  const BAD = "رمز الدخول غير صحيح أو منتهي";
  if (!user) throw new ApiError(401, BAD);
  assertUsable(accountType, user);
  assertNotLocked(user);
  if (!user.temp_code_hash || !user.temp_code_expires_at || new Date(user.temp_code_expires_at) < new Date()) {
    throw new ApiError(401, BAD);
  }
  if (!(await verifyOtp(code, user.temp_code_hash))) {
    await registerFail(accountType, user, req, "auth.code_failed");
    throw new ApiError(401, BAD);
  }
  const cfg = TABLES[accountType];
  // استهلاك ذرّي: الرمز يُستعمل مرة واحدة، ويُمسح الباسورد القديم لتظهر شاشة "حط كلمة مرور جديدة"
  const upd = await query(
    `UPDATE ${cfg.table} SET temp_code_hash = NULL, temp_code_expires_at = NULL, password_hash = NULL, password_set_at = NULL
      WHERE id = $1 AND temp_code_hash = $2`,
    [user.id, user.temp_code_hash]
  );
  if (!upd.rowCount) throw new ApiError(401, BAD);
  res.json(await finishPasswordLogin(accountType, user, req));
}));

// وضع/تغيير كلمة المرور (يحتاج جلسة). لو عنده كلمة حالية لازم يكتبها.
authRouter.post("/password/set", authenticate, ...pwLimiters, asyncRoute(async (req, res) => {
  if (!req.actor) throw new ApiError(401, "يلزم تسجيل الدخول");
  const newPassword = passwordSchema.parse(req.body?.newPassword);
  const cfg = TABLES[req.actor.type];
  const { rows } = await query(
    `SELECT password_hash FROM ${cfg.table} WHERE id = $1`, [req.actor.id]
  );
  if (!rows.length) throw new ApiError(404, "الحساب غير موجود");
  if (rows[0].password_hash) {
    const cur = String(req.body?.currentPassword || "");
    if (!cur || !(await verifyOtp(cur, rows[0].password_hash))) throw new ApiError(400, "كلمة المرور الحالية غير صحيحة");
  }
  const hash = await hashOtp(newPassword);
  await query(
    `UPDATE ${cfg.table} SET password_hash = $2, password_set_at = now(), failed_logins = 0, locked_until = NULL WHERE id = $1`,
    [req.actor.id, hash]
  );
  await writeAudit(pool, {
    actorType: req.actor.type, actorId: req.actor.id, actorName: req.actor.name, action: "auth.password_set",
    entityType: req.actor.type, entityId: req.actor.id, entityLabel: req.actor.name, ip: req.ip,
  });
  // رمز الاسترجاع: للمدير العام وشريكه (جلسة مفتوحة) فقط، ويُعطى مرة واحدة لما ما يكون عنده رمز
  let recoveryCode = null;
  if (req.actor.type === "employee") {
    const e = await query(`SELECT long_session, recovery_hash FROM employees WHERE id = $1`, [req.actor.id]);
    if (e.rows[0]?.long_session && !e.rows[0]?.recovery_hash) {
      recoveryCode = makeRecoveryCode();
      await query(`UPDATE employees SET recovery_hash = $2 WHERE id = $1`, [req.actor.id, await hashOtp(cleanRecovery(recoveryCode))]);
    }
  }
  res.json({ ok: true, recoveryCode });
}));

// إعادة إنشاء رمز الاسترجاع (يحتاج كلمة المرور الحالية) — للمدير العام وشريكه
authRouter.post("/password/new-recovery-code", authenticate, ...pwLimiters, asyncRoute(async (req, res) => {
  if (req.actor?.type !== "employee") throw new ApiError(403, "غير متاح");
  const { rows } = await query(`SELECT long_session, password_hash FROM employees WHERE id = $1`, [req.actor.id]);
  if (!rows[0]?.long_session) throw new ApiError(403, "غير متاح لهذا الحساب");
  const cur = String(req.body?.currentPassword || "");
  if (!rows[0].password_hash || !(await verifyOtp(cur, rows[0].password_hash))) throw new ApiError(400, "كلمة المرور الحالية غير صحيحة");
  const recoveryCode = makeRecoveryCode();
  await query(`UPDATE employees SET recovery_hash = $2 WHERE id = $1`, [req.actor.id, await hashOtp(cleanRecovery(recoveryCode))]);
  res.json({ recoveryCode });
}));

// نسيت كلمة المرور بدون رمز استرجاع: المدير العام وشريكه فقط، برقم + رمز الاسترجاع المحفوظ عندهم
authRouter.post("/password/recover", ...strictLimiters, asyncRoute(async (req, res) => {
  const phone = z.string().min(9).max(20).parse(req.body?.phone);
  const newPassword = passwordSchema.parse(req.body?.newPassword);
  const code = cleanRecovery(req.body?.recoveryCode);
  const BAD = "رمز الاسترجاع غير صحيح";
  const { rows } = await query(
    `SELECT id, name, is_active, recovery_hash, long_session, locked_until FROM employees WHERE phone = $1 LIMIT 1`,
    [normalizePhone(phone)]
  );
  const e = rows[0];
  if (!e || !e.long_session || !e.recovery_hash || !e.is_active) throw new ApiError(401, BAD);
  assertNotLocked(e);
  if (code.length !== 12 || !(await verifyOtp(code, e.recovery_hash))) {
    await registerFail("employee", { id: e.id, name: e.name }, req, "auth.recovery_failed");
    throw new ApiError(401, BAD);
  }
  const newRecovery = makeRecoveryCode();
  await query(
    `UPDATE employees SET password_hash = $2, password_set_at = now(), recovery_hash = $3, failed_logins = 0, locked_until = NULL WHERE id = $1`,
    [e.id, await hashOtp(newPassword), await hashOtp(cleanRecovery(newRecovery))]
  );
  const session = await finishPasswordLogin("employee", { id: e.id, name: e.name }, req);
  res.json({ ...session, recoveryCode: newRecovery });
}));

// خروج من كل الأجهزة: يبطل كل التوكنات القديمة لهذا الحساب
authRouter.post("/password/logout-all", authenticate, asyncRoute(async (req, res) => {
  if (!req.actor) throw new ApiError(401, "يلزم تسجيل الدخول");
  await query(`UPDATE ${TABLES[req.actor.type].table} SET token_version = token_version + 1 WHERE id = $1`, [req.actor.id]);
  invalidateAuthCache(req.actor.type, req.actor.id);
  res.json({ ok: true });
}));

// "نسيت كلمة المرور": طلب مراجعة يوصل الإدارة مع السبب. الرد عام دايمًا (ما نكشفش هل الرقم مسجل)
authRouter.post("/password/forgot", ...strictLimiters, asyncRoute(async (req, res) => {
  const { accountType, phone } = loginBase.parse(req.body);
  const reason = z.string().trim().min(3, "اكتب سبب الطلب").max(500).parse(req.body?.reason);
  const cfg = TABLES[accountType];
  const normalized = normalizePhone(phone);
  const { rows } = await query(`SELECT id, ${cfg.nameCol} AS name FROM ${cfg.table} WHERE phone = $1 LIMIT 1`, [normalized]);
  if (rows.length) {
    const dup = await query(
      `SELECT 1 FROM access_requests WHERE account_type = $1 AND account_id = $2 AND status = 'open' AND created_at > now() - interval '10 minutes'`,
      [accountType, rows[0].id]
    );
    if (!dup.rows.length) {
      await query(
        `INSERT INTO access_requests (account_type, account_id, phone, account_name, reason) VALUES ($1,$2,$3,$4,$5)`,
        [accountType, rows[0].id, normalized, rows[0].name, reason]
      );
      try {
        await notifyStaffInApp(pool, {
          permissionCode: "accounts.issue_code",
          title: "طلب مراجعة: نسيان كلمة المرور",
          body: `${rows[0].name} (${normalized}): ${reason}`,
        });
      } catch (e) { console.error("[forgot notify]", e.message); }
    }
  }
  res.json({ ok: true, message: "تم إرسال طلبك للإدارة، وسيتم التواصل معك بعد المراجعة" });
}));

/* ---- للإدارة: عرض الطلبات وإصدار رمز دخول مؤقت ---- */
authRouter.get("/password/requests", authenticate, requirePermission("accounts.issue_code"), asyncRoute(async (req, res) => {
  const status = req.query.status === "all" ? null : "open";
  const { rows } = await query(
    `SELECT id, account_type, account_id, phone, account_name, reason, status, created_at, handled_at
       FROM access_requests ${status ? "WHERE status = 'open'" : ""} ORDER BY created_at DESC LIMIT 100`
  );
  res.json({ requests: rows });
}));

authRouter.post("/password/requests/:id/dismiss", authenticate, requirePermission("accounts.issue_code"), asyncRoute(async (req, res) => {
  await query(`UPDATE access_requests SET status = 'dismissed', handled_by = $2, handled_at = now() WHERE id = $1 AND status = 'open'`, [req.params.id, req.actor.id]);
  res.json({ ok: true });
}));

authRouter.post("/password/issue-code", authenticate, requirePermission("accounts.issue_code"), asyncRoute(async (req, res) => {
  const accountType = z.enum(["employee", "customer", "supplier"]).parse(req.body?.accountType);
  const accountId = z.string().uuid().parse(req.body?.accountId);
  const requestId = req.body?.requestId ? z.string().uuid().parse(req.body.requestId) : null;
  const cfg = TABLES[accountType];
  const { rows } = await query(`SELECT id, ${cfg.nameCol} AS name, phone FROM ${cfg.table} WHERE id = $1`, [accountId]);
  if (!rows.length) throw new ApiError(404, "الحساب غير موجود");
  // حسابات المدير العام وشريكه: ما يصدر لها رمز إلا مدير عام (جلسة مفتوحة)
  if (accountType === "employee") {
    const t = await query(`SELECT long_session FROM employees WHERE id = $1`, [accountId]);
    if (t.rows[0]?.long_session) {
      const me = await query(`SELECT long_session FROM employees WHERE id = $1`, [req.actor.id]);
      if (!me.rows[0]?.long_session) throw new ApiError(403, "إصدار رمز لحساب مدير عام يكون من مدير عام فقط");
    }
  }
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, "0");
  const expires = new Date(Date.now() + 24 * 3600 * 1000);
  await query(
    `UPDATE ${cfg.table} SET temp_code_hash = $2, temp_code_expires_at = $3, failed_logins = 0, locked_until = NULL WHERE id = $1`,
    [accountId, await hashOtp(code), expires]
  );
  if (requestId) {
    await query(`UPDATE access_requests SET status = 'done', handled_by = $2, handled_at = now() WHERE id = $1`, [requestId, req.actor.id]);
  }
  await writeAudit(pool, {
    actorType: req.actor.type, actorId: req.actor.id, actorName: req.actor.name, action: "auth.issue_code",
    entityType: accountType, entityId: accountId, entityLabel: rows[0].name, ip: req.ip,
  });
  res.json({ code, expiresAt: expires, name: rows[0].name, phone: rows[0].phone });
}));
