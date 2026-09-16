import { Router } from "express";
import { z } from "zod";
import { pool, query, withTransaction, writeAudit } from "../lib/db.js";
import { ApiError, asyncRoute, resolvePrice } from "../lib/helpers.js";
import { authenticate, requirePermission, requireActorType, assertCustomerSection } from "../middleware/auth.js";

export const catalogRouter = Router();
catalogRouter.use(authenticate);

catalogRouter.get("/sections", asyncRoute(async (req, res) => {
  if (req.actor.type === "customer") {
    const { rows } = await query(
      `SELECT s.id, s.name, s.slug
         FROM customer_sections cs
         JOIN sections s ON s.id = cs.section_id
        WHERE cs.customer_id = $1 AND cs.enabled AND s.is_active
        ORDER BY s.sort_order`,
      [req.actor.id]
    );
    return res.json(rows);
  }
  const { rows } = await query(
    `SELECT id, name, slug, is_active FROM sections ORDER BY sort_order`
  );
  res.json(rows);
}));

catalogRouter.post("/sections", requirePermission("accounts.sections"), asyncRoute(async (req, res) => {
  const body = z.object({
    name: z.string().min(2),
    slug: z.string().min(2).regex(/^[a-z0-9-]+$/),
    sortOrder: z.number().int().optional(),
  }).parse(req.body);

  const section = await withTransaction(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO sections (name, slug, sort_order, created_by)
       VALUES ($1,$2,COALESCE($3, 0),$4) RETURNING *`,
      [body.name, body.slug, body.sortOrder, req.actor.id]
    );
    await writeAudit(client, {
      actorType: "employee", actorId: req.actor.id, actorName: req.actor.name,
      action: "section.created", entityType: "section", entityId: rows[0].id,
      entityLabel: body.name, after: rows[0], ip: req.ip,
    });
    return rows[0];
  });

  res.status(201).json(section);
}));

catalogRouter.get("/products", asyncRoute(async (req, res) => {
  const { sectionId, supplierId, search } = req.query;

  if (req.actor.type === "customer") {
    if (!sectionId) throw new ApiError(400, "يجب تحديد القسم");
    await assertCustomerSection(req.actor.id, sectionId);

    const { rows } = await query(
      `SELECT p.id, p.name, p.unit, p.image_url, p.base_price, p.stock_qty,
              p.availability, s.business_name AS supplier_name, p.supplier_id
         FROM products p
         JOIN suppliers s ON s.id = p.supplier_id
        WHERE p.section_id = $1
          AND p.is_active
          AND s.status = 'approved'
          AND ($2::UUID IS NULL OR p.supplier_id = $2)
          AND ($3::TEXT IS NULL OR p.name ILIKE '%' || $3 || '%')
        ORDER BY p.name`,
      [sectionId, supplierId || null, search || null]
    );

    const priced = await Promise.all(
      rows.map(async (p) => {
        const { base_price, ...rest } = p;
        const price = await resolvePrice(pool, {
          productId: p.id, customerId: req.actor.id, qty: 1,
        }).catch(() => base_price);
        return { ...rest, price };
      })
    );
    return res.json(priced);
  }

  const ownerFilter = req.actor.type === "supplier" ? req.actor.id : supplierId || null;
  const { rows } = await query(
    `SELECT p.*, s.business_name AS supplier_name, sec.name AS section_name
       FROM products p
       JOIN suppliers s  ON s.id = p.supplier_id
       JOIN sections sec ON sec.id = p.section_id
      WHERE ($1::UUID IS NULL OR p.supplier_id = $1)
        AND ($2::UUID IS NULL OR p.section_id  = $2)
        AND ($3::TEXT IS NULL OR p.name ILIKE '%' || $3 || '%')
      ORDER BY p.name`,
    [ownerFilter, sectionId || null, search || null]
  );
  res.json(rows);
}));

const productSchema = z.object({
  sectionId: z.string().uuid(),
  name: z.string().min(2),
  unit: z.string().min(1),
  basePrice: z.number().positive(),
  purchaseCost: z.number().nonnegative().optional(),
  stockQty: z.number().nonnegative().default(0),
  imageUrl: z.string().url().optional(),
  supplierSku: z.string().trim().max(100).optional(),
});

catalogRouter.post("/products", asyncRoute(async (req, res, next) => {
  if (req.actor.type === "supplier") return next();
  return requirePermission("catalog.manage")(req, res, next);
}), asyncRoute(async (req, res) => {
  const body = productSchema.parse(req.body);
  const supplierId = req.actor.type === "supplier"
    ? req.actor.id
    : z.string().uuid().parse(req.body.supplierId);

  const product = await withTransaction(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO products
         (section_id, supplier_id, name, unit, base_price, purchase_cost, stock_qty, image_url, supplier_sku, added_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [body.sectionId, supplierId, body.name, body.unit, body.basePrice,
       body.purchaseCost ?? null, body.stockQty, body.imageUrl ?? null,
       body.supplierSku || null,
       req.actor.type === "employee" ? req.actor.id : null]
    );
    await writeAudit(client, {
      actorType: req.actor.type, actorId: req.actor.id, actorName: req.actor.name,
      action: "product.created", entityType: "product", entityId: rows[0].id,
      entityLabel: body.name, after: rows[0], ip: req.ip,
    });
    return rows[0];
  });

  res.status(201).json(product);
}));

catalogRouter.patch("/products/:id", asyncRoute(async (req, res) => {
  const body = z.object({
    basePrice: z.number().positive().optional(),
    purchaseCost: z.number().nonnegative().optional(),
    stockQty: z.number().nonnegative().optional(),
    isActive: z.boolean().optional(),
    supplierSku: z.string().trim().max(100).optional(),
  }).parse(req.body);

  const updated = await withTransaction(async (client) => {
    const existing = await client.query(`SELECT * FROM products WHERE id = $1 FOR UPDATE`, [req.params.id]);
    if (!existing.rows.length) throw new ApiError(404, "الصنف غير موجود");
    const before = existing.rows[0];

    if (req.actor.type === "supplier" && before.supplier_id !== req.actor.id) {
      throw new ApiError(403, "لا يمكنك تعديل صنف لا يخصك");
    }

    const { rows } = await client.query(
      `UPDATE products SET
         base_price    = COALESCE($2, base_price),
         purchase_cost = COALESCE($3, purchase_cost),
         stock_qty     = COALESCE($4, stock_qty),
         is_active     = COALESCE($5, is_active),
         supplier_sku  = COALESCE($6, supplier_sku)
       WHERE id = $1 RETURNING *`,
      [req.params.id, body.basePrice ?? null, body.purchaseCost ?? null,
       body.stockQty ?? null, body.isActive ?? null, body.supplierSku ?? null]
    );

    if (body.basePrice && body.basePrice !== before.base_price) {
      await client.query(
        `INSERT INTO price_history (product_id, old_price, new_price, changed_by, changed_by_name)
         VALUES ($1,$2,$3,$4,$5)`,
        [req.params.id, before.base_price, body.basePrice, req.actor.id, req.actor.name]
      );
    }

    await writeAudit(client, {
      actorType: req.actor.type, actorId: req.actor.id, actorName: req.actor.name,
      action: "product.updated", entityType: "product", entityId: req.params.id,
      entityLabel: before.name, before, after: rows[0], ip: req.ip,
    });
    return rows[0];
  });

  res.json(updated);
}));

// تقرير مبيعات مبسّط للمورد عن فترة محددة — يستخدمه تطبيق المورد
catalogRouter.get("/products/me/report", requireActorType("supplier"), asyncRoute(async (req, res) => {
  const period = z.enum(["today", "week", "month"]).default("week").parse(req.query.period);
  const interval = period === "today" ? "1 day" : period === "week" ? "7 days" : "30 days";

  const totals = await query(
    `SELECT COUNT(DISTINCT oi.order_id)::INT AS orders_count,
            COALESCE(SUM(oi.line_total), 0) AS total_sales
       FROM order_items oi
       JOIN order_suppliers os ON os.id = oi.order_supplier_id
       JOIN orders o           ON o.id  = oi.order_id
      WHERE os.supplier_id = $1
        AND o.status IN ('delivered','closed')
        AND o.delivered_at >= now() - $2::INTERVAL`,
    [req.actor.id, interval]
  );

  const topProducts = await query(
    `SELECT oi.product_id, oi.product_name AS name,
            SUM(oi.qty_confirmed) AS qty, SUM(oi.line_total) AS total
       FROM order_items oi
       JOIN order_suppliers os ON os.id = oi.order_supplier_id
       JOIN orders o           ON o.id  = oi.order_id
      WHERE os.supplier_id = $1
        AND o.status IN ('delivered','closed')
        AND o.delivered_at >= now() - $2::INTERVAL
      GROUP BY oi.product_id, oi.product_name
      ORDER BY total DESC
      LIMIT 10`,
    [req.actor.id, interval]
  );

  res.json({
    ordersCount: totals.rows[0].orders_count,
    totalSales: totals.rows[0].total_sales,
    topProducts: topProducts.rows,
  });
}));

// استيراد أصناف بالجملة للمورد (من نموذج إكسل تمت معالجته في الواجهة)
const importRowSchema = z.object({
  sectionId: z.string().uuid().optional(),
  name: z.string().min(2),
  unit: z.string().min(1),
  basePrice: z.number().positive(),
  stockQty: z.number().nonnegative().default(0),
  supplierSku: z.string().trim().max(100).optional(),
});

catalogRouter.post("/products/import", requireActorType("supplier"), asyncRoute(async (req, res) => {
  const { rows: inputRows } = z.object({
    rows: z.array(importRowSchema).min(1).max(500),
  }).parse(req.body);

  const result = await withTransaction(async (client) => {
    const created = [];
    const skipped = [];

    for (const row of inputRows) {
      if (!row.sectionId) {
        skipped.push({ name: row.name, reason: "القسم غير مطابق لأقسامك المعتمدة" });
        continue;
      }
      try {
        const { rows } = await client.query(
          `INSERT INTO products
             (section_id, supplier_id, name, unit, base_price, stock_qty, supplier_sku)
           VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
          [row.sectionId, req.actor.id, row.name, row.unit, row.basePrice,
           row.stockQty, row.supplierSku || null]
        );
        created.push(rows[0]);
      } catch (e) {
        skipped.push({ name: row.name, reason: "تعذّر إضافة الصنف" });
      }
    }

    if (created.length) {
      await writeAudit(client, {
        actorType: "supplier", actorId: req.actor.id, actorName: req.actor.name,
        action: "products.imported", entityType: "product", entityId: req.actor.id,
        entityLabel: `استيراد ${created.length} صنف عبر إكسل`, after: { count: created.length }, ip: req.ip,
      });
    }

    return { created, skipped };
  });

  res.status(201).json({
    createdCount: result.created.length,
    skippedCount: result.skipped.length,
    created: result.created,
    skipped: result.skipped,
  });
}));

