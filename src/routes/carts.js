import { Router } from "express";
import { z } from "zod";
import { query, withTransaction, writeAudit } from "../lib/db.js";
import { ApiError, asyncRoute } from "../lib/helpers.js";
import { authenticate, requireActorType, requirePermission } from "../middleware/auth.js";
import { ensureCartsAndSearchTables } from "../lib/bootstrap.js";
import { resolveCartLines } from "./orders.js";

export const cartRouter = Router();
cartRouter.use(authenticate);

// نفس سقف الكمية في orders.js (MAX_LINE_QTY)
const MAX_LINE_QTY = 100000;

// الموظف الذي ينشئ طلبيات نيابة عن العميل (admin-create) يحتاج orders.review
const CART_STAFF_PERMISSION = "orders.review";

const ensure = () => ensureCartsAndSearchTables().catch((e) => console.error("[carts] ensure:", e?.message));

const putSchema = z.object({
  items: z.array(z.object({
    productId: z.string().uuid(),
    variantId: z.string().uuid().nullish(),
    qty: z.number().positive().max(MAX_LINE_QTY),
  })).max(100),
});

cartRouter.get("/me", requireActorType("customer"), asyncRoute(async (req, res) => {
  await ensure();
  const { rows } = await query(`SELECT items, updated_at FROM customer_carts WHERE customer_id = $1`, [req.actor.id]);
  if (!rows.length) return res.json({ items: [], updatedAt: null });
  const raw = Array.isArray(rows[0].items) ? rows[0].items : [];
  const items = raw.map((i) => ({ productId: i.productId, variantId: i.variantId ?? null, qty: Number(i.qty) }));
  res.json({ items, updatedAt: rows[0].updated_at });
}));

cartRouter.put("/me", requireActorType("customer"), asyncRoute(async (req, res) => {
  const body = putSchema.parse(req.body);
  await ensure();
  if (!body.items.length) {
    await query(`DELETE FROM customer_carts WHERE customer_id = $1`, [req.actor.id]);
    return res.json({ ok: true });
  }
  // دمج الأسطر المكررة (نفس الصنف/النوع) مع احترام السقف
  const merged = new Map();
  for (const i of body.items) {
    const key = `${i.productId}|${i.variantId || ""}`;
    const prev = merged.get(key);
    const qty = Math.min((prev?.qty ?? 0) + i.qty, MAX_LINE_QTY);
    merged.set(key, { productId: i.productId, variantId: i.variantId || null, qty });
  }
  await query(
    `INSERT INTO customer_carts (customer_id, items, updated_at)
     VALUES ($1, $2::jsonb, now())
     ON CONFLICT (customer_id) DO UPDATE SET items = EXCLUDED.items, updated_at = now()`,
    [req.actor.id, JSON.stringify([...merged.values()])]
  );
  res.json({ ok: true });
}));

cartRouter.get("/customer/:customerId", requirePermission(CART_STAFF_PERMISSION), asyncRoute(async (req, res) => {
  const customerId = z.string().uuid().parse(req.params.customerId);
  await ensure();
  const { rows: c } = await query(`SELECT id, business_name FROM customers WHERE id = $1`, [customerId]);
  if (!c.length) throw new ApiError(404, "العميل غير موجود");
  const { rows } = await query(`SELECT items, updated_at FROM customer_carts WHERE customer_id = $1`, [customerId]);
  const base = { customerId, customerName: c[0].business_name, updatedAt: rows[0]?.updated_at ?? null };
  const raw = Array.isArray(rows[0]?.items) ? rows[0].items : [];
  if (!raw.length) return res.json({ ...base, lines: [], unavailable: [] });
  const wanted = raw.map((i) => ({ product_id: i.productId, variant_id: i.variantId || null, qty: Number(i.qty) }));
  const r = await resolveCartLines(customerId, wanted);
  res.json({ ...base, lines: r.items, unavailable: r.unavailable });
}));

cartRouter.delete("/customer/:customerId", requirePermission(CART_STAFF_PERMISSION), asyncRoute(async (req, res) => {
  const customerId = z.string().uuid().parse(req.params.customerId);
  await ensure();
  await withTransaction(async (client) => {
    const { rows } = await client.query(`DELETE FROM customer_carts WHERE customer_id = $1 RETURNING items`, [customerId]);
    await writeAudit(client, {
      actorType: req.actor.type, actorId: req.actor.id, actorName: req.actor.name,
      action: "cart.cleared", entityType: "customer", entityId: customerId, entityLabel: null,
      before: rows.length ? { items: rows[0].items } : null, after: null, ip: req.ip,
    });
  });
  res.json({ ok: true });
}));
