// أدوات النظام: تهيئة جداول مساعدة تلقائيًا عند تشغيل السيرفر (آمنة للتكرار)، وسجل أخطاء السيرفر.
import express from "express";
import { pool, query } from "./db.js";
import { asyncRoute } from "./helpers.js";
import { authenticate, requirePermission } from "../middleware/auth.js";
import { notifyStaffInApp } from "./notify.js";

/* ------------------------------------------------------------------ *
 * تهيئة قاعدة البيانات (idempotent) — كل خطوة لحالها، فشل واحدة ما يوقف الباقي
 * ------------------------------------------------------------------ */
const STEPS = [
  // سجل ترحيلات "مرة واحدة"
  `CREATE TABLE IF NOT EXISTS app_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
  // إشعارات داخل التطبيق بدون قالب
  `ALTER TABLE notifications ALTER COLUMN template_code DROP NOT NULL`,
  // سجل أخطاء السيرفر
  `CREATE TABLE IF NOT EXISTS error_log (
     id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     fingerprint  TEXT NOT NULL,
     method       TEXT,
     path         TEXT,
     status       INT,
     message      TEXT,
     stack        TEXT,
     actor_type   TEXT,
     actor_name   TEXT,
     occurrences  INT NOT NULL DEFAULT 1,
     first_seen   TIMESTAMPTZ NOT NULL DEFAULT now(),
     last_seen    TIMESTAMPTZ NOT NULL DEFAULT now(),
     resolved_at  TIMESTAMPTZ
   )`,
  `CREATE INDEX IF NOT EXISTS error_log_fp_idx ON error_log (fingerprint) WHERE resolved_at IS NULL`,
  `CREATE INDEX IF NOT EXISTS error_log_seen_idx ON error_log (last_seen DESC)`,
  // اقتراح حل النقص وموافقة العميل
  `ALTER TABLE order_shortages ADD COLUMN IF NOT EXISTS proposed_resolution TEXT`,
  `ALTER TABLE order_shortages ADD COLUMN IF NOT EXISTS proposed_substitute_product_id UUID`,
  `ALTER TABLE order_shortages ADD COLUMN IF NOT EXISTS proposed_substitute_variant_id UUID`,
  `ALTER TABLE order_shortages ADD COLUMN IF NOT EXISTS proposed_by UUID`,
  `ALTER TABLE order_shortages ADD COLUMN IF NOT EXISTS proposed_at TIMESTAMPTZ`,
  `ALTER TABLE order_shortages ADD COLUMN IF NOT EXISTS customer_response TEXT`,
  `ALTER TABLE order_shortages ADD COLUMN IF NOT EXISTS customer_responded_at TIMESTAMPTZ`,
  // ترقيم الطلبيات بتسلسل داخل القاعدة (يبدأ بعد أكبر رقم موجود)
  `DO $$ BEGIN
     IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relkind = 'S' AND relname = 'order_number_seq') THEN
       EXECUTE format('CREATE SEQUENCE order_number_seq START %s',
         (SELECT GREATEST(COALESCE(MAX(NULLIF(regexp_replace(order_number, '\\D', '', 'g'), '')::BIGINT), 3000), 3000) + 1 FROM orders));
     END IF;
   END $$`,
];

// تقليل إشعارات واتساب: الباقي يبقى داخل التطبيق فقط (مرة واحدة فقط، ثم تقدر تعدّلها من القاعدة)
const ONCE = [
  ["whatsapp_trim_v1", `UPDATE notification_templates SET send_whatsapp = FALSE
     WHERE code IN ('delivery.scheduled','order.ready','invoice.issued','message.received','feedback.resolved','product.restocked','stock.new_arrival')`],
];

export async function ensureSchema() {
  for (const sql of STEPS) {
    try { await pool.query(sql); }
    catch (e) { console.error("[schema]", e.message, "|", sql.slice(0, 60).replace(/\s+/g, " ")); }
  }
  // صلاحية جديدة: عرض سجل أخطاء السيرفر (تنعطى تلقائيًا لمن عنده إدارة الموظفين)
  try {
    await pool.query(`INSERT INTO permissions (code, description) VALUES ('system.errors','عرض سجل أخطاء النظام') ON CONFLICT (code) DO NOTHING`);
    await pool.query(
      `INSERT INTO role_permissions (role_id, permission_id)
       SELECT rp.role_id, (SELECT id FROM permissions WHERE code='system.errors')
         FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id AND p.code = 'employees.manage'
       ON CONFLICT DO NOTHING`
    );
  } catch (e) { console.error("[schema-perm]", e.message); }
  // تقسيم صلاحية «إدارة الأصناف والتوصيل والبانرات»: صلاحيتان جديدتان تنعطيان لكل دور كان يملك catalog.manage (ما يتغير شي على أحد)
  try {
    await pool.query(`INSERT INTO permissions (code, description) VALUES
      ('delivery.manage','إدارة مناطق التوصيل وأنواع السيارات والأسعار'),
      ('banners.manage','إدارة البانرات الترويجية') ON CONFLICT (code) DO NOTHING`);
    for (const code of ["delivery.manage", "banners.manage"]) {
      await pool.query(
        `INSERT INTO role_permissions (role_id, permission_id)
         SELECT rp.role_id, (SELECT id FROM permissions WHERE code = $1)
           FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id AND p.code = 'catalog.manage'
         ON CONFLICT DO NOTHING`, [code]);
      // الاستثناءات الفردية (منح/سحب) على catalog.manage تنتقل للصلاحية الجديدة مرة واحدة
      await pool.query(
        `INSERT INTO employee_permission_overrides (employee_id, permission_id, granted)
         SELECT o.employee_id, (SELECT id FROM permissions WHERE code = $1), o.granted
           FROM employee_permission_overrides o JOIN permissions p ON p.id = o.permission_id AND p.code = 'catalog.manage'
         ON CONFLICT DO NOTHING`, [code]);
    }
    await pool.query(`UPDATE permissions SET description = 'إدارة الأصناف والمخزون' WHERE code = 'catalog.manage'`);
  } catch (e) { console.error("[schema-perm2]", e.message); }
  // المدير العام يملك كل الصلاحيات دائمًا، حتى الجديدة اللي تنضاف لاحقًا (تتزامن عند كل تشغيل)
  try {
    await pool.query(
      `INSERT INTO role_permissions (role_id, permission_id)
       SELECT r.id, p.id FROM roles r CROSS JOIN permissions p
        WHERE r.code = 'general_manager' OR r.name IN ('المدير العام','مدير عام')
       ON CONFLICT DO NOTHING`
    );
  } catch (e) { console.error("[schema-gm-perms]", e.message); }
  for (const [name, sql] of ONCE) {
    try {
      const { rows } = await pool.query(`INSERT INTO app_migrations (name) VALUES ($1) ON CONFLICT DO NOTHING RETURNING name`, [name]);
      if (rows.length) await pool.query(sql);
    } catch (e) { console.error("[schema-once]", name, e.message); }
  }
}

/* ------------------------------------------------------------------ *
 * تسجيل الأخطاء
 * ------------------------------------------------------------------ */
const normalizePath = (p) => String(p || "")
  .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ":id")
  .replace(/\/\d+/g, "/:n").slice(0, 200);

let lastAlertAt = 0;

export async function logServerError({ req = null, err, status = 500 }) {
  try {
    const method = req?.method ?? null;
    const path = normalizePath(req?.originalUrl?.split("?")[0] ?? req?.path ?? "");
    const message = String(err?.message || err || "unknown").slice(0, 500);
    const stack = String(err?.stack || "").slice(0, 4000);
    const fp = `${method}|${path}|${message.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/gi, ":id").slice(0, 120)}`;
    const actor = req?.actor;
    const { rows } = await pool.query(
      `UPDATE error_log SET occurrences = occurrences + 1, last_seen = now(), status = $2
        WHERE fingerprint = $1 AND resolved_at IS NULL RETURNING id`, [fp, status]
    );
    if (rows.length) return;
    await pool.query(
      `INSERT INTO error_log (fingerprint, method, path, status, message, stack, actor_type, actor_name)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [fp, method, path, status, message, stack, actor?.type ?? null, actor?.name ?? null]
    );
    // تنبيه المدير داخل التطبيق (مرة كل 5 دقايق على الأكثر حتى ما نغرقوش)
    if (Date.now() - lastAlertAt > 5 * 60 * 1000) {
      lastAlertAt = Date.now();
      await notifyStaffInApp(pool, {
        permissionCode: "system.errors",
        title: "⚠️ خطأ جديد في السيرفر",
        body: `${method ?? ""} ${path} — ${message.slice(0, 120)}`,
      });
    }
    // تنظيف: نحتفظ بآخر 500 خطأ فقط
    await pool.query(`DELETE FROM error_log WHERE id IN (SELECT id FROM error_log ORDER BY last_seen DESC OFFSET 500)`);
  } catch (e) {
    console.error("[errorlog] failed:", e?.message);
  }
}

