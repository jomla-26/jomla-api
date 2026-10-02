import { Router } from "express";
import { z } from "zod";
import { pool, query, withTransaction, writeAudit } from "../lib/db.js";
import { ApiError, asyncRoute, resolvePrice, nextDocNumber } from "../lib/helpers.js";
import { authenticate, requirePermission, requireAnyPermission, requireActorType, assertCustomerSection } from "../middleware/auth.js";
import { notifyFavoriteRestock } from "../lib/notify.js";

export const catalogRouter = Router();
catalogRouter.use(authenticate);

catalogRouter.get("/sections", asyncRoute(async (req, res) => {
  const { parentId } = req.query;

  if (req.actor.type === "customer") {
    if (parentId) {
      // تصنيفات فرعية تحت قسم رئيسي — تظهر تلقائيًا لو القسم الرئيسي مفعّل للعميل
      const { rows } = await query(
        `SELECT s.id, s.name, s.slug, s.image_url
           FROM sections s
           JOIN customer_sections cs ON cs.section_id = $2
          WHERE s.parent_id = $2 AND s.is_active
            AND cs.customer_id = $1 AND cs.enabled
          ORDER BY s.sort_order`,
        [req.actor.id, parentId]
      );
      return res.json(rows);
    }
    const { rows } = await query(
      `SELECT s.id, s.name, s.slug, s.image_url,
              EXISTS(SELECT 1 FROM sections c WHERE c.parent_id = s.id AND c.is_active) AS has_subsections
         FROM customer_sections cs
         JOIN sections s ON s.id = cs.section_id
        WHERE cs.customer_id = $1 AND cs.enabled AND s.is_active AND s.parent_id IS NULL
        ORDER BY s.sort_order`,
      [req.actor.id]
    );
    return res.json(rows);
  }
  if (req.actor.type === "supplier") {
    if (parentId) {
      const { rows } = await query(
        `SELECT s.id, s.name, s.slug, s.image_url, s.is_active
           FROM sections s
           JOIN supplier_sections ss ON ss.section_id = $2
          WHERE s.parent_id = $2 AND ss.supplier_id = $1 AND ss.enabled
          ORDER BY s.sort_order`,
        [req.actor.id, parentId]
      );
      return res.json(rows);
    }
    const { rows } = await query(
      `SELECT s.id, s.name, s.slug, s.image_url, s.is_active,
              EXISTS(SELECT 1 FROM sections c WHERE c.parent_id = s.id AND c.is_active) AS has_subsections
         FROM supplier_sections ss
         JOIN sections s ON s.id = ss.section_id
        WHERE ss.supplier_id = $1 AND s.is_active AND s.parent_id IS NULL
        ORDER BY s.sort_order`,
      [req.actor.id]
    );
    return res.json(rows);
  }

  // موظف/إدارة: بلا parentId تُرجع الأقسام الرئيسية فقط (بالإضافة لعلامة إذا عندها فروع)،
  // ومع parentId تُرجع التصنيفات الفرعية لذلك القسم. flat=1 يرجع كل الأقسام (رئيسي+فرعي) للبحث والقوائم المنسدلة.
  if (req.query.flat) {
    if (req.query.supplierId) {
      // أقسام المورد المخصصة له فقط (والفرعية تحتها)
      const { rows } = await query(
        `SELECT id, name, slug, image_url, is_active, parent_id FROM sections
          WHERE is_active AND (
            id IN (SELECT section_id FROM supplier_sections WHERE supplier_id = $1 AND enabled)
            OR parent_id IN (SELECT section_id FROM supplier_sections WHERE supplier_id = $1 AND enabled))
          ORDER BY sort_order`,
        [req.query.supplierId]
      );
      return res.json(rows);
    }
    const { rows } = await query(
      `SELECT id, name, slug, image_url, is_active, parent_id FROM sections ORDER BY sort_order`
    );
    return res.json(rows);
  }
  if (parentId) {
    const { rows } = await query(
      `SELECT id, name, slug, image_url, is_active, parent_id FROM sections WHERE parent_id = $1 ORDER BY sort_order`,
      [parentId]
    );
    return res.json(rows);
  }
  const { rows } = await query(
    `SELECT s.id, s.name, s.slug, s.image_url, s.is_active, s.parent_id,
            EXISTS(SELECT 1 FROM sections c WHERE c.parent_id = s.id) AS has_subsections
       FROM sections s WHERE s.parent_id IS NULL ORDER BY s.sort_order`
  );
  res.json(rows);
}));