catalogRouter.get("/products/:id/movement", requirePermission("reports.view"), asyncRoute(async (req, res) => {
  const info = await query(
    `SELECT p.id, p.name, p.unit, p.added_at, s.business_name AS supplier_name,
            sec.name AS section_name
       FROM products p
       JOIN suppliers s  ON s.id = p.supplier_id
       JOIN sections sec ON sec.id = p.section_id
      WHERE p.id = $1`,
    [req.params.id]
  );
  if (!info.rows.length) throw new ApiError(404, "الصنف غير موجود");

  const movement = await query(
    `SELECT order_number, sold_on, qty, unit_price, line_total, gross_margin
       FROM v_item_movement
      WHERE product_id = $1
      ORDER BY sold_on DESC`,
    [req.params.id]
  );

  res.json({ product: info.rows[0], movement: movement.rows });
}));

catalogRouter.get("/suppliers", asyncRoute(async (req, res) => {
  if (req.actor.type === "customer") {
    const { rows } = await query(
      `SELECT DISTINCT s.id, s.business_name AS name, sec.id AS section_id, sec.name AS section_name
         FROM suppliers s
         JOIN products p        ON p.supplier_id = s.id AND p.is_active
         JOIN sections sec      ON sec.id = p.section_id
         JOIN customer_sections cs ON cs.section_id = sec.id
                                  AND cs.customer_id = $1 AND cs.enabled
        WHERE s.status = 'approved'
        ORDER BY s.business_name`,
      [req.actor.id]
    );
    return res.json(rows);
  }

  const { rows } = await query(
    `SELECT id, business_name AS name, phone, address, status, latitude, longitude
       FROM suppliers ORDER BY business_name`
  );
  res.json(rows);
}));

