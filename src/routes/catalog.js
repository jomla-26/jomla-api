import { Router } from "express";
import { z } from "zod";
import { query, withTransaction, writeAudit, resubmitForApproval } from "../lib/db.js";
import { ApiError, asyncRoute, nextDocNumber } from "../lib/helpers.js";
import { authenticate, requirePermission, requireAnyPermission, requireActorType, assertCustomerSection } from "../middleware/auth.js";
import { notifyFavoriteRestock, queueNotification } from "../lib/notify.js";

export const catalogRouter = Router();
catalogRouter.use(authenticate);

// رابط صورة مقبول: http/https فقط (يمنع javascript: و data: وغيرها)
const httpUrl = z.string().url().refine((u) => /^https?:\/\//i.test(u), "رابط غير صالح — يجب أن يبدأ بـ http أو https");

// هل الموظف الحالي يملك صلاحية معيّنة؟ (يُستخدم لإخفاء بيانات حساسة بدل رفض الطلب كله)
function hasPermission(req, code) {
  return new Promise((resolve) => {
    requirePermission(code)(req, null, (err) => resolve(!err));
  });
}

// ---------------------------------------------------------------- أكواد الأصناف (SKU)
// الكود فريد لكل مورد عبر الأصناف والأنواع معًا (بغض النظر عن حالة الأحرف).
// القفل الاستشاري يمنع سباق إنشاء كودين متطابقين في نفس اللحظة.
async function lockSupplierSkus(client, supplierId) {
  await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`sku:${supplierId}`]);
}

async function assertSkuFree(client, supplierId, sku, { excludeProductId = null, excludeVariantId = null } = {}) {
  const code = String(sku ?? "").trim();
  if (!code) return;
  const { rows } = await client.query(
    `SELECT 'product' AS kind, p.name AS product_name, NULL::TEXT AS label
       FROM products p
      WHERE p.supplier_id = $1 AND lower(p.supplier_sku) = lower($2)
        AND ($3::UUID IS NULL OR p.id <> $3)
     UNION ALL
     SELECT 'variant', p.name, v.label
       FROM product_variants v JOIN products p ON p.id = v.product_id
      WHERE p.supplier_id = $1 AND lower(v.sku) = lower($2)
        AND ($4::UUID IS NULL OR v.id <> $4)
     LIMIT 1`,
    [supplierId, code, excludeProductId, excludeVariantId]
  );
  if (!rows.length) return;
  const r = rows[0];
  throw new ApiError(409, r.kind === "product"
    ? `الكود "${code}" مستخدم بالفعل للصنف "${r.product_name}" — اختر كودًا مختلفًا`
    : `الكود "${code}" مستخدم بالفعل للنوع "${r.label}" في الصنف "${r.product_name}" — اختر كودًا مختلفًا`);
}

// القسم لازم يكون من أقسام المورد المفعّلة (القسم الفرعي يُفحص عبر قسمه الرئيسي)
async function assertSupplierSection(client, supplierId, sectionId) {
  const { rows } = await client.query(
    `SELECT 1 FROM sections s
       JOIN supplier_sections ss ON ss.section_id = COALESCE(s.parent_id, s.id)
      WHERE s.id = $2 AND s.is_active AND ss.supplier_id = $1 AND ss.enabled`,
    [supplierId, sectionId]
  );
  if (!rows.length) throw new ApiError(403, "هذا القسم غير مفعّل لهذا المورد");
}

// resubmitForApproval (lib/db.js): تعديل المورد للاسم/الصورة/اسم النوع (أو إضافة نوع) يُرجع الصنف للموافقة
// ويكتب صف تدقيق بالانتقال. تعديل السعر (صنف/نوع/إكسل) لا يُرجعه للموافقة (يبقى معتمدًا وظاهرًا) لكنه يُسجَّل في التدقيق وسجل الصنف؛ والكمية لا تؤثر.