/* ------------------------------------------------------------------ *
 * واجهة الإدارة
 * ------------------------------------------------------------------ */
export const systemRouter = express.Router();
systemRouter.use(authenticate);
systemRouter.use(requirePermission("system.errors"));

systemRouter.get("/errors", asyncRoute(async (req, res) => {
  const showResolved = req.query.resolved === "1";
  const { rows } = await query(
    `SELECT id, method, path, status, message, stack, actor_type, actor_name, occurrences, first_seen, last_seen, resolved_at
       FROM error_log WHERE ($1::boolean OR resolved_at IS NULL)
      ORDER BY last_seen DESC LIMIT 200`, [showResolved]
  );
  const { rows: [c] } = await query(`SELECT COUNT(*)::INT AS open FROM error_log WHERE resolved_at IS NULL`);
  res.json({ open: c.open, items: rows });
}));

systemRouter.post("/errors/:id/resolve", asyncRoute(async (req, res) => {
  await query(`UPDATE error_log SET resolved_at = now() WHERE id = $1`, [req.params.id]);
  res.json({ ok: true });
}));

systemRouter.post("/errors/resolve-all", asyncRoute(async (_req, res) => {
  await query(`UPDATE error_log SET resolved_at = now() WHERE resolved_at IS NULL`);
  res.json({ ok: true });
}));
