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

  const { rows } = await query(
    `SELECT id, ${cfg.nameCol} AS name, ${statusCol} AS account_status
       FROM ${cfg.table} WHERE phone = $1 LIMIT 1`,
    [normalized]
  );

  if (!rows.length) {
    return res.json({ sent: true, message: "إذا كان الرقم مسجلًا فستصلك رسالة تحقق" });
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
    return res.json({ sent: true, message: "إذا كان الرقم مسجلًا فستصلك رسالة تحقق" });
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
      `SELECT s.id, s.name, s.slug
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
      `SELECT s.id, s.name, s.slug
         FROM customer_sections cs
         JOIN sections s ON s.id = cs.section_id
        WHERE cs.customer_id = $1 AND cs.enabled AND s.is_active
        ORDER BY s.sort_order`,
      [req.actor.id]
    );
    return res.json({ actor: req.actor, sections: rows });
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
    return res.json({ actor: req.actor, permissions: rows.map((r) => r.code) });
  }

  res.json({ actor: req.actor });
}));