// يحرّك كمية نوع واحد (الصف لازم يكون مقفولًا FOR UPDATE من المستدعي) — حركة مخزون مسجّلة بسبب،
// ولا تلمس products.stock_qty إطلاقًا (مخزون الأصناف ذات الأنواع = مجموع كميات الأنواع فقط)
async function moveVariantStock(client, actor, lockedVariant, delta, reason, voucherId = null) {
  if (!delta) return lockedVariant;
  const newQty = Number(lockedVariant.stock_qty) + delta;
  if (newQty < 0) throw new ApiError(400, `الكمية الناتجة أقل من صفر للنوع "${lockedVariant.label}" — تحقق من القيمة المدخلة`);
  await client.query(
    `INSERT INTO stock_movements (product_id, variant_id, change_qty, reason, created_by, voucher_id)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [lockedVariant.product_id, lockedVariant.id, delta, reason, actor.id, voucherId]
  );
  const { rows } = await client.query(
    `UPDATE product_variants SET stock_qty = $2 WHERE id = $1 RETURNING *`, [lockedVariant.id, newQty]
  );
  return rows[0];
}

const HAS_VARIANTS_MSG = "هذا الصنف له أنواع — عدّل كمية كل نوع من شاشة الأنواع (أو اختر النوع في الفاتورة)";
async function productHasVariants(client, productId) {
  const { rows } = await client.query(`SELECT 1 FROM product_variants WHERE product_id = $1 LIMIT 1`, [productId]);
  return rows.length > 0;
}

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
        WHERE ss.supplier_id = $1 AND ss.enabled AND s.is_active AND s.parent_id IS NULL
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
    imageUrl: httpUrl.optional().or(z.literal("").transform(() => undefined)),
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
    imageUrl: httpUrl.optional(),
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

    // السعر يُحسب بنفس منطق resolvePrice (كمية 1) لكن باستعلام واحد بدل استعلام لكل صنف:
    // أولوية لقاعدة العميل نفسه ثم الأعلى حدًّا أدنى للكمية، وإلا السعر الأساسي
    const { rows } = await query(
      `SELECT p.id, p.name, p.unit, p.image_url,
              CASE WHEN pv.variants IS NOT NULL THEN NULL
                   ELSE COALESCE(pr.price, p.base_price) END AS price,
              p.stock_qty,
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
         LEFT JOIN LATERAL (
               SELECT r.price
                 FROM product_price_rules r
                WHERE r.product_id = p.id
                  AND r.is_active
                  AND (r.customer_id = $4 OR r.customer_id IS NULL)
                  AND r.min_qty <= 1
                  AND (r.valid_from IS NULL OR r.valid_from <= CURRENT_DATE)
                  AND (r.valid_to   IS NULL OR r.valid_to   >= CURRENT_DATE)
                ORDER BY (r.customer_id IS NOT NULL) DESC, r.min_qty DESC
                LIMIT 1
             ) pr ON true
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
      [sectionId, supplierId || null, search || null, req.actor.id]
    );
    return res.json(rows);
  }

  if (!["supplier", "employee"].includes(req.actor.type)) throw new ApiError(403, "غير مصرّح");

  // ترقيم اختياري: الافتراضي مرتفع (1000) عشان التطبيقات الحالية اللي تتوقع القائمة كاملة تشتغل كما هي
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 1000, 1), 5000);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

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
      ORDER BY p.name, p.id
      LIMIT $5 OFFSET $6`,
    [ownerFilter, sectionId || null, search || null, approvalStatus || null, limit, offset]
  );

  // سعر التكلفة للموظف يظهر فقط لمن عنده صلاحية pricing.cost (المورد يشوف تكلفة أصنافه هو)
  if (req.actor.type === "employee" && !(await hasPermission(req, "pricing.cost"))) {
    for (const r of rows) delete r.purchase_cost;
  }
  res.json(rows);
}));

const productSchema = z.object({
  sectionId: z.string().uuid(),
  name: z.string().trim().min(2),
  unit: z.string().trim().min(1),
  basePrice: z.number().positive().optional(),
  purchaseCost: z.number().nonnegative().optional(),
  stockQty: z.number().nonnegative().default(0),
  imageUrl: httpUrl.optional(),
  supplierSku: z.string().trim().max(100).optional(),
  // أنواع (ألوان/مقاسات) تُضاف مع الصنف مباشرة في نفس الطلب
  variants: z.array(z.object({
    label: z.string().trim().min(1).max(150),
    price: z.number().positive(),
    purchaseCost: z.number().nonnegative().optional(),
    stockQty: z.number().nonnegative().default(0),
    sku: z.string().trim().max(100).optional(),
    imageUrl: httpUrl.optional(),
  })).max(60).optional(),
});

catalogRouter.post("/products", asyncRoute(async (req, res, next) => {
  if (req.actor.type === "supplier") return next();
  return requirePermission("catalog.manage")(req, res, next);
}), asyncRoute(async (req, res) => {
  const body = productSchema.parse(req.body);
  const variantsIn = body.variants ?? [];
  if (!variantsIn.length && !body.basePrice) throw new ApiError(400, "السعر مطلوب");
  if (!variantsIn.length && !String(body.supplierSku || "").trim()) throw new ApiError(400, "رقم الصنف عند المورد إجباري");
  if (variantsIn.some((v) => !String(v.sku || "").trim())) throw new ApiError(400, "كود النوع إجباري لكل نوع");
  if (new Set(variantsIn.map((v) => v.label.toLowerCase())).size !== variantsIn.length) {
    throw new ApiError(400, "في نوعين بنفس الاسم — غيّر أحدهما");
  }
  // كل الأكواد (كود الصنف + أكواد الأنواع) لازم تكون مختلفة عن بعضها داخل نفس الطلب
  const codesInRequest = [...(variantsIn.length ? [] : [body.supplierSku]), ...variantsIn.map((v) => v.sku)]
    .map((c) => String(c).trim().toLowerCase());
  if (new Set(codesInRequest).size !== codesInRequest.length) {
    throw new ApiError(400, "في كودين متطابقين داخل نفس الصنف — كل صنف/نوع له كود مختلف");
  }
  // صنف بأنواع: سعر الصنف الأساسي = أقل سعر نوع، ومخزون الصنف نفسه = 0 (الكمية الحقيقية على الأنواع فقط)
  const basePrice = variantsIn.length ? Math.min(...variantsIn.map((v) => v.price)) : body.basePrice;
  const stockQty = variantsIn.length ? 0 : body.stockQty;
  const supplierId = req.actor.type === "supplier"
    ? req.actor.id
    : z.string().uuid().parse(req.body.supplierId);

  // أصناف الموظف/الإدارة تُعتمد تلقائيًا؛ أصناف المورد الجديدة تُنتظر موافقة الإدارة قبل ما تظهر للعميل
  const approvalStatus = req.actor.type === "employee" ? "approved" : "pending";

  const product = await withTransaction(async (client) => {
    await assertSupplierSection(client, supplierId, body.sectionId);
    await lockSupplierSkus(client, supplierId);
    for (const code of codesInRequest) await assertSkuFree(client, supplierId, code);

    const { rows } = await client.query(
      `INSERT INTO products
         (section_id, supplier_id, name, unit, base_price, purchase_cost, stock_qty, image_url, supplier_sku, added_by, approval_status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [body.sectionId, supplierId, body.name, body.unit, basePrice,
       body.purchaseCost ?? null, stockQty, body.imageUrl ?? variantsIn.find((v) => v.imageUrl)?.imageUrl ?? null,
       variantsIn.length ? null : (body.supplierSku || null),
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
           (product_id, supplier_id, label, price, purchase_cost, stock_qty, sku, image_url, sort_order, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [rows[0].id, supplierId, v.label, v.price, v.purchaseCost ?? null, v.stockQty, v.sku || null, v.imageUrl || null, i, req.actor.id]
      );
      if (v.stockQty > 0) {
        await client.query(
          `INSERT INTO stock_movements (product_id, variant_id, change_qty, reason, created_by)
           VALUES ($1,$2,$3,'رصيد افتتاحي — نوع جديد',$4)`,
          [rows[0].id, vr[0].id, v.stockQty, req.actor.id]
        );
      }
      await writeAudit(client, {
        actorType: req.actor.type, actorId: req.actor.id, actorName: req.actor.name,
        action: "product_variant.created", entityType: "product_variant", entityId: vr[0].id,
        entityLabel: v.label, after: vr[0], ip: req.ip,
      });
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
    name: z.string().trim().min(2).optional(),
    sectionId: z.string().uuid().optional(),
    basePrice: z.number().positive().optional(),
    purchaseCost: z.number().nonnegative().optional(),
    isActive: z.boolean().optional(),
    supplierSku: z.string().trim().max(100).optional(),
    imageUrl: httpUrl.optional(),
  }).parse(req.body);

  // رقم الصنف إجباري — يمنع مسحه بإرسال نص فارغ
  if (body.supplierSku !== undefined && !body.supplierSku) {
    throw new ApiError(400, "رقم الصنف عند المورد إجباري ولا يمكن تركه فارغًا");
  }

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

    if (body.supplierSku !== undefined && body.supplierSku.toLowerCase() !== String(before.supplier_sku || "").toLowerCase()) {
      await lockSupplierSkus(client, before.supplier_id);
      await assertSkuFree(client, before.supplier_id, body.supplierSku, { excludeProductId: before.id });
    }

    // المورد: تعديل الاسم/الصورة يرجّع الصنف المعتمد للمراجعة (السعر لا — يبقى معتمدًا، ويُدقَّق فقط)؛ والمرفوض يُعاد إرساله بعد تعديله
    let resubmit = false;
    if (req.actor.type === "supplier" && ["approved", "rejected"].includes(before.approval_status)) {
      const nameChanged = body.name !== undefined && body.name !== before.name;
      const priceChanged = body.basePrice !== undefined && Number(body.basePrice) !== Number(before.base_price);
      const imageChanged = body.imageUrl !== undefined && body.imageUrl !== before.image_url;
      const skuChanged = body.supplierSku !== undefined && body.supplierSku !== before.supplier_sku;
      resubmit = nameChanged || imageChanged || (before.approval_status === "rejected" && (priceChanged || skuChanged));
    }

    const { rows } = await client.query(
      `UPDATE products SET
         name          = COALESCE($2, name),
         section_id    = COALESCE($3, section_id),
         base_price    = COALESCE($4, base_price),
         purchase_cost = COALESCE($5, purchase_cost),
         is_active     = COALESCE($6, is_active),
         supplier_sku  = COALESCE($7, supplier_sku),
         image_url     = COALESCE($8, image_url),
         approval_status = CASE WHEN $9::BOOLEAN THEN 'pending' ELSE approval_status END,
         approval_note   = CASE WHEN $9::BOOLEAN THEN NULL ELSE approval_note END,
         approved_by     = CASE WHEN $9::BOOLEAN THEN NULL ELSE approved_by END,
         approved_at     = CASE WHEN $9::BOOLEAN THEN NULL ELSE approved_at END
       WHERE id = $1 RETURNING *`,
      [req.params.id, body.name ?? null, body.sectionId ?? null, body.basePrice ?? null, body.purchaseCost ?? null,
       body.isActive ?? null, body.supplierSku ?? null, body.imageUrl ?? null, resubmit]
    );

    if (body.basePrice && Number(body.basePrice) !== Number(before.base_price)) {
      await client.query(
        `INSERT INTO price_history (product_id, old_price, new_price, changed_by, changed_by_name)
         VALUES ($1,$2,$3,$4,$5)`,
        [req.params.id, before.base_price, body.basePrice, req.actor.id, req.actor.name]
      );
    }

    await writeAudit(client, {
      actorType: req.actor.type, actorId: req.actor.id, actorName: req.actor.name,
      action: resubmit ? "product.updated_resubmitted" : "product.updated",
      entityType: "product", entityId: req.params.id,
      entityLabel: before.name, before, after: rows[0], ip: req.ip,
    });
    return rows[0];
  });

  res.json(updated);
}));

// حذف صنف نهائيًا — لو له تاريخ طلبات فعلي نوقفه بس (زي الأنواع بالضبط) عشان
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
    await withTransaction(async (client) => {
      const { rows: [before] } = await client.query(`SELECT * FROM products WHERE id = $1 FOR UPDATE`, [req.params.id]);
      if (!before) return;
      const { rows: [after] } = await client.query(`UPDATE products SET is_active = FALSE WHERE id = $1 RETURNING *`, [req.params.id]);
      await writeAudit(client, {
        actorType: req.actor.type, actorId: req.actor.id, actorName: req.actor.name,
        action: "product.updated", entityType: "product", entityId: before.id,
        entityLabel: before.name, before, after, ip: req.ip,
      });
    });
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

/* --------------------- أنواع الصنف (ألوان/مقاسات/عبوات) ---------------------
   كل نوع له سعره وكمية مخزونه المستقلين تمامًا عن الصنف الأساسي وعن بقية الأنواع.
   مخزون الصنف ذي الأنواع = مجموع كميات أنواعه الفعّالة، وأي تغيير في كمية نوع
   يمر بحركة مخزون مسجّلة (سبب + من عدّل) ولا يلمس products.stock_qty أبدًا. */

catalogRouter.get("/products/:id/variants", asyncRoute(async (req, res) => {
  const { rows: prod } = await query(
    `SELECT p.supplier_id, p.section_id, p.is_active, p.approval_status, s.status AS supplier_status
       FROM products p JOIN suppliers s ON s.id = p.supplier_id WHERE p.id = $1`,
    [req.params.id]
  );
  if (!prod.length) throw new ApiError(404, "الصنف غير موجود");

  if (req.actor.type === "customer") {
    // العميل: أنواع فعّالة فقط، لصنف معتمد ظاهر في قسم مفعّل له، وبأعمدة صريحة (بدون تكلفة)
    const p = prod[0];
    if (!p.is_active || p.approval_status !== "approved" || p.supplier_status !== "approved") {
      throw new ApiError(404, "الصنف غير موجود");
    }
    await assertCustomerSection(req.actor.id, p.section_id);
    const { rows } = await query(
      `SELECT id, product_id, label, price, stock_qty, sku, image_url, sort_order
         FROM product_variants
        WHERE product_id = $1 AND is_active
        ORDER BY sort_order, created_at`,
      [req.params.id]
    );
    return res.json(rows);
  }

  if (req.actor.type === "supplier") {
    if (prod[0].supplier_id !== req.actor.id) throw new ApiError(403, "لا يمكنك الاطلاع على أنواع صنف لا يخصك");
  } else if (req.actor.type !== "employee") {
    throw new ApiError(403, "غير مصرّح");
  }

  const { rows } = await query(
    `SELECT * FROM product_variants WHERE product_id = $1 ORDER BY sort_order, created_at`,
    [req.params.id]
  );
  if (req.actor.type === "employee" && !(await hasPermission(req, "pricing.cost"))) {
    for (const r of rows) delete r.purchase_cost;
  }
  res.json(rows);
}));

