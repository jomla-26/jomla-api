// تنبيهات نواقص المخزون: صنف/نوع كميته أقل من الحد → إشعار للمورد داخل التطبيق (+ Push تلقائي)، وشاشة "النواقص".
// تعمل بمهمة دورية بدل ما نربطها بكل مسارات تعديل الكمية (طلبيات، إكسل، سندات، تعديل يدوي) — كلها تتغطى.
import { pool, query } from "./db.js";
import { createInAppNotification } from "./notify.js";

export const LOW_STOCK_LIMIT = 10; // نفس حد "كمية محدودة" اللي يشوفه العميل

// كل الأصناف والأنواع الفعّالة والمعتمدة مع مستوى النقص: 2 = نفد، 1 = أوشك يخلص، 0 = سليم
export const STOCK_ITEMS_SQL = `
  SELECT * FROM (
    SELECT 'p' AS kind, p.id AS item_id, p.id AS product_id, p.supplier_id, p.name, NULL::text AS label,
           p.unit, p.stock_qty, p.low_level, p.supplier_sku AS sku
      FROM products p
     WHERE p.is_active AND p.approval_status = 'approved'
       AND NOT EXISTS (SELECT 1 FROM product_variants v WHERE v.product_id = p.id)
    UNION ALL
    SELECT 'v', v.id, p.id, p.supplier_id, p.name, v.label,
           p.unit, v.stock_qty, v.low_level, v.sku
      FROM product_variants v JOIN products p ON p.id = v.product_id
     WHERE v.is_active AND p.is_active AND p.approval_status = 'approved'
  ) x`;

const levelOf = (q) => (Number(q) <= 0 ? 2 : Number(q) < LOW_STOCK_LIMIT ? 1 : 0);
const itemTitle = (r) => (r.label ? `${r.name} — ${r.label}` : r.name);

export async function runLowStockAlerts() {
  // 1) رجوع الكمية فوق الحد (أو نزول المستوى) يصفّر العلامة بصمت، عشان ينبّه من جديد لو نقص بعدين
  for (const [tbl, kind] of [["products", "p"], ["product_variants", "v"]]) {
    await query(
      `UPDATE ${tbl} SET low_level = CASE WHEN stock_qty <= 0 THEN 2 WHEN stock_qty < $1 THEN 1 ELSE 0 END
        WHERE low_level > 0 AND low_level > CASE WHEN stock_qty <= 0 THEN 2 WHEN stock_qty < $1 THEN 1 ELSE 0 END`,
      [LOW_STOCK_LIMIT]
    );
  }
  // 2) اللي تدهور مستواه (سليم→محدود، محدود→نفد، سليم→نفد) ينبَّه عنه مرة وحدة
  const { rows } = await query(
    `${STOCK_ITEMS_SQL} WHERE (CASE WHEN stock_qty <= 0 THEN 2 WHEN stock_qty < $1 THEN 1 ELSE 0 END) > low_level
      ORDER BY supplier_id, stock_qty`,
    [LOW_STOCK_LIMIT]
  );
  if (!rows.length) return 0;

  const bySupplier = new Map();
  for (const r of rows) bySupplier.set(r.supplier_id, [...(bySupplier.get(r.supplier_id) || []), r]);

  const client = await pool.connect();
  try {
    for (const [supplierId, items] of bySupplier) {
      const out = items.filter((r) => levelOf(r.stock_qty) === 2);
      const low = items.filter((r) => levelOf(r.stock_qty) === 1);
      const fmt = (list) => list.slice(0, 6).map((r) => `${itemTitle(r)}${Number(r.stock_qty) > 0 ? ` (باقي ${Number(r.stock_qty)})` : ""}`).join("، ")
        + (list.length > 6 ? ` و${list.length - 6} أصناف أخرى` : "");
      const parts = [];
      if (out.length) parts.push(`نفدت (${out.length}): ${fmt(out)}`);
      if (low.length) parts.push(`أوشكت تخلص (${low.length}): ${fmt(low)}`);
      try {
        await client.query("BEGIN");
        await createInAppNotification(client, {
          recipientType: "supplier", recipientId: supplierId,
          title: out.length ? "نواقص في مخزونك" : "أصناف أوشكت تخلص",
          body: parts.join("\n") + "\nراجع شاشة «النواقص» وحدّث الكميات.",
        });
        for (const [kind, tbl] of [["p", "products"], ["v", "product_variants"]]) {
          for (const lv of [1, 2]) {
            const ids = items.filter((r) => r.kind === kind && levelOf(r.stock_qty) === lv).map((r) => r.item_id);
            if (ids.length) await client.query(`UPDATE ${tbl} SET low_level = $2 WHERE id = ANY($1::uuid[])`, [ids, lv]);
          }
        }
        await client.query("COMMIT");
      } catch (e) {
        await client.query("ROLLBACK").catch(() => {});
        console.error("[LowStock]", e.message);
      }
    }
  } finally {
    client.release();
  }
  return rows.length;
}