catalogRouter.post("/sections", requirePermission("accounts.sections"), asyncRoute(async (req, res) => {
  const body = z.object({
    name: z.string().min(2),
    slug: z.string().optional(),
    sortOrder: z.number().int().optional(),
    imageUrl: z.string().url().optional().or(z.literal("").transform(() => undefined)),
    parentId: z.string().uuid().optional(),
  }).parse(req.body);

  const section = await withTransaction(async (client) => {
    if (body.parentId) {
      const parent = await client.query(`SELECT id, parent_id FROM sections WHERE id = $1`, [body.parentId]);
      if (!parent.rows.length) throw new ApiError(404, "القسم الرئيسي غير موجود");
      if (parent.rows[0].parent_id) throw new ApiError(400, "لا يمكن إضافة تصنيف فرعي تحت تصنيف فرعي آخر");
    }
    // المعرّف يتولّد تلقائيًا — ما نطلبوش من المستخدم
    let slug = String(body.slug || "").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
    if (slug.length < 2) slug = `section-${Math.random().toString(36).slice(2, 8)}`;
    while ((await client.query(`SELECT 1 FROM sections WHERE slug = $1`, [slug])).rows.length) {
      slug = `${slug}-${Math.random().toString(36).slice(2, 5)}`;
    }
    body.slug = slug;
    const { rows } = await client.query(
      `INSERT INTO sections (name, slug, sort_order, image_url, created_by, parent_id)
       VALUES ($1,$2,COALESCE($3, 0),$4,$5,$6) RETURNING *`,
      [body.name, body.slug, body.sortOrder, body.imageUrl ?? null, req.actor.id, body.parentId ?? null]
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

catalogRouter.patch("/sections/:id", requirePermission("accounts.sections"), asyncRoute(async (req, res) => {
  const body = z.object({
    name: z.string().min(2).optional(),
    isActive: z.boolean().optional(),
    imageUrl: z.string().url().optional(),
  }).parse(req.body);

  const result = await withTransaction(async (client) => {
    const before = await client.query(`SELECT * FROM sections WHERE id = $1 FOR UPDATE`, [req.params.id]);
    if (!before.rows.length) throw new ApiError(404, "القسم غير موجود");

    const { rows } = await client.query(
      `UPDATE sections SET
         name = COALESCE($2, name),
         is_active = COALESCE($3, is_active),
         image_url = COALESCE($4, image_url)
       WHERE id = $1 RETURNING *`,
      [req.params.id, body.name ?? null, body.isActive ?? null, body.imageUrl ?? null]
    );

    await writeAudit(client, {
      actorType: "employee", actorId: req.actor.id, actorName: req.actor.name,
      action: "section.updated", entityType: "section", entityId: req.params.id,
      entityLabel: rows[0].name, before: before.rows[0], after: rows[0], ip: req.ip,
    });
    return rows[0];
  });

  res.json(result);
}));

catalogRouter.get("/products", asyncRoute(async (req, res) => {
  const { sectionId, supplierId, search, approvalStatus } = req.query;

  if (req.actor.type === "customer") {
    if (!sectionId) throw new ApiError(400, "يجب تحديد القسم");
    await assertCustomerSection(req.actor.id, sectionId);

    const { rows } = await query(
      `SELECT p.id, p.name, p.unit, p.image_url, p.base_price, p.stock_qty,
              CASE WHEN p.availability = 'suspended' THEN 'suspended'
                   WHEN pv.total IS NULL THEN p.availability
                   WHEN pv.total <= 0 THEN 'out'
                   WHEN pv.total < 10 THEN 'low'
                   ELSE 'available' END AS availability,
              s.business_name AS supplier_name, p.supplier_id,
              COALESCE(pv.variants, '[]'::json) AS variants
         FROM products p
         JOIN suppliers s ON s.id = p.supplier_id
         JOIN sections psec ON psec.id = p.section_id
         LEFT JOIN LATERAL (
               SELECT json_agg(json_build_object(
                        'id', v.id, 'label', v.label, 'price', v.price,
                        'stockQty', v.stock_qty, 'imageUrl', v.image_url
                      ) ORDER BY v.sort_order, v.created_at) AS variants,
                      SUM(v.stock_qty) AS total
                 FROM product_variants v
                WHERE v.product_id = p.id AND v.is_active
             ) pv ON true
        WHERE (p.section_id = $1 OR psec.parent_id = $1)
          AND p.is_active
          AND p.approval_status = 'approved'
          AND s.status = 'approved'
          AND EXISTS (
                SELECT 1 FROM supplier_sections ss
                 WHERE ss.supplier_id = p.supplier_id
                   AND ss.section_id = COALESCE(psec.parent_id, p.section_id)
                   AND ss.enabled
              )
          AND ($2::UUID IS NULL OR p.supplier_id = $2)
          AND ($3::TEXT IS NULL OR p.name ILIKE '%' || $3 || '%')
        ORDER BY p.name`,
      [sectionId, supplierId || null, search || null]
    );

    const priced = await Promise.all(
      rows.map(async (p) => {
        const { base_price, ...rest } = p;
        // الصنف اللي عنده خيارات: سعره وكميته الفعليين على مستوى كل خيار لحاله، مش الصنف الأساسي
        if (rest.variants?.length) return { ...rest, price: null };
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
    `SELECT p.*, s.business_name AS supplier_name, sec.name AS section_name,
            CASE WHEN p.availability = 'suspended' THEN 'suspended'
                 WHEN pv.total IS NULL THEN p.availability
                 WHEN pv.total <= 0 THEN 'out'
                 WHEN pv.total < 10 THEN 'low'
                 ELSE 'available' END AS availability,
            COALESCE(pv.variants, '[]'::json) AS variants,
            COALESCE(pv.total, p.stock_qty) AS stock_qty,
            p.stock_qty AS unallocated_qty
       FROM products p
       JOIN suppliers s  ON s.id = p.supplier_id
       JOIN sections sec ON sec.id = p.section_id
       LEFT JOIN LATERAL (
             SELECT json_agg(json_build_object(
                      'id', v.id, 'label', v.label, 'price', v.price,
                      'stockQty', v.stock_qty, 'imageUrl', v.image_url, 'sku', v.sku
                    ) ORDER BY v.sort_order, v.created_at) AS variants,
                    SUM(v.stock_qty) AS total
               FROM product_variants v
              WHERE v.product_id = p.id AND v.is_active
           ) pv ON true
      WHERE ($1::UUID IS NULL OR p.supplier_id = $1)
        AND ($2::UUID IS NULL OR p.section_id = $2 OR sec.parent_id = $2)
        AND ($3::TEXT IS NULL OR p.name ILIKE '%' || $3 || '%'
             OR p.supplier_sku ILIKE '%' || $3 || '%'
             OR s.business_name ILIKE '%' || $3 || '%')
        AND ($4::TEXT IS NULL OR p.approval_status = $4)
      ORDER BY p.name`,
    [ownerFilter, sectionId || null, search || null, approvalStatus || null]
  );
  res.json(rows);
}));

const productSchema = z.object({
  sectionId: z.string().uuid(),
  name: z.string().min(2),
  unit: z.string().min(1),
  basePrice: z.number().positive().optional(),
  purchaseCost: z.number().nonnegative().optional(),
  stockQty: z.number().nonnegative().default(0),
  imageUrl: z.string().url().optional(),
  supplierSku: z.string().trim().max(100).optional(),
  // خيارات (ألوان/مقاسات) تُضاف مع الصنف مباشرة في نفس الطلب
  variants: z.array(z.object({
    label: z.string().trim().min(1).max(150),
    price: z.number().positive(),
    purchaseCost: z.number().nonnegative().optional(),
    stockQty: z.number().nonnegative().default(0),
    sku: z.string().trim().max(100).optional(),
    imageUrl: z.string().url().optional(),
  })).max(60).optional(),
});

catalogRouter.post("/products", asyncRoute(async (req, res, next) => {
  if (req.actor.type === "supplier") return next();
  return requirePermission("catalog.manage")(req, res, next);
}), asyncRoute(async (req, res) => {
  const body = productSchema.parse(req.body);
  const variantsIn = body.variants ?? [];
  if (!variantsIn.length && !body.basePrice) throw new ApiError(400, "السعر مطلوب");
  if (new Set(variantsIn.map((v) => v.label)).size !== variantsIn.length) {
    throw new ApiError(400, "في خيارين بنفس الاسم — غيّر أحدهما");
  }
  // صنف بخيارات: سعر الصنف الأساسي = أقل سعر خيار، ومخزونه = مجموع كميات الخيارات (موزّع عليها كاملًا)
  const basePrice = variantsIn.length ? Math.min(...variantsIn.map((v) => v.price)) : body.basePrice;
  const stockQty = variantsIn.length ? 0 : body.stockQty;
  const supplierId = req.actor.type === "supplier"
    ? req.actor.id
    : z.string().uuid().parse(req.body.supplierId);

  // أصناف الموظف/الإدارة تُعتمد تلقائيًا؛ أصناف المورد الجديدة تُنتظر موافقة الإدارة قبل ما تظهر للعميل
  const approvalStatus = req.actor.type === "employee" ? "approved" : "pending";

  const product = await withTransaction(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO products
         (section_id, supplier_id, name, unit, base_price, purchase_cost, stock_qty, image_url, supplier_sku, added_by, approval_status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [body.sectionId, supplierId, body.name, body.unit, basePrice,
       body.purchaseCost ?? null, stockQty, body.imageUrl ?? variantsIn.find((v) => v.imageUrl)?.imageUrl ?? null,
       body.supplierSku || null,
       req.actor.type === "employee" ? req.actor.id : null,
       approvalStatus]
    );
    if (stockQty > 0) {
      await client.query(
        `INSERT INTO stock_movements (product_id, change_qty, reason, created_by)
         VALUES ($1,$2,'رصيد افتتاحي — صنف جديد',$3)`,
        [rows[0].id, stockQty, req.actor.id]
      );
    }
    for (const [i, v] of variantsIn.entries()) {
      const { rows: vr } = await client.query(
        `INSERT INTO product_variants
           (product_id, label, price, purchase_cost, stock_qty, sku, image_url, sort_order, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
        [rows[0].id, v.label, v.price, v.purchaseCost ?? null, v.stockQty, v.sku || null, v.imageUrl || null, i, req.actor.id]
      );
      if (v.stockQty > 0) {
        await client.query(
          `INSERT INTO stock_movements (product_id, variant_id, change_qty, reason, created_by)
           VALUES ($1,$2,$3,'رصيد افتتاحي — خيار جديد',$4)`,
          [rows[0].id, vr[0].id, v.stockQty, req.actor.id]
        );
      }
    }
    await writeAudit(client, {
      actorType: req.actor.type, actorId: req.actor.id, actorName: req.actor.name,
      action: "product.created", entityType: "product", entityId: rows[0].id,
      entityLabel: body.name, after: rows[0], ip: req.ip,
    });

    return rows[0];
  });

  res.status(201).json(product);
}));

catalogRouter.patch("/products/:id", asyncRoute(async (req, res, next) => {
  if (req.actor.type !== "supplier") {
    await new Promise((resolve, reject) => {
      requirePermission("catalog.manage")(req, res, (e) => (e ? reject(e) : resolve()));
    });
  }
  const body = z.object({
    name: z.string().min(2).optional(),
    sectionId: z.string().uuid().optional(),
    basePrice: z.number().positive().optional(),
    purchaseCost: z.number().nonnegative().optional(),
    isActive: z.boolean().optional(),
    supplierSku: z.string().trim().max(100).optional(),
    imageUrl: z.string().url().optional(),
  }).parse(req.body);

  const updated = await withTransaction(async (client) => {
    const existing = await client.query(`SELECT * FROM products WHERE id = $1 FOR UPDATE`, [req.params.id]);
    if (!existing.rows.length) throw new ApiError(404, "الصنف غير موجود");
    const before = existing.rows[0];

    if (req.actor.type === "supplier" && before.supplier_id !== req.actor.id) {
      throw new ApiError(403, "لا يمكنك تعديل صنف لا يخصك");
    }
    // تغيير القسم صلاحية إدارية فقط — المورد يقدر يعدّل صنفه لكن مو يغيّر تصنيفه
    if (body.sectionId && req.actor.type === "supplier") {
      throw new ApiError(403, "تغيير قسم الصنف من صلاحية الإدارة فقط");
    }

    const { rows } = await client.query(
      `UPDATE products SET
         name          = COALESCE($2, name),
         section_id    = COALESCE($3, section_id),
         base_price    = COALESCE($4, base_price),
         purchase_cost = COALESCE($5, purchase_cost),
         is_active     = COALESCE($6, is_active),
         supplier_sku  = COALESCE($7, supplier_sku),
         image_url     = COALESCE($8, image_url)
       WHERE id = $1 RETURNING *`,
      [req.params.id, body.name ?? null, body.sectionId ?? null, body.basePrice ?? null, body.purchaseCost ?? null,
       body.isActive ?? null, body.supplierSku ?? null, body.imageUrl ?? null]
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

// حذف صنف نهائيًا — لو له تاريخ طلبات فعلي نوقفه بس (زي الخيارات بالضبط) عشان
// الفواتير والتقارير القديمة تفضل صحيحة وما تختفيش أرقامها
catalogRouter.delete("/products/:id", asyncRoute(async (req, res, next) => {
  const { rows } = await query(`SELECT supplier_id FROM products WHERE id = $1`, [req.params.id]);
  if (!rows.length) throw new ApiError(404, "الصنف غير موجود");
  if (req.actor.type === "supplier") {
    if (rows[0].supplier_id !== req.actor.id) throw new ApiError(403, "لا يمكنك حذف صنف لا يخصك");
    return next();
  }
  return requirePermission("catalog.delete")(req, res, next);
}), asyncRoute(async (req, res) => {
  const used = await query(`SELECT 1 FROM order_items WHERE product_id = $1 LIMIT 1`, [req.params.id]);
  if (used.rows.length) {
    await query(`UPDATE products SET is_active = FALSE WHERE id = $1`, [req.params.id]);
    return res.json({ deactivated: true });
  }
  await withTransaction(async (client) => {
    const before = await client.query(`SELECT * FROM products WHERE id = $1`, [req.params.id]);
    await client.query(`DELETE FROM product_variants WHERE product_id = $1`, [req.params.id]);
    await client.query(`DELETE FROM products WHERE id = $1`, [req.params.id]);
    await writeAudit(client, {
      actorType: req.actor.type, actorId: req.actor.id, actorName: req.actor.name,
      action: "product.deleted", entityType: "product", entityId: req.params.id,
      entityLabel: before.rows[0]?.name, before: before.rows[0], ip: req.ip,
    });
  });
  res.status(204).send();
}));

/* --------------------- خيارات الصنف (ألوان/مقاسات/عبوات) ---------------------
   كل خيار له سعره وكمية مخزونه المستقلين تمامًا عن الصنف الأساسي وعن بقية الخيارات */

catalogRouter.get("/products/:id/variants", asyncRoute(async (req, res) => {
  const { rows: prod } = await query(`SELECT supplier_id FROM products WHERE id = $1`, [req.params.id]);
  if (!prod.length) throw new ApiError(404, "الصنف غير موجود");
  if (req.actor.type === "supplier" && prod[0].supplier_id !== req.actor.id) {
    throw new ApiError(403, "لا يمكنك الاطلاع على خيارات صنف لا يخصك");
  }
  const { rows } = await query(
    `SELECT * FROM product_variants WHERE product_id = $1 ORDER BY sort_order, created_at`,
    [req.params.id]
  );
  res.json(rows);
}));

const variantSchema = z.object({
  label: z.string().min(1).max(150),
  price: z.number().positive(),
  purchaseCost: z.number().nonnegative().optional(),
  stockQty: z.number().nonnegative().default(0),
  sku: z.string().trim().max(100).optional(),
  imageUrl: z.string().url().optional(),
  sortOrder: z.number().int().optional(),
});

// مخزون الصنف يتقسّم على خياراته: مجموع مخزون الخيارات ما يتعداش مخزون الصنف المتوفر
async function takeFromPool(client, productId, delta) {
  // مخزون الصنف يتقسّم على خياراته: كمية الخيار تُخصم من رصيد الصنف غير الموزّع
  // (delta موجب = يسحب من الرصيد، سالب = يرجّع له)
  if (!delta) return;
  const { rows: [p] } = await client.query(`SELECT stock_qty FROM products WHERE id = $1 FOR UPDATE`, [productId]);
  if (delta > 0 && Number(p.stock_qty) < delta) {
    throw new ApiError(400, `الكمية أكبر من المتوفر غير الموزّع على الخيارات (${p.stock_qty}). المتاح: ${p.stock_qty}`);
  }
  await client.query(`UPDATE products SET stock_qty = stock_qty - $2 WHERE id = $1`, [productId, delta]);
}

async function assertCanManageProduct(req, res, next) {
  const { rows } = await query(`SELECT supplier_id FROM products WHERE id = $1`, [req.params.id]);
  if (!rows.length) throw new ApiError(404, "الصنف غير موجود");
  if (req.actor.type === "supplier") {
    if (rows[0].supplier_id !== req.actor.id) throw new ApiError(403, "لا يمكنك تعديل صنف لا يخصك");
    return next();
  }
  return requirePermission("catalog.manage")(req, res, next);
}

catalogRouter.post("/products/:id/variants", asyncRoute(assertCanManageProduct), asyncRoute(async (req, res) => {
  const body = variantSchema.parse(req.body);

  const variant = await withTransaction(async (client) => {
    await takeFromPool(client, req.params.id, body.stockQty);
    const { rows } = await client.query(
      `INSERT INTO product_variants
         (product_id, label, price, purchase_cost, stock_qty, sku, image_url, sort_order, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,COALESCE($8,0),$9) RETURNING *`,
      [req.params.id, body.label, body.price, body.purchaseCost ?? null, body.stockQty,
       body.sku || null, body.imageUrl || null, body.sortOrder, req.actor.id]
    );
    if (body.imageUrl) {
      await client.query(`UPDATE products SET image_url = $2 WHERE id = $1 AND image_url IS NULL`, [req.params.id, body.imageUrl]);
    }
    if (body.stockQty > 0) {
      await client.query(
        `INSERT INTO stock_movements (product_id, variant_id, change_qty, reason, created_by)
         VALUES ($1,$2,$3,'رصيد افتتاحي — خيار جديد',$4)`,
        [req.params.id, rows[0].id, body.stockQty, req.actor.id]
      );
    }
    await writeAudit(client, {
      actorType: req.actor.type, actorId: req.actor.id, actorName: req.actor.name,
      action: "product_variant.created", entityType: "product_variant", entityId: rows[0].id,
      entityLabel: body.label, after: rows[0], ip: req.ip,
    });
    return rows[0];
  });

  res.status(201).json(variant);
}));

async function assertCanManageVariant(req, res, next) {
  const { rows } = await query(
    `SELECT v.*, p.supplier_id FROM product_variants v JOIN products p ON p.id = v.product_id WHERE v.id = $1`,
    [req.params.id]
  );
  if (!rows.length) throw new ApiError(404, "الخيار غير موجود");
  if (req.actor.type === "supplier") {
    if (rows[0].supplier_id !== req.actor.id) throw new ApiError(403, "لا يمكنك تعديل خيار لا يخصك");
    return next();
  }
  return requirePermission("catalog.manage")(req, res, next);
}

catalogRouter.patch("/product-variants/:id", asyncRoute(assertCanManageVariant), asyncRoute(async (req, res) => {
  const body = z.object({
    label: z.string().min(1).max(150).optional(),
    price: z.number().positive().optional(),
    purchaseCost: z.number().nonnegative().optional(),
    stockQty: z.number().nonnegative().optional(),
    sku: z.string().trim().max(100).optional(),
    imageUrl: z.string().url().optional(),
    isActive: z.boolean().optional(),
  }).parse(req.body);

  const updated = await withTransaction(async (client) => {
    const before = await client.query(`SELECT * FROM product_variants WHERE id = $1 FOR UPDATE`, [req.params.id]);
    if (!before.rows.length) throw new ApiError(404, "الخيار غير موجود");
    {
      const old = before.rows[0];
      const oldEff = old.is_active ? Number(old.stock_qty) : 0;
      const newActive = body.isActive ?? old.is_active;
      const newEff = newActive ? Number(body.stockQty ?? old.stock_qty) : 0;
      await takeFromPool(client, old.product_id, newEff - oldEff);
    }

    const { rows } = await client.query(
      `UPDATE product_variants SET
         label         = COALESCE($2, label),
         price         = COALESCE($3, price),
         purchase_cost = COALESCE($4, purchase_cost),
         stock_qty     = COALESCE($5, stock_qty),
         sku           = COALESCE($6, sku),
         image_url     = COALESCE($7, image_url),
         is_active     = COALESCE($8, is_active)
       WHERE id = $1 RETURNING *`,
      [req.params.id, body.label ?? null, body.price ?? null, body.purchaseCost ?? null,
       body.stockQty ?? null, body.sku ?? null, body.imageUrl ?? null, body.isActive ?? null]
    );
    if (body.imageUrl) {
      await client.query(`UPDATE products SET image_url = $2 WHERE id = $1 AND image_url IS NULL`, [rows[0].product_id, body.imageUrl]);
    }

    await writeAudit(client, {
      actorType: req.actor.type, actorId: req.actor.id, actorName: req.actor.name,
      action: "product_variant.updated", entityType: "product_variant", entityId: req.params.id,
      entityLabel: rows[0].label, before: before.rows[0], after: rows[0], ip: req.ip,
    });
    return rows[0];
  });

  res.json(updated);
}));

catalogRouter.delete("/product-variants/:id", asyncRoute(assertCanManageVariant), asyncRoute(async (req, res) => {
  const used = await query(`SELECT 1 FROM order_items WHERE variant_id = $1 LIMIT 1`, [req.params.id]);
  if (used.rows.length) {
    // ما نحذفش خيار له تاريخ طلبات فعلي — نوقّفه بس عشان الفواتير القديمة تفضل صحيحة
    await withTransaction(async (client) => {
      const { rows: [v] } = await client.query(`SELECT product_id, stock_qty, is_active FROM product_variants WHERE id = $1 FOR UPDATE`, [req.params.id]);
      if (v?.is_active) await takeFromPool(client, v.product_id, -Number(v.stock_qty));
      await client.query(`UPDATE product_variants SET is_active = FALSE WHERE id = $1`, [req.params.id]);
    });
    return res.json({ deactivated: true });
  }
  await withTransaction(async (client) => {
    const { rows: [v] } = await client.query(`SELECT product_id, stock_qty, is_active FROM product_variants WHERE id = $1 FOR UPDATE`, [req.params.id]);
    if (v) {
      if (v.is_active) await takeFromPool(client, v.product_id, -Number(v.stock_qty));
      await client.query(`DELETE FROM product_variants WHERE id = $1`, [req.params.id]);
    }
  });
  res.status(204).send();
}));

// موافقة الإدارة أو رفضها لصنف مضاف من مورد — قبل هذا القرار الصنف لا يظهر للعميل إطلاقًا
catalogRouter.patch("/products/:id/approval", requirePermission("catalog.approve_products"), asyncRoute(async (req, res) => {
  const body = z.object({
    status: z.enum(["approved", "rejected"]),
    note: z.string().trim().max(300).optional(),
  }).parse(req.body);

  const updated = await withTransaction(async (client) => {
    const existing = await client.query(`SELECT * FROM products WHERE id = $1 FOR UPDATE`, [req.params.id]);
    if (!existing.rows.length) throw new ApiError(404, "الصنف غير موجود");
    const before = existing.rows[0];

    const { rows } = await client.query(
      `UPDATE products SET approval_status = $2, approval_note = $3, approved_by = $4, approved_at = now()
       WHERE id = $1 RETURNING *`,
      [req.params.id, body.status, body.note || null, req.actor.id]
    );

    await writeAudit(client, {
      actorType: "employee", actorId: req.actor.id, actorName: req.actor.name,
      action: body.status === "approved" ? "product.approved" : "product.rejected",
      entityType: "product", entityId: req.params.id,
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

  // العمولة تُحسب على أساس صافي كل فاتورة (order_suppliers.subtotal × نسبتها الفعلية،
  // اللي ممكن تكون نسبة استثنائية لهذه الفاتورة بس، مش بالضرورة نسبة المورد الأساسية)
  const totals = await query(
    `SELECT COUNT(DISTINCT os.id)::INT AS orders_count,
            COALESCE(SUM(os.subtotal), 0) AS total_sales,
            COALESCE(SUM(os.subtotal * os.commission_rate / 100.0), 0) AS total_commission
       FROM order_suppliers os
       JOIN orders o ON o.id = os.order_id
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

  const totalSales = Number(totals.rows[0].total_sales);
  const totalCommission = Number(totals.rows[0].total_commission);

  res.json({
    ordersCount: totals.rows[0].orders_count,
    totalSales,
    totalCommission,
    netSales: totalSales - totalCommission,
    topProducts: topProducts.rows,
  });
}));

// تقرير المخزون (منفصل تمامًا عن تقارير الخزينة/المالية) — قيمة المخزون الحالية،
// الأصناف منخفضة/منعدمة الكمية، وتوزيعها حسب المورد. يستخدمه الأدمن فقط
catalogRouter.get("/inventory-report", requirePermission("reports.view"), asyncRoute(async (req, res) => {
  const { supplierId, sectionId } = req.query;

  const totals = await query(
    `SELECT COUNT(*)::INT AS products_count,
            COALESCE(SUM(eff), 0)::INT AS total_units,
            COALESCE(SUM(eff * base_price), 0) AS stock_value,
            COUNT(*) FILTER (WHERE eff = 0)::INT AS out_of_stock_count,
            COUNT(*) FILTER (WHERE eff > 0 AND eff < 10)::INT AS low_stock_count
       FROM (SELECT p.*, COALESCE((SELECT SUM(v.stock_qty) FROM product_variants v WHERE v.product_id = p.id AND v.is_active), p.stock_qty) AS eff FROM products p) p
      WHERE p.is_active
        AND ($1::UUID IS NULL OR p.supplier_id = $1)
        AND ($2::UUID IS NULL OR p.section_id  = $2)`,
    [supplierId || null, sectionId || null]
  );

  const bySupplier = await query(
    `SELECT s.id AS supplier_id, s.business_name AS supplier_name,
            COUNT(p.*)::INT AS products_count,
            COALESCE(SUM(COALESCE((SELECT SUM(v.stock_qty) FROM product_variants v WHERE v.product_id = p.id AND v.is_active), p.stock_qty)), 0)::INT AS total_units,
            COALESCE(SUM(COALESCE((SELECT SUM(v.stock_qty) FROM product_variants v WHERE v.product_id = p.id AND v.is_active), p.stock_qty) * p.base_price), 0) AS stock_value
       FROM products p
       JOIN suppliers s ON s.id = p.supplier_id
      WHERE p.is_active
        AND ($1::UUID IS NULL OR p.supplier_id = $1)
        AND ($2::UUID IS NULL OR p.section_id  = $2)
      GROUP BY s.id, s.business_name
      ORDER BY stock_value DESC`,
    [supplierId || null, sectionId || null]
  );

  const lowStockItems = await query(
    `SELECT p.id, p.name, p.unit, COALESCE((SELECT SUM(v.stock_qty) FROM product_variants v WHERE v.product_id = p.id AND v.is_active), p.stock_qty) AS stock_qty, p.supplier_sku,
            s.business_name AS supplier_name, sec.name AS section_name
       FROM products p
       JOIN suppliers s  ON s.id  = p.supplier_id
       JOIN sections sec ON sec.id = p.section_id
      WHERE p.is_active AND COALESCE((SELECT SUM(v.stock_qty) FROM product_variants v WHERE v.product_id = p.id AND v.is_active), p.stock_qty) < 10
        AND ($1::UUID IS NULL OR p.supplier_id = $1)
        AND ($2::UUID IS NULL OR p.section_id  = $2)
      ORDER BY 4 ASC
      LIMIT 100`,
    [supplierId || null, sectionId || null]
  );

  // أصناف راكدة: مافيهاش أي حركة مخزون (إضافة/خصم) آخر 30 يوم — تشمل مافيهاش
  // حركة أبدًا منذ إضافتها. تفيد لمعرفة الأصناف اللي ما تتحرّكش عشان مراجعتها
  const staleItems = await query(
    `SELECT p.id, p.name, p.unit, COALESCE((SELECT SUM(v.stock_qty) FROM product_variants v WHERE v.product_id = p.id AND v.is_active), p.stock_qty) AS stock_qty, p.supplier_sku,
            s.business_name AS supplier_name, sec.name AS section_name,
            lm.last_movement_at
       FROM products p
       JOIN suppliers s  ON s.id  = p.supplier_id
       JOIN sections sec ON sec.id = p.section_id
       LEFT JOIN (
         SELECT product_id, MAX(created_at) AS last_movement_at
           FROM stock_movements GROUP BY product_id
       ) lm ON lm.product_id = p.id
      WHERE p.is_active
        AND (lm.last_movement_at IS NULL OR lm.last_movement_at < now() - interval '30 days')
        AND ($1::UUID IS NULL OR p.supplier_id = $1)
        AND ($2::UUID IS NULL OR p.section_id  = $2)
      ORDER BY lm.last_movement_at ASC NULLS FIRST
      LIMIT 100`,
    [supplierId || null, sectionId || null]
  );

  // حركة المخزون اليومية آخر 30 يوم (إضافة مقابل خصم) — لمتابعة نشاط المخزون عبر الوقت
  const movementSeries = await query(
    `SELECT date_trunc('day', sm.created_at)::DATE AS day,
            COALESCE(SUM(change_qty) FILTER (WHERE change_qty > 0), 0) AS stock_in,
            COALESCE(SUM(-change_qty) FILTER (WHERE change_qty < 0), 0) AS stock_out
       FROM stock_movements sm
       JOIN products p ON p.id = sm.product_id
      WHERE sm.created_at >= now() - interval '30 days'
        AND ($1::UUID IS NULL OR p.supplier_id = $1)
        AND ($2::UUID IS NULL OR p.section_id  = $2)
      GROUP BY day ORDER BY day`,
    [supplierId || null, sectionId || null]
  );

  res.json({
    productsCount: totals.rows[0].products_count,
    totalUnits: totals.rows[0].total_units,
    stockValue: totals.rows[0].stock_value,
    outOfStockCount: totals.rows[0].out_of_stock_count,
    lowStockCount: totals.rows[0].low_stock_count,
    bySupplier: bySupplier.rows,
    lowStockItems: lowStockItems.rows,
    staleItems: staleItems.rows,
    movementSeries: movementSeries.rows,
  });
}));

// استيراد أصناف بالجملة — راجع الشرح أعلى الملف لآلية المطابقة عبر supplierSku
const importRowSchema = z.object({
  sectionId: z.string().uuid().optional(),
  name: z.string().min(2),
  unit: z.string().min(1),
  basePrice: z.number().positive(),
  stockQty: z.number().nonnegative().default(0),
  supplierSku: z.string().trim().max(100).min(1),
});

// تسجيل حركة مخزون (إضافة أو سحب) — كل عملية موثّقة بسبب وتاريخ، بدل تعديل الكمية مباشرة
// المورد يسجّل على أصنافه هو بس، والأدمن (بصلاحية catalog.manage) يقدر يسجّل على أي صنف
catalogRouter.post("/products/:id/stock-movements", asyncRoute(async (req, res, next) => {
  if (req.actor.type === "supplier") return next();
  return requirePermission("catalog.manage")(req, res, next);
}), asyncRoute(async (req, res) => {
  const body = z.object({
    changeQty: z.number().refine((n) => n !== 0, "القيمة لا يمكن أن تكون صفرًا"),
    reason: z.string().min(2),
  }).parse(req.body);

  const result = await withTransaction(async (client) => {
    const { rows: prodRows } = await client.query(
      `SELECT * FROM products WHERE id = $1 FOR UPDATE`, [req.params.id]
    );
    if (!prodRows.length) throw new ApiError(404, "الصنف غير موجود");
    const product = prodRows[0];
    if (req.actor.type === "supplier" && product.supplier_id !== req.actor.id) {
      throw new ApiError(403, "لا يمكنك تعديل صنف لا يخصك");
    }

    const newQty = Number(product.stock_qty) + body.changeQty;
    if (newQty < 0) throw new ApiError(400, "الكمية الناتجة أقل من صفر — تحقق من القيمة المدخلة");

    const { rows: [movement] } = await client.query(
      `INSERT INTO stock_movements (product_id, change_qty, reason, created_by)
       VALUES ($1,$2,$3,$4) RETURNING *`,
      [product.id, body.changeQty, body.reason, req.actor.id]
    );
    const { rows: [updated] } = await client.query(
      `UPDATE products SET stock_qty = $2 WHERE id = $1 RETURNING *`,
      [product.id, newQty]
    );

    if (req.actor.type === "employee") {
      await writeAudit(client, {
        actorType: "employee", actorId: req.actor.id, actorName: req.actor.name,
        action: body.changeQty > 0 ? "product.stock_added" : "product.stock_deducted",
        entityType: "product", entityId: product.id,
        entityLabel: product.name, after: { changeQty: body.changeQty, reason: body.reason }, ip: req.ip,
      });
    }

    if (Number(product.stock_qty) === 0 && newQty > 0) {
      await notifyFavoriteRestock(client, { productId: product.id, productName: product.name });
    }

    return { movement, product: updated };
  });

  res.status(201).json(result);
}));

// سجل الصنف الموحّد للإدارة: حركات المخزون + كل التعديلات (سعر/اسم/كمية/كود/قسم...) بقيمتها قبل وبعد واسم من عدّل
const HISTORY_FIELDS = {
  name: "الاسم", base_price: "السعر", price: "السعر", stock_qty: "الكمية", supplier_sku: "كود الصنف",
  sku: "كود الخيار", label: "اسم الخيار", section_id: "القسم", is_active: "الحالة", image_url: "الصورة",
  purchase_cost: "سعر التكلفة", unit: "وحدة البيع",
};
catalogRouter.get("/products/:id/history", requireAnyPermission("catalog.manage", "reports.view"), asyncRoute(async (req, res) => {
  const { rows: prod } = await query(`SELECT id, name FROM products WHERE id = $1`, [req.params.id]);
  if (!prod.length) throw new ApiError(404, "الصنف غير موجود");

  const { rows: moves } = await query(
    `SELECT sm.id, sm.change_qty, sm.reason, sm.created_at, v.label AS variant_label,
            COALESCE((SELECT name FROM employees WHERE id = sm.created_by),
                     (SELECT business_name FROM suppliers WHERE id = sm.created_by), '—') AS actor_name
       FROM stock_movements sm
       LEFT JOIN product_variants v ON v.id = sm.variant_id
      WHERE sm.product_id = $1`,
    [req.params.id]
  );

  const { rows: audits } = await query(
    `SELECT id, action, actor_name, before_data, after_data, entity_label, created_at
       FROM audit_log
      WHERE (entity_type = 'product' AND entity_id = $1
             AND action IN ('product.created','product.updated','product.deleted'))
         OR (entity_type = 'product_variant'
             AND (before_data->>'product_id' = $1::text OR after_data->>'product_id' = $1::text))`,
    [req.params.id]
  );

  const { rows: secs } = await query(`SELECT id, name FROM sections`);
  const secName = Object.fromEntries(secs.map((x) => [x.id, x.name]));
  const show = (field, v) => {
    if (v === null || v === undefined || v === "") return "—";
    if (field === "section_id") return secName[v] || v;
    if (field === "is_active") return v ? "مفعّل" : "موقوف";
    if (field === "image_url") return "صورة";
    return String(v);
  };

  const items = moves.map((m) => ({
    id: `m-${m.id}`, kind: "stock", at: m.created_at, actor_name: m.actor_name,
    title: "حركة مخزون", variant_label: m.variant_label, qty_change: Number(m.change_qty), reason: m.reason, changes: [],
  }));

  for (const a of audits) {
    const before = a.before_data || {};
    const after = a.after_data || {};
    const variantLabel = a.action.startsWith("product_variant") ? (after.label || before.label || a.entity_label) : null;
    if (a.action === "product.created") {
      items.push({ id: `a-${a.id}`, kind: "edit", at: a.created_at, actor_name: a.actor_name, title: "إضافة الصنف", changes: [] });
      continue;
    }
    if (a.action === "product.deleted") {
      items.push({ id: `a-${a.id}`, kind: "edit", at: a.created_at, actor_name: a.actor_name, title: "حذف الصنف", changes: [] });
      continue;
    }
    if (a.action === "product_variant.created") {
      items.push({ id: `a-${a.id}`, kind: "edit", at: a.created_at, actor_name: a.actor_name, title: "إضافة خيار", variant_label: variantLabel,
        changes: [{ label: "السعر", from: "—", to: show("price", after.price) }, { label: "الكمية", from: "—", to: show("stock_qty", after.stock_qty) }] });
      continue;
    }
    const changes = [];
    for (const field of Object.keys(HISTORY_FIELDS)) {
      if (!(field in before) && !(field in after)) continue;
      const b = before[field], c = after[field];
      if (String(b ?? "") === String(c ?? "")) continue;
      // رقم بنفس القيمة بصيغ مختلفة (600 مقابل 600.00) ما نعتبره تعديل
      if (b !== null && c !== null && !isNaN(Number(b)) && !isNaN(Number(c)) && Number(b) === Number(c)) continue;
      changes.push({ label: HISTORY_FIELDS[field], from: show(field, b), to: show(field, c) });
    }
    if (!changes.length) continue;
    items.push({
      id: `a-${a.id}`, kind: "edit", at: a.created_at, actor_name: a.actor_name,
      title: variantLabel ? "تعديل خيار" : "تعديل الصنف", variant_label: variantLabel, changes,
    });
  }

  items.sort((x, y) => new Date(y.at) - new Date(x.at));
  res.json({ product: prod[0], items });
}));

// سجل حركة المخزون الكامل لصنف واحد
catalogRouter.get("/products/:id/stock-movements", asyncRoute(async (req, res, next) => {
  if (req.actor.type === "supplier") return next();
  return requirePermission("reports.view")(req, res, next);
}), asyncRoute(async (req, res) => {
  const { rows: prodRows } = await query(`SELECT supplier_id FROM products WHERE id = $1`, [req.params.id]);
  if (!prodRows.length) throw new ApiError(404, "الصنف غير موجود");
  if (req.actor.type === "supplier" && prodRows[0].supplier_id !== req.actor.id) {
    throw new ApiError(403, "لا يمكنك الاطلاع على صنف لا يخصك");
  }

  const { rows } = await query(
    `SELECT sm.*, v.label AS variant_label FROM stock_movements sm
       LEFT JOIN product_variants v ON v.id = sm.variant_id
      WHERE sm.product_id = $1 ORDER BY sm.created_at DESC`,
    [req.params.id]
  );
  res.json(rows);
}));

// استيراد بالجملة يعتمد على "رقم الصنف عند المورد" كمفتاح مطابقة:
// - رقم موجود بالفعل عند هذا المورد → تُسجَّل حركة إضافة مخزون تلقائيًا (وليس صنف جديد)
// - رقم غير موجود → لا يُضاف تلقائيًا، بل يُعاد في needsConfirmation ليراجعه المورد
// استيراد بالجملة عبر إكسل — يُنشئ "فاتورة إضافة" واحدة تجمع كل الأصناف المحدّثة
// في هذا الاستيراد، تمامًا زي فاتورة الإضافة اليدوية. المورد يستورد لنفسه، والأدمن
// (بصلاحية catalog.manage) يقدر يستورد نيابة عن أي مورد بتحديد supplierId
catalogRouter.post("/products/import", asyncRoute(async (req, res, next) => {
  if (req.actor.type === "supplier") return next();
  return requirePermission("catalog.manage")(req, res, next);
}), asyncRoute(async (req, res) => {
  const { rows: inputRows, supplierId: bodySupplierId } = z.object({
    rows: z.array(importRowSchema).min(1).max(500),
    supplierId: z.string().uuid().optional(),
  }).parse(req.body);

  const supplierId = req.actor.type === "supplier" ? req.actor.id : bodySupplierId;
  if (!supplierId) throw new ApiError(400, "يجب تحديد المورد");

  const result = await withTransaction(async (client) => {
    const updated = [];
    const needsConfirmation = [];
    const skipped = [];
    let voucher = null;

    for (const row of inputRows) {
      if (!row.supplierSku) {
        skipped.push({ name: row.name, reason: "رقم الصنف عندك مطلوب في وضع الاستيراد" });
        continue;
      }

      // الكود قد يكون كود خيار (لون/مقاس) — نطابقه أولًا مع خيارات أصناف هذا المورد
      const { rows: vMatch } = await client.query(
        `SELECT v.*, p.name AS product_name FROM product_variants v
           JOIN products p ON p.id = v.product_id
          WHERE p.supplier_id = $1 AND v.sku = $2 AND v.is_active = true LIMIT 1`,
        [supplierId, row.supplierSku]
      );
      if (vMatch.length) {
        const variant = vMatch[0];
        // الإكسل يحدّد الكمية والسعر الجديدين (مو يضيف عليهم): الفرق = الكمية الجديدة − الحالية
        const delta = row.stockQty - Number(variant.stock_qty);
        if (delta !== 0) {
          let voucherId = null;
          if (delta > 0) {
            if (!voucher) {
              const number = await nextDocNumber(client, {
                table: "stock_vouchers", column: "voucher_number", prefix: "ADD", start: 1000,
              });
              const { rows: [v] } = await client.query(
                `INSERT INTO stock_vouchers
                   (voucher_number, voucher_type, supplier_id, reason, created_by, created_by_type, created_by_name)
                 VALUES ($1,'addition',$2,'استيراد إكسل',$3,$4,$5) RETURNING *`,
                [number, supplierId, req.actor.id, req.actor.type, req.actor.name]
              );
              voucher = v;
            }
            voucherId = voucher.id;
          }
          await client.query(
            `INSERT INTO stock_movements (product_id, variant_id, change_qty, reason, created_by, voucher_id)
             VALUES ($1,$2,$3,$4,$5,$6)`,
            [variant.product_id, variant.id, delta,
             delta > 0 ? "استيراد إكسل — زيادة كمية خيار" : "استيراد إكسل — تخفيض كمية خيار", req.actor.id, voucherId]
          );
        }
        const { rows: [savedV] } = await client.query(
          `UPDATE product_variants SET stock_qty = $2, price = CASE WHEN $3 > 0 THEN $3 ELSE price END
            WHERE id = $1 RETURNING *`,
          [variant.id, row.stockQty, row.basePrice]
        );
        if (Number(variant.stock_qty) !== Number(savedV.stock_qty) || Number(variant.price) !== Number(savedV.price)) {
          await writeAudit(client, {
            actorType: req.actor.type, actorId: req.actor.id, actorName: req.actor.name,
            action: "product_variant.updated", entityType: "product_variant", entityId: variant.id,
            entityLabel: `${variant.product_name} — ${variant.label}`, before: variant, after: savedV, ip: req.ip,
          });
        }
        updated.push({ ...savedV, name: `${variant.product_name} — ${variant.label}` });
        continue;
      }

      const { rows: existing } = await client.query(
        `SELECT * FROM products WHERE supplier_id = $1 AND supplier_sku = $2`,
        [supplierId, row.supplierSku]
      );

      if (existing.length) {
        const product = existing[0];
        // الإكسل يحدّد الكمية والسعر الجديدين (مو يضيف عليهم)
        const delta = row.stockQty - Number(product.stock_qty);
        const newQty = row.stockQty;
        if (delta !== 0) {
          let voucherId = null;
          if (delta > 0) {
            if (!voucher) {
              const number = await nextDocNumber(client, {
                table: "stock_vouchers", column: "voucher_number", prefix: "ADD", start: 1000,
              });
              const { rows: [v] } = await client.query(
                `INSERT INTO stock_vouchers
                   (voucher_number, voucher_type, supplier_id, reason, created_by, created_by_type, created_by_name)
                 VALUES ($1,'addition',$2,'استيراد إكسل',$3,$4,$5) RETURNING *`,
                [number, supplierId, req.actor.id, req.actor.type, req.actor.name]
              );
              voucher = v;
            }
            voucherId = voucher.id;
          }
          await client.query(
            `INSERT INTO stock_movements (product_id, change_qty, reason, created_by, voucher_id)
             VALUES ($1,$2,$3,$4,$5)`,
            [product.id, delta, delta > 0 ? "استيراد إكسل — زيادة كمية" : "استيراد إكسل — تخفيض كمية", req.actor.id, voucherId]
          );
        }
        const { rows: [saved] } = await client.query(
          `UPDATE products SET stock_qty = $2, base_price = $3 WHERE id = $1 RETURNING *`,
          [product.id, newQty, row.basePrice]
        );
        if (Number(product.stock_qty) !== Number(saved.stock_qty) || Number(product.base_price) !== Number(saved.base_price)) {
          await writeAudit(client, {
            actorType: req.actor.type, actorId: req.actor.id, actorName: req.actor.name,
            action: "product.updated", entityType: "product", entityId: product.id,
            entityLabel: product.name, before: product, after: saved, ip: req.ip,
          });
        }
        updated.push(saved);

        if (Number(product.stock_qty) === 0 && newQty > 0) {
          await notifyFavoriteRestock(client, { productId: product.id, productName: product.name });
        }

        continue;
      }

      if (!row.sectionId) {
        skipped.push({ name: row.name, reason: "القسم غير مطابق لأقسامك المعتمدة" });
        continue;
      }

      needsConfirmation.push(row);
    }

    if (updated.length) {
      await writeAudit(client, {
        actorType: req.actor.type, actorId: req.actor.id, actorName: req.actor.name,
        action: "products.import_stock_updated", entityType: "product", entityId: supplierId,
        entityLabel: `تحديث مخزون ${updated.length} صنف عبر إكسل`, after: { count: updated.length }, ip: req.ip,
      });
    }

    return { updated, needsConfirmation, skipped, voucher };
  });

  res.status(201).json({
    updatedCount: result.updated.length,
    needsConfirmationCount: result.needsConfirmation.length,
    skippedCount: result.skipped.length,
    updated: result.updated,
    needsConfirmation: result.needsConfirmation,
    skipped: result.skipped,
    voucher: result.voucher,
  });
}));

// تأكيد إضافة أصناف جديدة فعليًا (بعد ما راجعها المورد/الأدمن يدويًا من شاشة needsConfirmation)
// — تُنشئ فاتورة إضافة منفصلة خاصة بالأصناف الجديدة كليًا
catalogRouter.post("/products/import/confirm-new", asyncRoute(async (req, res, next) => {
  if (req.actor.type === "supplier") return next();
  return requirePermission("catalog.manage")(req, res, next);
}), asyncRoute(async (req, res) => {
  const { rows: inputRows, supplierId: bodySupplierId } = z.object({
    rows: z.array(importRowSchema.extend({ sectionId: z.string().uuid() })).min(1).max(500),
    supplierId: z.string().uuid().optional(),
  }).parse(req.body);

  const supplierId = req.actor.type === "supplier" ? req.actor.id : bodySupplierId;
  if (!supplierId) throw new ApiError(400, "يجب تحديد المورد");

  const result = await withTransaction(async (client) => {
    const number = await nextDocNumber(client, {
      table: "stock_vouchers", column: "voucher_number", prefix: "ADD", start: 1000,
    });
    const { rows: [voucher] } = await client.query(
      `INSERT INTO stock_vouchers
         (voucher_number, voucher_type, supplier_id, reason, created_by, created_by_type, created_by_name)
       VALUES ($1,'addition',$2,'استيراد إكسل — أصناف جديدة',$3,$4,$5) RETURNING *`,
      [number, supplierId, req.actor.id, req.actor.type, req.actor.name]
    );

    const created = [];
    for (const row of inputRows) {
      const { rows } = await client.query(
        `INSERT INTO products
           (section_id, supplier_id, name, unit, base_price, stock_qty, supplier_sku, approval_status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [row.sectionId, supplierId, row.name, row.unit, row.basePrice, row.stockQty, row.supplierSku,
         req.actor.type === "employee" ? "approved" : "pending"]
      );
      const product = rows[0];
      if (row.stockQty > 0) {
        await client.query(
          `INSERT INTO stock_movements (product_id, change_qty, reason, created_by, voucher_id)
           VALUES ($1,$2,'رصيد افتتاحي — صنف جديد',$3,$4)`,
          [product.id, row.stockQty, req.actor.id, voucher.id]
        );
      }
      created.push(product);
    }

    await writeAudit(client, {
      actorType: req.actor.type, actorId: req.actor.id, actorName: req.actor.name,
      action: "products.imported_new", entityType: "product", entityId: supplierId,
      entityLabel: `إضافة ${created.length} صنف جديد عبر إكسل`, after: { count: created.length }, ip: req.ip,
    });

    return { created, voucher };
  });

  res.status(201).json({ createdCount: result.created.length, created: result.created, voucher: result.voucher });
}));

// فاتورة إضافة/خصم مخزون يدوية — عدة أصناف مع بعض بفاتورة واحدة، بدل صنف بصنف.
// المورد ينشئها لنفسه، والأدمن (بصلاحية catalog.manage) ينشئها لأي مورد بتحديد supplierId
const voucherSchema = z.object({
  voucherType: z.enum(["addition", "discount"]),
  supplierId: z.string().uuid().optional(),
  reason: z.string().min(2),
  items: z.array(z.object({
    productId: z.string().uuid(),
    qty: z.number().positive(),
  })).min(1).max(200),
});

catalogRouter.post("/stock-vouchers", asyncRoute(async (req, res, next) => {
  if (req.actor.type === "supplier") return next();
  return requirePermission("catalog.manage")(req, res, next);
}), asyncRoute(async (req, res) => {
  const body = voucherSchema.parse(req.body);
  const supplierId = req.actor.type === "supplier" ? req.actor.id : body.supplierId;
  if (!supplierId) throw new ApiError(400, "يجب تحديد المورد");

  const result = await withTransaction(async (client) => {
    const number = await nextDocNumber(client, {
      table: "stock_vouchers", column: "voucher_number",
      prefix: body.voucherType === "addition" ? "ADD" : "DED", start: 1000,
    });

    const { rows: [voucher] } = await client.query(
      `INSERT INTO stock_vouchers
         (voucher_number, voucher_type, supplier_id, reason, created_by, created_by_type, created_by_name)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [number, body.voucherType, supplierId, body.reason, req.actor.id, req.actor.type, req.actor.name]
    );

    const lines = [];
    for (const item of body.items) {
      const { rows: prodRows } = await client.query(
        `SELECT * FROM products WHERE id = $1 FOR UPDATE`, [item.productId]
      );
      if (!prodRows.length) throw new ApiError(404, "أحد الأصناف غير موجود");
      const product = prodRows[0];
      if (product.supplier_id !== supplierId) {
        throw new ApiError(400, `الصنف "${product.name}" لا يخص هذا المورد`);
      }

      const changeQty = body.voucherType === "addition" ? item.qty : -item.qty;
      const newQty = Number(product.stock_qty) + changeQty;
      if (newQty < 0) throw new ApiError(400, `الكمية غير كافية للصنف: ${product.name}`);

      const { rows: [movement] } = await client.query(
        `INSERT INTO stock_movements (product_id, change_qty, reason, created_by, voucher_id)
         VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [product.id, changeQty, body.reason, req.actor.id, voucher.id]
      );
      await client.query(`UPDATE products SET stock_qty = $2 WHERE id = $1`, [product.id, newQty]);
      lines.push({ ...movement, product_name: product.name, unit: product.unit, supplier_sku: product.supplier_sku });

      if (Number(product.stock_qty) === 0 && newQty > 0) {
        await notifyFavoriteRestock(client, { productId: product.id, productName: product.name });
      }
    }

    await writeAudit(client, {
      actorType: req.actor.type, actorId: req.actor.id, actorName: req.actor.name,
      action: body.voucherType === "addition" ? "stock_voucher.addition_created" : "stock_voucher.discount_created",
      entityType: "stock_voucher", entityId: voucher.id, entityLabel: number,
      after: { itemsCount: lines.length }, ip: req.ip,
    });

    return { voucher, lines };
  });

  res.status(201).json(result);
}));

// قائمة فواتير المخزون (إضافة/خصم/استيراد إكسل — كلها في نفس القائمة)
catalogRouter.get("/stock-vouchers", asyncRoute(async (req, res) => {
  const { voucherType, supplierId } = req.query;
  const ownerFilter = req.actor.type === "supplier" ? req.actor.id : (supplierId || null);
  if (!["supplier", "employee"].includes(req.actor.type)) throw new ApiError(403, "غير مصرّح");

  if (req.actor.type === "employee") {
    await new Promise((resolve, reject) => {
      requirePermission("reports.view")(req, res, (err) => err ? reject(err) : resolve());
    });
  }

  const { rows } = await query(
    `SELECT sv.*, s.business_name AS supplier_name,
            (SELECT COUNT(*) FROM stock_movements sm WHERE sm.voucher_id = sv.id) AS items_count
       FROM stock_vouchers sv
       JOIN suppliers s ON s.id = sv.supplier_id
      WHERE ($1::UUID IS NULL OR sv.supplier_id = $1)
        AND ($2::TEXT IS NULL OR sv.voucher_type = $2)
      ORDER BY sv.created_at DESC
      LIMIT 200`,
    [ownerFilter, voucherType || null]
  );
  res.json(rows);
}));

// تفاصيل فاتورة مخزون واحدة، بكل أصنافها — تُستخدم لعرضها أو طباعتها PDF
catalogRouter.get("/stock-vouchers/:id", asyncRoute(async (req, res) => {
  const { rows: vRows } = await query(
    `SELECT sv.*, s.business_name AS supplier_name
       FROM stock_vouchers sv JOIN suppliers s ON s.id = sv.supplier_id
      WHERE sv.id = $1`,
    [req.params.id]
  );
  if (!vRows.length) throw new ApiError(404, "الفاتورة غير موجودة");
  const voucher = vRows[0];
  if (!["supplier", "employee"].includes(req.actor.type)) throw new ApiError(403, "غير مصرّح");
  if (req.actor.type === "supplier" && voucher.supplier_id !== req.actor.id) {
    throw new ApiError(403, "لا تملك صلاحية الاطلاع على هذه الفاتورة");
  }

  const { rows: lines } = await query(
    `SELECT sm.*, p.name AS product_name, p.unit, p.supplier_sku
       FROM stock_movements sm JOIN products p ON p.id = sm.product_id
      WHERE sm.voucher_id = $1
      ORDER BY sm.created_at`,
    [req.params.id]
  );
  res.json({ voucher, lines });
}));

// سجل حركة المخزون (إضافة/سحب) لكل أصناف مورد معين — لعرضها من لوحة الإدارة
catalogRouter.get("/stock-movements", requirePermission("reports.view"), asyncRoute(async (req, res) => {
  const { supplierId, search } = req.query;
  const { rows } = await query(
    `SELECT sm.*, p.name AS product_name, p.unit, p.supplier_sku, s.business_name AS supplier_name
       FROM stock_movements sm
       JOIN products p  ON p.id = sm.product_id
       JOIN suppliers s ON s.id = p.supplier_id
      WHERE ($1::UUID IS NULL OR p.supplier_id = $1)
        AND ($2::TEXT IS NULL OR p.name ILIKE '%'||$2||'%' OR sm.reason ILIKE '%'||$2||'%')
      ORDER BY sm.created_at DESC
      LIMIT 300`,
    [supplierId || null, search || null]
  );
  res.json(rows);
}));

catalogRouter.get("/products/:id/movement", requirePermission("reports.view"), asyncRoute(async (req, res) => {
  const info = await query(
    `SELECT p.id, p.name, p.unit, p.added_at, p.stock_qty, p.supplier_sku, s.business_name AS supplier_name,
            sec.name AS section_name, p.image_url, p.base_price, p.section_id, p.supplier_id, p.is_active
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