const variantSchema = z.object({
  label: z.string().trim().min(1).max(150),
  price: z.number().positive(),
  purchaseCost: z.number().nonnegative().optional(),
  stockQty: z.number().nonnegative().default(0),
  sku: z.string().trim().max(100).optional(),
  imageUrl: httpUrl.optional(),
  sortOrder: z.number().int().optional(),
});

async function assertCanManageProduct(req, res, next) {
  const { rows } = await query(`SELECT supplier_id FROM products WHERE id = $1`, [req.params.id]);
  if (!rows.length) throw new ApiError(404, "الصنف غير موجود");
  if (req.actor.type === "supplier") {
    if (rows[0].supplier_id !== req.actor.id) throw new ApiError(403, "لا يمكنك تعديل صنف لا يخصك");
    return next();
  }
  return requirePermission("catalog.manage")(req, res, next);
}

async function assertLabelFree(client, productId, label, excludeVariantId = null) {
  const { rows } = await client.query(
    `SELECT 1 FROM product_variants
      WHERE product_id = $1 AND lower(btrim(label)) = lower(btrim($2))
        AND ($3::UUID IS NULL OR id <> $3) LIMIT 1`,
    [productId, label, excludeVariantId]
  );
  if (rows.length) throw new ApiError(409, "في نوع بنفس الاسم لهذا الصنف — غيّر الاسم");
}

catalogRouter.post("/products/:id/variants", asyncRoute(assertCanManageProduct), asyncRoute(async (req, res) => {
  const body = variantSchema.parse(req.body);
  if (!String(body.sku || "").trim()) throw new ApiError(400, "كود النوع إجباري");

  const variant = await withTransaction(async (client) => {
    const { rows: [prod] } = await client.query(`SELECT * FROM products WHERE id = $1 FOR UPDATE`, [req.params.id]);
    if (!prod) throw new ApiError(404, "الصنف غير موجود");

    await lockSupplierSkus(client, prod.supplier_id);
    await assertSkuFree(client, prod.supplier_id, body.sku);
    await assertLabelFree(client, prod.id, body.label);

    // الكمية الافتتاحية تدخل مباشرة على النوع بحركة "رصيد افتتاحي" — بدون أي خصم من رصيد الصنف
    const { rows } = await client.query(
      `INSERT INTO product_variants
         (product_id, supplier_id, label, price, purchase_cost, stock_qty, sku, image_url, sort_order, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,COALESCE($9,0),$10) RETURNING *`,
      [prod.id, prod.supplier_id, body.label, body.price, body.purchaseCost ?? null, body.stockQty,
       body.sku, body.imageUrl || null, body.sortOrder, req.actor.id]
    );
    if (body.imageUrl) {
      await client.query(`UPDATE products SET image_url = $2 WHERE id = $1 AND image_url IS NULL`, [prod.id, body.imageUrl]);
    }
    if (body.stockQty > 0) {
      await client.query(
        `INSERT INTO stock_movements (product_id, variant_id, change_qty, reason, created_by)
         VALUES ($1,$2,$3,'رصيد افتتاحي — نوع جديد',$4)`,
        [prod.id, rows[0].id, body.stockQty, req.actor.id]
      );
    }
    // نوع جديد يراه العميل — لو من مورد يرجع الصنف للمراجعة
    await writeAudit(client, {
      actorType: req.actor.type, actorId: req.actor.id, actorName: req.actor.name,
      action: "product_variant.created", entityType: "product_variant", entityId: rows[0].id,
      entityLabel: body.label, after: rows[0], ip: req.ip,
    });
    if (req.actor.type === "supplier") {
      await resubmitForApproval(client, prod.id, { actor: req.actor, ip: req.ip, reason: `إضافة نوع جديد «${body.label}»` });
    }
    return rows[0];
  });

  res.status(201).json(variant);
}));

async function assertCanManageVariant(req, res, next) {
  const { rows } = await query(
    `SELECT v.id, p.supplier_id FROM product_variants v JOIN products p ON p.id = v.product_id WHERE v.id = $1`,
    [req.params.id]
  );
  if (!rows.length) throw new ApiError(404, "النوع غير موجود");
  if (req.actor.type === "supplier") {
    if (rows[0].supplier_id !== req.actor.id) throw new ApiError(403, "لا يمكنك تعديل نوع لا يخصك");
    return next();
  }
  return requirePermission("catalog.manage")(req, res, next);
}

catalogRouter.patch("/product-variants/:id", asyncRoute(assertCanManageVariant), asyncRoute(async (req, res) => {
  const body = z.object({
    label: z.string().trim().min(1).max(150).optional(),
    price: z.number().positive().optional(),
    purchaseCost: z.number().nonnegative().optional(),
    stockQty: z.number().nonnegative().optional(),
    sku: z.string().trim().max(100).optional(),
    imageUrl: httpUrl.optional(),
    isActive: z.boolean().optional(),
    reason: z.string().trim().min(2).max(200).optional(),
  }).parse(req.body);

  if (body.sku !== undefined && !body.sku) throw new ApiError(400, "كود النوع إجباري ولا يمكن تركه فارغًا");

  const updated = await withTransaction(async (client) => {
    const before = await client.query(`SELECT * FROM product_variants WHERE id = $1 FOR UPDATE`, [req.params.id]);
    if (!before.rows.length) throw new ApiError(404, "النوع غير موجود");
    const old = before.rows[0];
    const { rows: [prod] } = await client.query(`SELECT supplier_id FROM products WHERE id = $1`, [old.product_id]);

    if (body.sku !== undefined && body.sku.toLowerCase() !== String(old.sku || "").toLowerCase()) {
      await lockSupplierSkus(client, prod.supplier_id);
      await assertSkuFree(client, prod.supplier_id, body.sku, { excludeVariantId: old.id });
    }
    if (body.label !== undefined && body.label.toLowerCase() !== old.label.toLowerCase()) {
      await assertLabelFree(client, old.product_id, body.label, old.id);
    }

    // بيانات النوع (بدون الكمية): الكمية لها مسار مسجّل منفصل بالأسفل
    const { rows: [meta] } = await client.query(
      `UPDATE product_variants SET
         label         = COALESCE($2, label),
         price         = COALESCE($3, price),
         purchase_cost = COALESCE($4, purchase_cost),
         sku           = COALESCE($5, sku),
         image_url     = COALESCE($6, image_url),
         is_active     = COALESCE($7, is_active)
       WHERE id = $1 RETURNING *`,
      [req.params.id, body.label ?? null, body.price ?? null, body.purchaseCost ?? null,
       body.sku ?? null, body.imageUrl ?? null, body.isActive ?? null]
    );

    // تغيير الكمية = حركة مخزون بفرق الكمية (محسوب من القيمة المقفولة) + سبب، بدون لمس رصيد الصنف
    let saved = meta;
    if (body.stockQty !== undefined) {
      const delta = Number(body.stockQty) - Number(old.stock_qty);
      saved = await moveVariantStock(client, req.actor, meta, delta,
        body.reason || (delta > 0 ? "تعديل كمية نوع — زيادة" : "تعديل كمية نوع — تخفيض"));
    }

    if (body.imageUrl) {
      await client.query(`UPDATE products SET image_url = $2 WHERE id = $1 AND image_url IS NULL`, [saved.product_id, body.imageUrl]);
    }

    // المورد: تعديل اسم/صورة نوع يرجّع الصنف للمراجعة، أما السعر والكمية فلا (السعر يُدقَّق فقط)
    if (req.actor.type === "supplier") {
      const labelChanged = body.label !== undefined && body.label !== old.label;
      const imageChanged = body.imageUrl !== undefined && body.imageUrl !== old.image_url;
      if (labelChanged || imageChanged) {
        const what = [labelChanged && "اسم", imageChanged && "صورة"].filter(Boolean).join("/");
        await resubmitForApproval(client, saved.product_id, { actor: req.actor, ip: req.ip, reason: `تعديل ${what} النوع «${old.label}»` });
      }
    }

    if (Number(old.stock_qty) === 0 && Number(saved.stock_qty) > 0) {
      const { rows: [p] } = await client.query(`SELECT name FROM products WHERE id = $1`, [saved.product_id]);
      await notifyFavoriteRestock(client, { productId: saved.product_id, productName: p?.name || saved.label });
    }

    await writeAudit(client, {
      actorType: req.actor.type, actorId: req.actor.id, actorName: req.actor.name,
      action: "product_variant.updated", entityType: "product_variant", entityId: req.params.id,
      entityLabel: saved.label, before: old, after: saved, ip: req.ip,
    });
    return saved;
  });

  res.json(updated);
}));