catalogRouter.get("/products/:id/price-rules", requirePermission("pricing.cost"), asyncRoute(async (req, res) => {
  const { rows } = await query(
    `SELECT pr.*, c.business_name AS customer_name
       FROM product_price_rules pr
       LEFT JOIN customers c ON c.id = pr.customer_id
      WHERE pr.product_id = $1
      ORDER BY (pr.customer_id IS NOT NULL) DESC, pr.min_qty`,
    [req.params.id]
  );
  res.json(rows);
}));

const priceRuleSchema = z.object({
  customerId: z.string().uuid().optional(),
  minQty: z.number().positive().default(1),
  price: z.number().positive(),
  ruleType: z.enum(["customer_special", "qty_break", "agreement"]),
  validFrom: z.string().optional(),
  validTo: z.string().optional(),
});

catalogRouter.post("/products/:id/price-rules", requirePermission("pricing.cost"), asyncRoute(async (req, res) => {
  const body = priceRuleSchema.parse(req.body);

  const rule = await withTransaction(async (client) => {
    const prod = await client.query(`SELECT name FROM products WHERE id = $1`, [req.params.id]);
    if (!prod.rows.length) throw new ApiError(404, "الصنف غير موجود");

    const { rows } = await client.query(
      `INSERT INTO product_price_rules
         (product_id, customer_id, min_qty, price, rule_type, valid_from, valid_to, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [req.params.id, body.customerId ?? null, body.minQty, body.price, body.ruleType,
       body.validFrom ?? null, body.validTo ?? null, req.actor.id]
    );
    await writeAudit(client, {
      actorType: "employee", actorId: req.actor.id, actorName: req.actor.name,
      action: "price_rule.created", entityType: "product_price_rule", entityId: rows[0].id,
      entityLabel: prod.rows[0].name, after: rows[0], ip: req.ip,
    });
    return rows[0];
  });

  res.status(201).json(rule);
}));

catalogRouter.patch("/price-rules/:id", requirePermission("pricing.cost"), asyncRoute(async (req, res) => {
  const body = z.object({ isActive: z.boolean() }).parse(req.body);
  const { rows } = await query(
    `UPDATE product_price_rules SET is_active = $2 WHERE id = $1 RETURNING *`,
    [req.params.id, body.isActive]
  );
  if (!rows.length) throw new ApiError(404, "القاعدة غير موجودة");
  res.json(rows[0]);
}));
