import { Router } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { query, withTransaction, writeAudit } from "../lib/db.js";
import { ApiError, asyncRoute, generateOtp, hashOtp, verifyOtp, normalizePhone } from "../lib/helpers.js";
import { signToken, authenticate } from "../middleware/auth.js";

export const authRouter = Router();

const otpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: { error: "محاولات كثيرة، يرجى المحاولة بعد قليل" },
});

// حماية إضافية حسب رقم الهاتف نفسه (مو بس الـ IP): الـ limiter أعلاه يحسب حسب
// عنوان IP، وممكن يتلف (شبكة موبايل مشتركة، أو مهاجم يغيّر IP كل مرة). هذا يمنع
// إغراق رقم معيّن برسائل متكررة مهما كان مصدر الطلب.
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

const TABLES = {
  employee: { table: "employees", nameCol: "name",          activeClause: "AND is_active" },
  customer: { table: "customers", nameCol: "business_name", activeClause: "AND status = 'approved'" },
  supplier: { table: "suppliers", nameCol: "business_name", activeClause: "AND status = 'approved'" },
};

const requestSchema = z.object({
  accountType: z.enum(["employee", "customer", "supplier"]),
  phone: z.string().min(9),
});

authRouter.post("/otp/request", otpLimiter, asyncRoute(async (req, res) => {
  const { accountType, phone } = requestSchema.parse(req.body);
  const cfg = TABLES[accountType];
  const normalized = normalizePhone(phone);
  const statusCol = accountType === "employee" ? "is_active" : "status";

  // سقف حسب الرقم نفسه — قبل أي شي ثاني، عشان يحمي حتى لو المهاجم يجرب أرقام
  // مو مسجّلة بالنظام
  await checkOtpPhoneLimit(normalized, accountType);

  const { rows } = await query(
    `SELECT id, ${cfg.nameCol} AS name, ${statusCol} AS account_status
       FROM ${cfg.table} WHERE phone = $1 LIMIT 1`,
    [normalized]
  );

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

  const otp = generateOtp();
  const hash = await hashOtp(otp);
  await query(
    `UPDATE ${cfg.table}
        SET otp_hash = $1, otp_expires_at = now() + interval '5 minutes'
      WHERE id = $2`,
    [hash, user.id]
  );

  if (process.env.NODE_ENV !== "production") console.log(`[OTP] ${normalized} → ${otp}`);

  // إرسال الرمز عبر واتساب (سيرفس Baileys المستقل) — لا نوقف الطلب لو فشل الإرسال،
  // فقط نسجّل الخطأ، عشان مشكلة مؤقتة بواتساب ما توقفش تسجيل الدخول بالكامل
  if (process.env.WHATSAPP_SERVICE_URL && process.env.WHATSAPP_SECRET_KEY) {
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

  res.json({ sent: true, message: "تم إرسال رمز التحقق" });
}));

const verifySchema = requestSchema.extend({ otp: z.string().length(4) });

authRouter.post("/otp/verify", otpLimiter, asyncRoute(async (req, res) => {
  const { accountType, phone, otp } = verifySchema.parse(req.body);
  const cfg = TABLES[accountType];
  const normalized = normalizePhone(phone);
  const statusCol = accountType === "employee" ? "is_active" : "status";

  const { rows } = await query(
    `SELECT id, ${cfg.nameCol} AS name, otp_hash, otp_expires_at, ${statusCol} AS account_status
       FROM ${cfg.table} WHERE phone = $1 LIMIT 1`,
    [normalized]
  );

  const user = rows[0];

  const isBlocked = user && (accountType === "employee"
    ? user.account_status === false
    : user.account_status === "suspended");

  if (isBlocked) {
    throw new ApiError(403, "تم إيقاف هذا الحساب، يرجى التواصل مع الدعم الفني");
  }

  if (!user?.otp_hash || new Date(user.otp_expires_at) < new Date()) {
    throw new ApiError(401, "الرمز غير صالح أو منتهي الصلاحية");
  }
  if (!(await verifyOtp(otp, user.otp_hash))) {
    throw new ApiError(401, "الرمز غير صحيح");
  }

  let role = null;
  if (accountType === "employee") {
    const r = await query(
      `SELECT r.code FROM employees e JOIN roles r ON r.id = e.role_id WHERE e.id = $1`,
      [user.id]
    );
    role = r.rows[0]?.code || null;
  }

  await withTransaction(async (client) => {
    await client.query(
      `UPDATE ${cfg.table} SET otp_hash = NULL, otp_expires_at = NULL
       ${accountType === "employee" ? ", last_login_at = now()" : ""}
        WHERE id = $1`,
      [user.id]
    );
    await writeAudit(client, {
      actorType: accountType, actorId: user.id, actorName: user.name,
      action: "auth.login", entityType: accountType, entityId: user.id,
      entityLabel: user.name, ip: req.ip,
    });
  });

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