// تعديل كمية نوع بحركة مسجّلة (زيادة أو خصم + السبب) — الكمية ما تتغيّر مباشرة، عشان يبقى السجل واضح: كم كان، كم صار، ومن عدّل
catalogRouter.post("/product-variants/:id/adjust-stock", asyncRoute(assertCanManageVariant), asyncRoute(async (req, res) => {
  const body = z.object({
    changeQty: z.number().refine((n) => n !== 0, "الكمية لا يمكن أن تكون صفرًا"),
    reason: z.string().trim().min(2),
  }).parse(req.body);

  const updated = await withTransaction(async (client) => {
    const { rows: before } = await client.query(`SELECT * FROM product_variants WHERE id = $1 FOR UPDATE`, [req.params.id]);
    if (!before.length) throw new ApiError(404, "النوع غير موجود");
    const old = before[0];

    const saved = await moveVariantStock(client, req.actor, old, body.changeQty, body.reason);
    await writeAudit(client, {
      actorType: req.actor.type, actorId: req.actor.id, actorName: req.actor.name,
      action: "product_variant.updated", entityType: "product_variant", entityId: old.id,
      entityLabel: old.label, before: old, after: saved, ip: req.ip,
    });
    if (Number(old.stock_qty) === 0 && Number(saved.stock_qty) > 0) {
      const { rows: [p] } = await client.query(`SELECT name FROM products WHERE id = $1`, [old.product_id]);
      await notifyFavoriteRestock(client, { productId: old.product_id, productName: p?.name || old.label });
    }
    return saved;
  });
  res.json(updated);
}));

catalogRouter.delete("/product-variants/:id", asyncRoute(assertCanManageVariant), asyncRoute(async (req, res) => {
  const used = await query(`SELECT 1 FROM order_items WHERE variant_id = $1 LIMIT 1`, [req.params.id]);
  if (used.rows.length) {
    // ما نحذفش نوع له تاريخ طلبات فعلي — نوقّفه بس عشان الفواتير القديمة تفضل صحيحة
    await withTransaction(async (client) => {
      const { rows: [v] } = await client.query(`SELECT * FROM product_variants WHERE id = $1 FOR UPDATE`, [req.params.id]);
      if (!v) return;
      await client.query(`UPDATE product_variants SET is_active = FALSE WHERE id = $1`, [req.params.id]);
      await writeAudit(client, {
        actorType: req.actor.type, actorId: req.actor.id, actorName: req.actor.name,
        action: "product_variant.updated", entityType: "product_variant", entityId: v.id,
        entityLabel: v.label, before: v, after: { ...v, is_active: false }, ip: req.ip,
      });
    });
    return res.json({ deactivated: true });
  }
  await withTransaction(async (client) => {
    const { rows: [v] } = await client.query(`SELECT * FROM product_variants WHERE id = $1 FOR UPDATE`, [req.params.id]);
    if (v) {
      await client.query(`DELETE FROM product_variants WHERE id = $1`, [req.params.id]);
      await writeAudit(client, {
        actorType: req.actor.type, actorId: req.actor.id, actorName: req.actor.name,
        action: "product_variant.deleted", entityType: "product_variant", entityId: v.id,
        entityLabel: v.label, before: v, ip: req.ip,
      });
    }
  });
  res.status(204).send();
}));

// موافقة الإدارة أو رفضها لصنف مضاف من مورد — قبل هذا القرار الصنف لا يظهر للعميل إطلاقًا.
// القرار يُتّخذ فقط على صنف بانتظار الموافقة (pending)، ويصل المورد إشعار بالنتيجة
catalogRouter.patch("/products/:id/approval", requirePermission("catalog.approve_products"), asyncRoute(async (req, res) => {
  const body = z.object({
    status: z.enum(["approved", "rejected"]),
    note: z.string().trim().max(300).optional(),
  }).parse(req.body);

  const updated = await withTransaction(async (client) => {
    const existing = await client.query(`SELECT * FROM products WHERE id = $1 FOR UPDATE`, [req.params.id]);
    if (!existing.rows.length) throw new ApiError(404, "الصنف غير موجود");
    const before = existing.rows[0];
    if (before.approval_status !== "pending") {
      throw new ApiError(409, before.approval_status === "approved"
        ? "هذا الصنف معتمد بالفعل"
        : "هذا الصنف مرفوض — ينتظر تعديل المورد وإعادة الإرسال قبل أي قرار جديد");
    }

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

    await queueNotification(client, {
      templateCode: body.status === "approved" ? "product.approved" : "product.rejected",
      recipientType: "supplier", recipientId: before.supplier_id,
      vars: { product_name: before.name, note: body.note ? ` — السبب: ${body.note}` : "" },
    });
    return rows[0];
  });

  res.json(updated);
}));

// تقرير مبيعات مبسّط للمورد عن فترة محددة — يستخدمه تطبيق المورد
// الفترة بالتقويم بتوقيت طرابلس: "اليوم" = من بداية اليوم الحالي، الأسبوع = آخر 7 أيام تقويمية، الشهر = آخر 30
// الأجزاء الملغية (os.status = 'cancelled') لا تدخل في المبيعات ولا العمولة
catalogRouter.get("/products/me/report", requireActorType("supplier"), asyncRoute(async (req, res) => {
  const period = z.enum(["today", "week", "month"]).default("week").parse(req.query.period);
  const days = period === "today" ? 1 : period === "week" ? 7 : 30;
  const sinceSql = `(date_trunc('day', now() AT TIME ZONE 'Africa/Tripoli') - (($2::INT - 1) * INTERVAL '1 day')) AT TIME ZONE 'Africa/Tripoli'`;

  // العمولة تُحسب على أساس صافي كل فاتورة (order_suppliers.subtotal × نسبتها الفعلية،
  // اللي ممكن تكون نسبة استثنائية لهذه الفاتورة بس، مش بالضرورة نسبة المورد الأساسية)
  // وتُقرَّب لكل جزء (فاتورة مورد) على حدة لخانتين — نفس طريقة التقريب في كشف الحسابات
  const totals = await query(
    `SELECT COUNT(DISTINCT os.id)::INT AS orders_count,
            COALESCE(SUM(os.subtotal), 0) AS total_sales,
            COALESCE(SUM(ROUND(os.subtotal * os.commission_rate / 100.0, 2)), 0) AS total_commission
       FROM order_suppliers os
       JOIN orders o ON o.id = os.order_id
      WHERE os.supplier_id = $1
        AND os.status <> 'cancelled'
        AND o.status IN ('delivered','closed')
        AND o.delivered_at >= ${sinceSql}`,
    [req.actor.id, days]
  );

  const topProducts = await query(
    `SELECT oi.product_id, oi.product_name AS name,
            SUM(oi.qty_confirmed) AS qty, SUM(oi.line_total) AS total
       FROM order_items oi
       JOIN order_suppliers os ON os.id = oi.order_supplier_id
       JOIN orders o           ON o.id  = oi.order_id
      WHERE os.supplier_id = $1
        AND os.status <> 'cancelled'
        AND o.status IN ('delivered','closed')
        AND o.delivered_at >= ${sinceSql}
      GROUP BY oi.product_id, oi.product_name
      ORDER BY total DESC
      LIMIT 10`,
    [req.actor.id, days]
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
    if (await productHasVariants(client, product.id)) throw new ApiError(400, HAS_VARIANTS_MSG);

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

    // تدقيق لكل الأطراف (مورد أو موظف) بالكمية قبل ← بعد
    await writeAudit(client, {
      actorType: req.actor.type, actorId: req.actor.id, actorName: req.actor.name,
      action: body.changeQty > 0 ? "product.stock_added" : "product.stock_deducted",
      entityType: "product", entityId: product.id,
      entityLabel: product.name, before: product, after: { ...updated, stock_reason: body.reason }, ip: req.ip,
    });

    if (Number(product.stock_qty) === 0 && newQty > 0) {
      await notifyFavoriteRestock(client, { productId: product.id, productName: product.name });
    }

    return { movement, product: updated };
  });

  res.status(201).json(result);
}));

// سجل الصنف الموحّد للإدارة: حركات المخزون + كل التعديلات، لكل تغيير: من (الاسم + النوع)، متى، أي حقل،
// القيمة قبل والقيمة بعد (اسم/سعر/صورة/كمية/كود/حالة الموافقة/قرارات الاعتماد والرفض/أنواع الصنف).
// سعر التكلفة لا يظهر إلا لمن يملك صلاحية pricing.cost.
const PRODUCT_FIELDS = {
  name: "الاسم", base_price: "السعر", image_url: "الصورة", stock_qty: "الكمية", supplier_sku: "كود الصنف",
  section_id: "القسم", is_active: "الحالة", unit: "وحدة البيع", approval_status: "حالة الموافقة",
  approval_note: "ملاحظة القرار", purchase_cost: "سعر التكلفة",
};
const VARIANT_FIELDS = {
  label: "اسم النوع", price: "سعر النوع", sku: "كود النوع", image_url: "صورة النوع", stock_qty: "كمية النوع",
  is_active: "حالة النوع", purchase_cost: "سعر تكلفة النوع",
};
const CREATE_PRODUCT_FIELDS = ["name", "base_price", "image_url", "stock_qty", "supplier_sku", "section_id", "approval_status"];
const CREATE_VARIANT_FIELDS = ["label", "price", "sku", "image_url", "stock_qty"];
const APPROVAL_LABELS = { pending: "بانتظار الموافقة", approved: "معتمد", rejected: "مرفوض" };
const ACTOR_TYPE_LABELS = { employee: "موظف", supplier: "مورد", customer: "عميل", driver: "مندوب" };
const HISTORY_TITLES = {
  "product.created": "إضافة الصنف", "product.deleted": "حذف الصنف", "product.approved": "اعتماد الصنف",
  "product.rejected": "رفض الصنف", "product.resubmitted": "عاد إلى بانتظار الموافقة",
  "product.updated_resubmitted": "تعديل الصنف — عاد إلى بانتظار الموافقة", "product.updated": "تعديل الصنف",
  "product.stock_added": "تعديل الكمية (إضافة)", "product.stock_deducted": "تعديل الكمية (خصم)",
  "product_variant.created": "إضافة نوع", "product_variant.deleted": "حذف نوع", "product_variant.updated": "تعديل نوع",
};

catalogRouter.get("/products/:id/history", requireAnyPermission("catalog.manage", "reports.view"), asyncRoute(async (req, res) => {
  const { rows: prod } = await query(`SELECT id, name FROM products WHERE id = $1`, [req.params.id]);
  if (!prod.length) throw new ApiError(404, "الصنف غير موجود");
  const canCost = await hasPermission(req, "pricing.cost");

  const { rows: moves } = await query(
    `SELECT sm.id, sm.variant_id, sm.change_qty, sm.reason, sm.created_by, sm.created_at, v.label AS variant_label
       FROM stock_movements sm
       LEFT JOIN product_variants v ON v.id = sm.variant_id
      WHERE sm.product_id = $1`,
    [req.params.id]
  );

  const { rows: audits } = await query(
    `SELECT id, action, actor_type, actor_id, actor_name, entity_type, entity_id, before_data, after_data, entity_label, created_at
       FROM audit_log
      WHERE (entity_type = 'product' AND entity_id = $1 AND action LIKE 'product.%')
         OR (entity_type = 'product_variant'
             AND COALESCE(after_data, before_data)->>'product_id' = $1::text)`,
    [req.params.id]
  );

  // أسماء الفاعلين (موظف / مورد / عميل) من المعرّف — للحركات (created_by فقط) ولصفوف التدقيق بدون اسم محفوظ
  const actorIds = [...new Set([...moves.map((m) => m.created_by), ...audits.map((a) => a.actor_id)].filter(Boolean))];
  const actorMap = new Map();
  if (actorIds.length) {
    const { rows } = await query(
      `SELECT id, name, 'employee' AS type FROM employees WHERE id = ANY($1::UUID[])
       UNION ALL SELECT id, business_name, 'supplier' FROM suppliers WHERE id = ANY($1::UUID[])
       UNION ALL SELECT id, business_name, 'customer' FROM customers WHERE id = ANY($1::UUID[])`,
      [actorIds]
    );
    for (const r of rows) actorMap.set(r.id, { name: r.name, type: r.type });
  }
  const actorOf = (id, storedType, storedName) => {
    const found = id ? actorMap.get(id) : null;
    const type = storedType || found?.type || null;
    return {
      actor_name: storedName || found?.name || "النظام",
      actor_type: type,
      actor_type_label: type ? (ACTOR_TYPE_LABELS[type] || type) : null,
    };
  };

  const { rows: secs } = await query(`SELECT id, name FROM sections`);
  const secName = Object.fromEntries(secs.map((x) => [x.id, x.name]));
  const MONEY_FIELDS = new Set(["base_price", "price", "purchase_cost"]);
  const show = (field, v) => {
    if (v === null || v === undefined || v === "") return "—";
    if (field === "section_id") return secName[v] || v;
    if (field === "is_active") return v ? "مفعّل" : "موقوف";
    if (field === "approval_status") return APPROVAL_LABELS[v] || v;
    if (MONEY_FIELDS.has(field)) return `${Number(v)} د.ل`;
    return String(v);
  };
  const sameValue = (b, c) => {
    if (String(b ?? "") === String(c ?? "")) return true;
    // رقم بنفس القيمة بصيغ مختلفة (600 مقابل 600.00) ما نعتبره تعديل
    return b != null && c != null && b !== "" && c !== "" && !isNaN(Number(b)) && !isNaN(Number(c)) && Number(b) === Number(c);
  };

  // حركات المخزون: نرتبط بصف التدقيق المرافق (نفس المعاملة = نفس created_at ونفس النوع) فنعرض الكمية قبل ← بعد مع السبب
  const keyOf = (at, variantId) => `${new Date(at).getTime()}|${variantId || ""}`;
  const moveByKey = new Map();
  for (const m of moves) {
    const k = keyOf(m.created_at, m.variant_id);
    if (!moveByKey.has(k)) moveByKey.set(k, []);
    moveByKey.get(k).push(m);
  }
  const usedMoves = new Set();

  const items = [];
  for (const a of audits) {
    const before = a.before_data || {};
    const after = a.after_data || {};
    const isVariant = a.entity_type === "product_variant";
    const variantLabel = isVariant ? (after.label || before.label || a.entity_label) : null;
    const fieldLabels = isVariant ? VARIANT_FIELDS : PRODUCT_FIELDS;
    const isCreate = a.action.endsWith(".created");
    const fieldNames = isCreate ? (isVariant ? CREATE_VARIANT_FIELDS : CREATE_PRODUCT_FIELDS) : Object.keys(fieldLabels);

    const changes = [];
    for (const field of fieldNames) {
      if (field === "purchase_cost" && !canCost) continue;
      if (!(field in before) && !(field in after)) continue;
      const b = before[field];
      const c = a.action.endsWith(".deleted") ? null : after[field];
      if (!isCreate && !a.action.endsWith(".deleted") && sameValue(b, c)) continue;
      if (isCreate && (c === null || c === undefined || c === "")) continue;
      if (a.action.endsWith(".deleted") && !["name", "label", "base_price", "price"].includes(field)) continue;
      const isImage = field === "image_url";
      changes.push({
        field, label: fieldLabels[field], type: isImage ? "image" : "text",
        from: isImage ? (b || null) : show(field, b),
        to: isImage ? (c || null) : show(field, c),
      });
    }

    // الكمية: نربطها بحركة المخزون المرافقة (لو وُجدت) ونخفي الحركة المنفصلة لتفادي التكرار
    let reason = null;
    let qtyChange = null;
    const stockChange = changes.find((c) => c.field === "stock_qty");
    if (stockChange) {
      const list = moveByKey.get(keyOf(a.created_at, isVariant ? (after.id || before.id) : null)) || [];
      const m = list.find((x) => !usedMoves.has(x.id));
      if (m) { usedMoves.add(m.id); reason = m.reason; qtyChange = Number(m.change_qty); }
    }
    if (!reason && a.action.startsWith("product.stock_") && after.stock_reason) reason = after.stock_reason;
    if (a.action === "product.resubmitted" && after.reason) reason = after.reason;

    const title = HISTORY_TITLES[a.action] || (isVariant ? "تعديل نوع" : "تعديل الصنف");
    const decision = ["product.approved", "product.rejected", "product.resubmitted"].includes(a.action);
    if (!changes.length && !decision && !["product.created", "product.deleted", "product_variant.created", "product_variant.deleted"].includes(a.action)) continue;

    items.push({
      id: `a-${a.id}`, kind: "edit", action: a.action, at: a.created_at,
      ...actorOf(a.actor_id, a.actor_type, a.actor_name),
      title, variant_label: variantLabel, qty_change: qtyChange, reason, changes,
    });
  }

  for (const m of moves) {
    if (usedMoves.has(m.id)) continue;
    const who = actorOf(m.created_by, null, null);
    items.push({
      id: `m-${m.id}`, kind: "stock", action: "stock_movement", at: m.created_at, ...who,
      title: "حركة مخزون", variant_label: m.variant_label, qty_change: Number(m.change_qty), reason: m.reason, changes: [],
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

/* ------------------------------ استيراد إكسل ------------------------------
   - خلية فارغة في الكمية أو السعر = "بدون تغيير" (مش صفر)
   - أي قيمة سالبة/غير رقمية = خطأ يخص هذا الصف، والعملية كلها تُلغى (كل شي أو لا شي) مع قائمة بالصفوف
   - الأكواد تُقرأ كنص (الأصفار في البداية تبقى) وتُقارن بدون حساسية لحالة الأحرف
   - حد أقصى 5000 صف في الطلب الواحد، يُعالَج على دفعات من 500 داخل معاملة واحدة
   - صفوف الهدف تُقفل FOR UPDATE بترتيب ثابت، وفرق الكمية يُحسب من القيمة المقفولة */
const IMPORT_MAX_ROWS = 5000;
const IMPORT_BATCH = 500;
const MAX_ERRORS_SHOWN = 30;

function parseImportNumber(raw, label, { positive = false } = {}) {
  if (raw === null || raw === undefined) return { value: null };
  let n;
  if (typeof raw === "number") {
    if (!Number.isFinite(raw)) return { error: `قيمة ${label} غير صالحة` };
    n = raw;
  } else {
    let t = String(raw).trim();
    if (!t) return { value: null };
    t = t.replace(/[٠-٩]/g, (d) => "٠١٢٣٤٥٦٧٨٩".indexOf(d)).replace(/٫/g, ".").replace(/٬/g, "").replace(/\s/g, "");
    t = /^\d+,\d{1,2}$/.test(t) ? t.replace(",", ".") : t.replace(/,/g, "");
    if (!/^-?\d+(\.\d+)?$/.test(t)) return { error: `قيمة ${label} "${String(raw).trim()}" ليست رقمًا صحيحًا` };
    n = Number(t);
  }
  if (n < 0) return { error: `قيمة ${label} لا يمكن أن تكون سالبة` };
  if (positive && n === 0) return { error: `قيمة ${label} يجب أن تكون أكبر من صفر` };
  if (n > 1_000_000_000) return { error: `قيمة ${label} كبيرة جدًا` };
  return { value: n };
}

const cellText = (v) => (v === null || v === undefined ? "" : String(v).trim());

function throwRowErrors(errors, prefix) {
  errors.sort((a, b) => a.row - b.row);
  const shown = errors.slice(0, MAX_ERRORS_SHOWN).map((e) => `صف ${e.row}: ${e.reason}`);
  const more = errors.length > MAX_ERRORS_SHOWN ? `\n… و${errors.length - MAX_ERRORS_SHOWN} صف آخر فيه أخطاء` : "";
  throw new ApiError(400, `${prefix}\n${shown.join("\n")}${more}`, "IMPORT_ROW_ERRORS");
}

// يقرأ صفوف الطلب الخام: يعيد الصفوف السليمة + قائمة الأخطاء + الصفوف المتجاهلة (بدون كود)
function normalizeImportRows(rawRows) {
  const rows = [];
  const errors = [];
  const skipped = [];
  const firstSeen = new Map();
  rawRows.forEach((r, i) => {
    const row = Number.isInteger(r?.rowNumber) ? r.rowNumber : i + 1;
    const name = cellText(r?.name);
    const sku = cellText(r?.supplierSku);
    if (!sku) {
      skipped.push({ name, row, reason: "رقم الصنف عندك مطلوب في وضع الاستيراد" });
      return;
    }
    const problems = [];
    if (sku.length > 100) problems.push("الكود أطول من 100 حرف");
    const price = parseImportNumber(r?.basePrice, "السعر", { positive: true });
    const qty = parseImportNumber(r?.stockQty, "الكمية");
    if (price.error) problems.push(price.error);
    if (qty.error) problems.push(qty.error);
    const key = sku.toLowerCase();
    if (firstSeen.has(key)) problems.push(`الكود "${sku}" مكرر في الملف (ظهر أول مرة في الصف ${firstSeen.get(key)})`);
    else firstSeen.set(key, row);
    if (problems.length) { errors.push({ row, reason: problems.join(" — ") }); return; }
    rows.push({
      row, key, sku, name, unit: cellText(r?.unit),
      sectionName: cellText(r?.sectionName),
      sectionId: typeof r?.sectionId === "string" && /^[0-9a-f-]{36}$/i.test(r.sectionId) ? r.sectionId : null,
      price: price.value === null ? null : Math.round(price.value * 100) / 100,
      qty: qty.value,
    });
  });
  return { rows, errors, skipped };
}

async function loadSupplierSectionIds(client, supplierId) {
  const { rows } = await client.query(
    `SELECT s.id FROM sections s
       JOIN supplier_sections ss ON ss.section_id = COALESCE(s.parent_id, s.id)
      WHERE ss.supplier_id = $1 AND ss.enabled AND s.is_active`,
    [supplierId]
  );
  return new Set(rows.map((r) => r.id));
}

async function createAdditionVoucher(client, req, supplierId, reason) {
  const number = await nextDocNumber(client, {
    table: "stock_vouchers", column: "voucher_number", prefix: "ADD", start: 1000,
  });
  const { rows: [v] } = await client.query(
    `INSERT INTO stock_vouchers
       (voucher_number, voucher_type, supplier_id, reason, created_by, created_by_type, created_by_name)
     VALUES ($1,'addition',$2,$3,$4,$5,$6) RETURNING *`,
    [number, supplierId, reason, req.actor.id, req.actor.type, req.actor.name]
  );
  return v;
}

const importBodySchema = z.object({
  rows: z.array(z.record(z.any())).min(1).max(IMPORT_MAX_ROWS, `الحد الأقصى ${IMPORT_MAX_ROWS} صف في الملف الواحد`),
  supplierId: z.string().uuid().optional(),
});

// استيراد بالجملة يعتمد على "رقم الصنف عند المورد" كمفتاح مطابقة:
// - رقم موجود بالفعل عند هذا المورد (صنف أو نوع) → تُسجَّل حركة مخزون تلقائيًا (وليس صنف جديد)
// - رقم غير موجود → لا يُضاف تلقائيًا، بل يُعاد في needsConfirmation ليراجعه المورد
// يُنشئ "فاتورة إضافة" واحدة تجمع كل الأصناف اللي زادت كميتها في هذا الاستيراد.
// المورد يستورد لنفسه، والأدمن (بصلاحية catalog.manage) يقدر يستورد نيابة عن أي مورد بتحديد supplierId
catalogRouter.post("/products/import", asyncRoute(async (req, res, next) => {
  if (req.actor.type === "supplier") return next();
  return requirePermission("catalog.manage")(req, res, next);
}), asyncRoute(async (req, res) => {
  const { rows: rawRows, supplierId: bodySupplierId } = importBodySchema.parse(req.body);

  const supplierId = req.actor.type === "supplier" ? req.actor.id : bodySupplierId;
  if (!supplierId) throw new ApiError(400, "يجب تحديد المورد");

  const { rows, errors, skipped } = normalizeImportRows(rawRows);
  const isSupplier = req.actor.type === "supplier";

  const result = await withTransaction(async (client) => {
    await lockSupplierSkus(client, supplierId);
    const sectionIds = await loadSupplierSectionIds(client, supplierId);
    const updated = [];
    const needsConfirmation = [];
    let unchanged = 0;
    let voucher = null;
    const ensureVoucher = async () => (voucher ??= await createAdditionVoucher(client, req, supplierId, "استيراد إكسل"));

    // ترتيب ثابت بالكود → ترتيب أقفال ثابت بين أي استيرادين متزامنين
    const sorted = [...rows].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

    for (let i = 0; i < sorted.length; i += IMPORT_BATCH) {
      const batch = sorted.slice(i, i + IMPORT_BATCH);
      const keys = batch.map((r) => r.key);

      const { rows: vRows } = await client.query(
        `SELECT v.*, p.name AS product_name
           FROM product_variants v JOIN products p ON p.id = v.product_id
          WHERE p.supplier_id = $1 AND lower(v.sku) = ANY($2::TEXT[])
          ORDER BY v.id
            FOR UPDATE OF v`,
        [supplierId, keys]
      );
      const { rows: pRows } = await client.query(
        `SELECT p.* FROM products p
          WHERE p.supplier_id = $1 AND lower(p.supplier_sku) = ANY($2::TEXT[])
          ORDER BY p.id
            FOR UPDATE`,
        [supplierId, keys]
      );
      const withVariants = new Set(
        pRows.length
          ? (await client.query(`SELECT DISTINCT product_id FROM product_variants WHERE product_id = ANY($1::UUID[])`,
              [pRows.map((p) => p.id)])).rows.map((r) => r.product_id)
          : []
      );
      const vByKey = new Map();
      for (const v of vRows) { const k = v.sku.toLowerCase(); vByKey.set(k, [...(vByKey.get(k) || []), v]); }
      const pByKey = new Map();
      for (const p of pRows) { const k = p.supplier_sku.toLowerCase(); pByKey.set(k, [...(pByKey.get(k) || []), p]); }

      for (const r of batch) {
        const vm = vByKey.get(r.key) || [];
        const pm = pByKey.get(r.key) || [];
        if (vm.length > 1 || (!vm.length && pm.length > 1)) {
          errors.push({ row: r.row, reason: `الكود "${r.sku}" مكرر عند أكثر من صنف/نوع عندك — صحّح الأكواد المكررة أولًا` });
          continue;
        }

        // ---- كود نوع (لون/مقاس)
        if (vm.length === 1) {
          const variant = vm[0];
          if (!variant.is_active) {
            errors.push({ row: r.row, reason: `النوع "${variant.product_name} — ${variant.label}" موقوف — فعّله أولًا قبل الاستيراد` });
            continue;
          }
          const oldQty = Number(variant.stock_qty);
          const newQty = r.qty ?? oldQty;
          const newPrice = r.price ?? Number(variant.price);
          const delta = newQty - oldQty;
          if (delta === 0 && newPrice === Number(variant.price)) { unchanged++; continue; }

          let saved = variant;
          if (delta !== 0) {
            const voucherId = delta > 0 ? (await ensureVoucher()).id : null;
            saved = await moveVariantStock(client, req.actor, variant, delta,
              delta > 0 ? "استيراد إكسل — زيادة كمية نوع" : "استيراد إكسل — تخفيض كمية نوع", voucherId);
          }
          if (newPrice !== Number(variant.price)) {
            const { rows: [pr] } = await client.query(`UPDATE product_variants SET price = $2 WHERE id = $1 RETURNING *`, [variant.id, newPrice]);
            saved = pr;
          }
          await writeAudit(client, {
            actorType: req.actor.type, actorId: req.actor.id, actorName: req.actor.name,
            action: "product_variant.updated", entityType: "product_variant", entityId: variant.id,
            entityLabel: `${variant.product_name} — ${variant.label}`, before: variant, after: saved, ip: req.ip,
          });
          // تغيير السعر بالإكسل لا يرجّع الصنف للموافقة — مسجّل في التدقيق أعلاه
          updated.push({ ...saved, name: `${variant.product_name} — ${variant.label}` });
          if (oldQty === 0 && Number(saved.stock_qty) > 0) {
            await notifyFavoriteRestock(client, { productId: variant.product_id, productName: variant.product_name });
          }
          continue;
        }

        // ---- كود صنف
        if (pm.length === 1) {
          const product = pm[0];
          if (withVariants.has(product.id)) {
            errors.push({ row: r.row, reason: `الصنف "${product.name}" له أنواع — استخدم كود كل نوع بدل كود الصنف` });
            continue;
          }
          const oldQty = Number(product.stock_qty);
          const newQty = r.qty ?? oldQty;
          const newPrice = r.price ?? Number(product.base_price);
          const delta = newQty - oldQty;
          if (delta === 0 && newPrice === Number(product.base_price)) { unchanged++; continue; }

          if (delta !== 0) {
            const voucherId = delta > 0 ? (await ensureVoucher()).id : null;
            await client.query(
              `INSERT INTO stock_movements (product_id, change_qty, reason, created_by, voucher_id)
               VALUES ($1,$2,$3,$4,$5)`,
              [product.id, delta, delta > 0 ? "استيراد إكسل — زيادة كمية" : "استيراد إكسل — تخفيض كمية", req.actor.id, voucherId]
            );
          }
          const priceChanged = newPrice !== Number(product.base_price);
          const { rows: [saved] } = await client.query(
            `UPDATE products SET stock_qty = $2, base_price = $3 WHERE id = $1 RETURNING *`,
            [product.id, newQty, newPrice]
          );
          if (priceChanged) {
            await client.query(
              `INSERT INTO price_history (product_id, old_price, new_price, changed_by, changed_by_name)
               VALUES ($1,$2,$3,$4,$5)`,
              [product.id, product.base_price, newPrice, req.actor.id, req.actor.name]
            );
          }
          await writeAudit(client, {
            actorType: req.actor.type, actorId: req.actor.id, actorName: req.actor.name,
            action: "product.updated", entityType: "product", entityId: product.id,
            entityLabel: product.name, before: product, after: saved, ip: req.ip,
          });
          // تغيير السعر بالإكسل لا يرجّع الصنف للموافقة — مسجّل في التدقيق وprice_history أعلاه
          updated.push(saved);
          if (oldQty === 0 && newQty > 0) {
            await notifyFavoriteRestock(client, { productId: product.id, productName: product.name });
          }
          continue;
        }

        // ---- كود غير موجود: صنف جديد محتمل (يحتاج مراجعة وتأكيد)
        const problems = [];
        if (r.name.length < 2) problems.push("اسم الصنف مطلوب (حرفان على الأقل) للصنف الجديد");
        if (!r.unit) problems.push("وحدة البيع مطلوبة للصنف الجديد");
        if (r.price === null) problems.push("السعر مطلوب للصنف الجديد");
        if (problems.length) {
          errors.push({ row: r.row, reason: `الكود "${r.sku}" غير موجود عندك (صنف جديد) — ${problems.join("، ")}` });
          continue;
        }
        if (!r.sectionId || !sectionIds.has(r.sectionId)) {
          skipped.push({ name: r.name, row: r.row, reason: "القسم غير مطابق لأقسامك المعتمدة" });
          continue;
        }
        needsConfirmation.push({
          row: r.row, rowNumber: r.row, sectionId: r.sectionId, sectionName: r.sectionName,
          name: r.name, unit: r.unit, basePrice: r.price, stockQty: r.qty ?? 0, supplierSku: r.sku,
        });
      }
    }

    if (errors.length) {
      throwRowErrors(errors, "تعذّر الاستيراد — لم يتغيّر أي شي. صحّح الصفوف التالية في الملف وأعد الرفع:");
    }

    if (updated.length) {
      await writeAudit(client, {
        actorType: req.actor.type, actorId: req.actor.id, actorName: req.actor.name,
        action: "products.import_stock_updated", entityType: "product", entityId: supplierId,
        entityLabel: `تحديث مخزون ${updated.length} صنف عبر إكسل`, after: { count: updated.length }, ip: req.ip,
      });
    }

    needsConfirmation.sort((a, b) => a.row - b.row);
    return { updated, needsConfirmation, voucher, unchanged };
  });

  res.status(201).json({
    updatedCount: result.updated.length,
    unchangedCount: result.unchanged,
    needsConfirmationCount: result.needsConfirmation.length,
    skippedCount: skipped.length,
    updated: result.updated,
    needsConfirmation: result.needsConfirmation,
    skipped,
    voucher: result.voucher,
  });
}));

// تأكيد إضافة أصناف جديدة فعليًا (بعد ما راجعها المورد/الأدمن يدويًا من شاشة needsConfirmation)
// — تُنشئ فاتورة إضافة منفصلة خاصة بالأصناف الجديدة كليًا
catalogRouter.post("/products/import/confirm-new", asyncRoute(async (req, res, next) => {
  if (req.actor.type === "supplier") return next();
  return requirePermission("catalog.manage")(req, res, next);
}), asyncRoute(async (req, res) => {
  const { rows: rawRows, supplierId: bodySupplierId } = importBodySchema.parse(req.body);

  const supplierId = req.actor.type === "supplier" ? req.actor.id : bodySupplierId;
  if (!supplierId) throw new ApiError(400, "يجب تحديد المورد");

  const { rows, errors, skipped: noSku } = normalizeImportRows(rawRows);
  for (const s of noSku) errors.push({ row: s.row, reason: "رقم الصنف مطلوب" });

  let result;
  try {
    result = await withTransaction(async (client) => {
      await lockSupplierSkus(client, supplierId);
      const sectionIds = await loadSupplierSectionIds(client, supplierId);

      // التحقق الكامل قبل أي إدخال
      for (const r of rows) {
        const problems = [];
        if (r.name.length < 2) problems.push("اسم الصنف مطلوب (حرفان على الأقل)");
        if (!r.unit) problems.push("وحدة البيع مطلوبة");
        if (r.price === null) problems.push("السعر مطلوب");
        if (!r.sectionId) problems.push("القسم مطلوب");
        else if (!sectionIds.has(r.sectionId)) problems.push("القسم غير مفعّل لهذا المورد");
        if (problems.length) errors.push({ row: r.row, reason: problems.join("، ") });
      }
      // الأكواد الموجودة مسبقًا (صنف أو نوع) — تُبلَّغ بوضوح بدل خطأ قاعدة البيانات
      const keys = rows.map((r) => r.key);
      for (let i = 0; i < keys.length; i += IMPORT_BATCH) {
        const chunk = keys.slice(i, i + IMPORT_BATCH);
        const { rows: taken } = await client.query(
          `SELECT lower(p.supplier_sku) AS k, p.name AS product_name, NULL::TEXT AS label
             FROM products p WHERE p.supplier_id = $1 AND lower(p.supplier_sku) = ANY($2::TEXT[])
           UNION ALL
           SELECT lower(v.sku), p.name, v.label
             FROM product_variants v JOIN products p ON p.id = v.product_id
            WHERE p.supplier_id = $1 AND lower(v.sku) = ANY($2::TEXT[])`,
          [supplierId, chunk]
        );
        const takenBy = new Map(taken.map((t) => [t.k, t]));
        for (const r of rows) {
          const t = takenBy.get(r.key);
          if (t) errors.push({ row: r.row, reason: `الكود "${r.sku}" موجود مسبقًا عندك (${t.label ? `${t.product_name} — ${t.label}` : t.product_name})` });
        }
      }
      if (errors.length) throwRowErrors(errors, "تعذّرت إضافة الأصناف الجديدة — لم يُضَف أي صنف. صحّح الصفوف التالية:");

      const isEmployee = req.actor.type === "employee";
      const approval = isEmployee ? "approved" : "pending";
      const withQty = rows.some((r) => (r.qty ?? 0) > 0);
      const voucher = withQty
        ? await createAdditionVoucher(client, req, supplierId, "استيراد إكسل — أصناف جديدة")
        : null;

      const created = [];
      for (let i = 0; i < rows.length; i += IMPORT_BATCH) {
        const chunk = rows.slice(i, i + IMPORT_BATCH);
        const { rows: made } = await client.query(
          `INSERT INTO products
             (section_id, supplier_id, name, unit, base_price, stock_qty, supplier_sku, approval_status, added_by)
           SELECT t.section_id, $1::UUID, t.name, t.unit, t.price, t.qty, t.sku, $2, $3::UUID
             FROM unnest($4::UUID[], $5::TEXT[], $6::TEXT[], $7::NUMERIC[], $8::NUMERIC[], $9::TEXT[])
                  AS t(section_id, name, unit, price, qty, sku)
           RETURNING *`,
          [supplierId, approval, isEmployee ? req.actor.id : null,
           chunk.map((r) => r.sectionId), chunk.map((r) => r.name), chunk.map((r) => r.unit),
           chunk.map((r) => r.price), chunk.map((r) => r.qty ?? 0), chunk.map((r) => r.sku)]
        );
        created.push(...made);
        const withStock = made.filter((p) => Number(p.stock_qty) > 0);
        if (withStock.length) {
          await client.query(
            `INSERT INTO stock_movements (product_id, change_qty, reason, created_by, voucher_id)
             SELECT t.product_id, t.qty, 'رصيد افتتاحي — صنف جديد', $3::UUID, $4::UUID
               FROM unnest($1::UUID[], $2::NUMERIC[]) AS t(product_id, qty)`,
            [withStock.map((p) => p.id), withStock.map((p) => p.stock_qty), req.actor.id, voucher.id]
          );
        }
      }

      // صف تدقيق لكل صنف جديد (ليظهر في سجل الصنف: من أضافه ومتى وبأي سعر/اسم/كمية)
      if (created.length) {
        await client.query(
          `INSERT INTO audit_log (actor_type, actor_id, actor_name, action, entity_type, entity_id, entity_label, after_data, ip_address)
           SELECT $1, $2::UUID, $3, 'product.created', 'product', (x->>'id')::UUID, x->>'name', x, $4
             FROM jsonb_array_elements($5::JSONB) AS x`,
          [req.actor.type, req.actor.id, req.actor.name, req.ip, JSON.stringify(created)]
        );
      }
      await writeAudit(client, {
        actorType: req.actor.type, actorId: req.actor.id, actorName: req.actor.name,
        action: "products.imported_new", entityType: "product", entityId: supplierId,
        entityLabel: `إضافة ${created.length} صنف جديد عبر إكسل`, after: { count: created.length }, ip: req.ip,
      });

      return { created, voucher };
    });
  } catch (e) {
    if (e?.code === "23505") throw new ApiError(409, "أحد الأكواد صار موجودًا للتو (إضافة متزامنة) — أعد المحاولة");
    throw e;
  }

  res.status(201).json({ createdCount: result.created.length, created: result.created, voucher: result.voucher });
}));

// فاتورة إضافة/خصم مخزون يدوية — عدة أصناف (أو أنواع) مع بعض بفاتورة واحدة، بدل صنف بصنف.
// السطر إما صنف عادي (productId) أو نوع محدد (variantId) — الصنف ذو الأنواع لازم يُحدَّد فيه النوع.
// المورد ينشئها لنفسه، والأدمن (بصلاحية catalog.manage) ينشئها لأي مورد بتحديد supplierId
const voucherSchema = z.object({
  voucherType: z.enum(["addition", "discount"]),
  supplierId: z.string().uuid().optional(),
  reason: z.string().trim().min(2).max(300),
  items: z.array(z.object({
    productId: z.string().uuid().optional(),
    variantId: z.string().uuid().optional(),
    qty: z.number().positive(),
  }).refine((i) => i.productId || i.variantId, "حدّد الصنف أو النوع")).min(1).max(200),
});

async function voucherLines(client, voucherId) {
  const { rows } = await client.query(
    `SELECT sm.*, p.name AS product_name, p.unit, p.supplier_sku,
            v.label AS variant_label, v.sku AS variant_sku
       FROM stock_movements sm
       JOIN products p ON p.id = sm.product_id
       LEFT JOIN product_variants v ON v.id = sm.variant_id
      WHERE sm.voucher_id = $1
      ORDER BY sm.created_at, sm.id`,
    [voucherId]
  );
  return rows;
}

catalogRouter.post("/stock-vouchers", asyncRoute(async (req, res, next) => {
  if (req.actor.type === "supplier") return next();
  return requirePermission("catalog.manage")(req, res, next);
}), asyncRoute(async (req, res) => {
  const body = voucherSchema.parse(req.body);
  const supplierId = req.actor.type === "supplier" ? req.actor.id : body.supplierId;
  if (!supplierId) throw new ApiError(400, "يجب تحديد المورد");

  // دمج السطور المكررة لنفس الصنف/النوع في سطر واحد
  const variantQty = new Map();   // variantId -> { qty, productId }
  const productQty = new Map();   // productId -> qty
  for (const it of body.items) {
    if (it.variantId) {
      const cur = variantQty.get(it.variantId) || { qty: 0, productId: it.productId || null };
      variantQty.set(it.variantId, { qty: cur.qty + it.qty, productId: cur.productId || it.productId || null });
    } else {
      productQty.set(it.productId, (productQty.get(it.productId) || 0) + it.qty);
    }
  }
  const sign = body.voucherType === "addition" ? 1 : -1;

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

    // قفل كل الصفوف المعنية بترتيب ثابت (الأنواع ثم الأصناف، كلٌّ مرتّب بالمعرّف) لتفادي الـ deadlock
    const variantIds = [...variantQty.keys()].sort();
    const productIds = [...productQty.keys()].sort();

    const variants = variantIds.length ? (await client.query(
      `SELECT v.*, p.name AS product_name, p.supplier_id
         FROM product_variants v JOIN products p ON p.id = v.product_id
        WHERE v.id = ANY($1::UUID[])
        ORDER BY v.id
          FOR UPDATE OF v`,
      [variantIds]
    )).rows : [];
    if (variants.length !== variantIds.length) throw new ApiError(404, "أحد الأنواع غير موجود");

    const products = productIds.length ? (await client.query(
      `SELECT * FROM products WHERE id = ANY($1::UUID[]) ORDER BY id FOR UPDATE`,
      [productIds]
    )).rows : [];
    if (products.length !== productIds.length) throw new ApiError(404, "أحد الأصناف غير موجود");

    for (const v of variants) {
      if (v.supplier_id !== supplierId) throw new ApiError(400, `النوع "${v.product_name} — ${v.label}" لا يخص هذا المورد`);
      const expect = variantQty.get(v.id).productId;
      if (expect && expect !== v.product_id) throw new ApiError(400, `النوع "${v.label}" لا يتبع الصنف المحدد`);
      const change = sign * variantQty.get(v.id).qty;
      if (Number(v.stock_qty) + change < 0) {
        throw new ApiError(400, `الكمية غير كافية للنوع: ${v.product_name} — ${v.label} (المتوفر ${v.stock_qty})`);
      }
      const saved = await moveVariantStock(client, req.actor, v, change, body.reason, voucher.id);
      await writeAudit(client, {
        actorType: req.actor.type, actorId: req.actor.id, actorName: req.actor.name,
        action: "product_variant.updated", entityType: "product_variant", entityId: v.id,
        entityLabel: `${v.product_name} — ${v.label} (${number})`, before: v, after: saved, ip: req.ip,
      });
      if (Number(v.stock_qty) === 0 && Number(saved.stock_qty) > 0) {
        await notifyFavoriteRestock(client, { productId: v.product_id, productName: v.product_name });
      }
    }

    for (const product of products) {
      if (product.supplier_id !== supplierId) {
        throw new ApiError(400, `الصنف "${product.name}" لا يخص هذا المورد`);
      }
      if (await productHasVariants(client, product.id)) {
        throw new ApiError(400, `الصنف "${product.name}": ${HAS_VARIANTS_MSG}`);
      }

      const changeQty = sign * productQty.get(product.id);
      const newQty = Number(product.stock_qty) + changeQty;
      if (newQty < 0) throw new ApiError(400, `الكمية غير كافية للصنف: ${product.name}`);

      await client.query(
        `INSERT INTO stock_movements (product_id, change_qty, reason, created_by, voucher_id)
         VALUES ($1,$2,$3,$4,$5)`,
        [product.id, changeQty, body.reason, req.actor.id, voucher.id]
      );
      const { rows: [savedProduct] } = await client.query(`UPDATE products SET stock_qty = $2 WHERE id = $1 RETURNING *`, [product.id, newQty]);
      await writeAudit(client, {
        actorType: req.actor.type, actorId: req.actor.id, actorName: req.actor.name,
        action: changeQty > 0 ? "product.stock_added" : "product.stock_deducted",
        entityType: "product", entityId: product.id,
        entityLabel: `${product.name} (${number})`, before: product, after: savedProduct, ip: req.ip,
      });

      if (Number(product.stock_qty) === 0 && newQty > 0) {
        await notifyFavoriteRestock(client, { productId: product.id, productName: product.name });
      }
    }

    const lines = await voucherLines(client, voucher.id);
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
  if (!["supplier", "employee"].includes(req.actor.type)) throw new ApiError(403, "غير مصرّح");
  // الموظف يحتاج نفس صلاحية القائمة (reports.view) — كانت تفاصيل الفاتورة مفتوحة لأي موظف
  if (req.actor.type === "employee") {
    await new Promise((resolve, reject) => {
      requirePermission("reports.view")(req, res, (err) => (err ? reject(err) : resolve()));
    });
  }

  const { rows: vRows } = await query(
    `SELECT sv.*, s.business_name AS supplier_name
       FROM stock_vouchers sv JOIN suppliers s ON s.id = sv.supplier_id
      WHERE sv.id = $1`,
    [req.params.id]
  );
  if (!vRows.length) throw new ApiError(404, "الفاتورة غير موجودة");
  const voucher = vRows[0];
  if (req.actor.type === "supplier" && voucher.supplier_id !== req.actor.id) {
    throw new ApiError(403, "لا تملك صلاحية الاطلاع على هذه الفاتورة");
  }

  res.json({ voucher, lines: await voucherLines({ query }, req.params.id) });
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

  // المورد/غيره: اسم ومعرّف فقط — بيانات الاتصال والموقع لبقية الموردين ليست لهم
  if (req.actor.type !== "employee") {
    if (req.actor.type !== "supplier") throw new ApiError(403, "غير مصرّح");
    const { rows } = await query(`SELECT id, business_name AS name FROM suppliers WHERE status = 'approved' ORDER BY business_name`);
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
