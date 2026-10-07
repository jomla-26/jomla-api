import { setInitialLoginCode } from "../lib/loginCode.js";
import { Router } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { pool, query, withTransaction, writeAudit } from "../lib/db.js";
import { ApiError, asyncRoute, normalizePhone } from "../lib/helpers.js";
import { parseRange, addRange, andClause } from "../lib/dateRange.js";
import {
  authenticate, requirePermission, getEmployeeSectionScope, assertSectionScope,
  stripSecrets, invalidateAuthCache, employeeHasPermission,
} from "../middleware/auth.js";
import { queueNotification, notifyStaffWithPermission } from "../lib/notify.js";

export const accountsRouter = Router();

// ترقيم اختياري للقوائم: limit (افتراضي 200، أقصى 1000) و offset
function pageParams(req, defLimit = 200, maxLimit = 1000) {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || defLimit, 1), maxLimit);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
  return { limit, offset };
}

// حد التسجيل الذاتي العام: 10 محاولات بالساعة لكل IP
const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "محاولات تسجيل كثيرة من نفس الجهاز، يرجى المحاولة لاحقًا" },
});

const registerSchema = z.object({
  businessName: z.string().trim().min(2).max(200),
  phone: z.string().min(9).max(20),
  address: z.string().max(500).optional(),
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
  ownerName: z.string().max(200).optional(),
  contactPerson: z.string().max(200).optional(),
  businessTypes: z.array(z.string().max(100)).max(30).optional(),
  // النسبة التي يكتبها المورد بنفسه عند التسجيل تُحفظ كـ "مطلوبة" للعلم فقط —
  // النسبة الفعلية تحددها الإدارة عند الاعتماد
  commissionRate: z.number().min(0).max(100).optional(),
});

accountsRouter.post("/:kind/register", registerLimiter, asyncRoute(async (req, res) => {
  const cfg = assertKind(req.params.kind);
  const body = registerSchema.parse(req.body);
  const phone = normalizePhone(body.phone);

  const created = await withTransaction(async (client) => {
    const dup = await client.query(`SELECT id FROM ${cfg.table} WHERE phone = $1`, [phone]);
    if (dup.rows.length) throw new ApiError(409, "رقم الهاتف مسجّل مسبقًا");

    const columns = req.params.kind === "customer"
      ? { extra: "owner_name", value: body.ownerName ?? null }
      : { extra: "contact_person", value: body.contactPerson ?? null };

    const extraCols = req.params.kind === "supplier" ? ", commission_rate_requested" : "";
    const extraPlaceholder = req.params.kind === "supplier" ? ", $8" : "";
    const values = [body.businessName, phone,
      body.address ?? null, body.latitude ?? null, body.longitude ?? null,
      body.businessTypes ?? null, columns.value];
    if (req.params.kind === "supplier") values.push(body.commissionRate ?? null);

    const { rows } = await client.query(
      `INSERT INTO ${cfg.table}
              (business_name, phone,
               address, latitude, longitude, status,
               joined_via, business_types, ${columns.extra}${extraCols})

            VALUES ($1,$2,$3,$4,$5,'pending','self',$6,$7${extraPlaceholder})
       RETURNING *`,
             values
    );
    const row = rows[0];

    await writeAudit(client, {
      actorType: req.params.kind, actorId: row.id, actorName: body.businessName,
      action: `${req.params.kind}.self_registered`, entityType: req.params.kind, entityId: row.id,
      entityLabel: body.businessName, after: stripSecrets(row), ip: req.ip,
    });
    await notifyStaffWithPermission(client, {
      permissionCode: "accounts.approve", templateCode: "account.new_registration",
      vars: { business_name: body.businessName, kind: req.params.kind === "supplier" ? "مورد" : "عميل" },
    });
    return stripSecrets(row);
  });

  res.status(201).json(created);
}));

accountsRouter.use(authenticate);

// سجل تدقيق عام لكل العمليات المسجّلة في المنظومة (اعتماد، تعديل، حذف...) — عرض فقط
// لازم يكون معرّف بعد accountsRouter.use(authenticate) فوق (وإلا req.actor يكون غير معرّف
// جوة requirePermission ويطيّر المستخدم لتسجيل الدخول)، وقبل مسارات "/:kind" العامة تحت
// (وإلا Express يفهم "audit/logs" كإنه kind="audit" و id="logs" ويرفضها بدل ما يوصل لهذا المسار)
accountsRouter.get("/audit/logs", requirePermission("accounts.approve"), asyncRoute(async (req, res) => {
  const { entityType, search, actorId, entityId } = req.query;
  const pg = pageParams(req, 200, 500);
  const range = parseRange(req.query);
  const params = [entityType || null, search || null, pg.limit, actorId || null, entityId || null, pg.offset];
  const conds = addRange("created_at", range, params, []);
  const { rows } = await query(
    `SELECT * FROM audit_log
      WHERE ($1::TEXT IS NULL OR entity_type = $1)
        AND ($2::TEXT IS NULL OR actor_name ILIKE '%'||$2||'%' OR entity_label ILIKE '%'||$2||'%' OR action ILIKE '%'||$2||'%')
        AND ($4::UUID IS NULL OR actor_id = $4)
        AND ($5::UUID IS NULL OR entity_id = $5)${andClause(conds)}
      ORDER BY created_at DESC
      LIMIT $3 OFFSET $6`,
    params
  );
  res.json(rows);
}));

const ENTITY = {
  customer: { table: "customers", sectionTable: "customer_sections", idCol: "customer_id" },
  supplier: { table: "suppliers", sectionTable: "supplier_sections", idCol: "supplier_id" },
};

function assertKind(kind) {
  if (!ENTITY[kind]) throw new ApiError(400, "نوع الحساب غير معروف");
  return ENTITY[kind];
}

async function fetchSections(client, cfg, entityId) {
  const { rows } = await client.query(
    `SELECT s.id, s.name, st.enabled
       FROM ${cfg.sectionTable} st JOIN sections s ON s.id = st.section_id
      WHERE st.${cfg.idCol} = $1
      ORDER BY s.sort_order`,
    [entityId]
  );
  return rows;
}

// موظف مقيّد بأقسام يقدر دايمًا يشوف الحسابات "بانتظار الاعتماد" (ما عندهاش أقسام
// معيّنة بعد أصلًا)، بس الحسابات المعتمدة/الموقوفة يشوف بس اللي فيها قسم من نطاقه
function withinScope(account, scope) {
  if (scope === null) return true;
  if (account.status === "pending") return true;
  return (account.sections || []).some((s) => scope.has(s.id));
}

accountsRouter.get("/:kind", requirePermission("accounts.approve"), asyncRoute(async (req, res) => {
  const cfg = assertKind(req.params.kind);
  const { status, search, includeDeleted } = req.query;

  const nameCol = "business_name";
  const pg = pageParams(req);
  const scope = await getEmployeeSectionScope(req.actor.id);
  // التقييد بنطاق الأقسام يتم داخل الاستعلام نفسه حتى يشتغل الترقيم صح
  const { rows } = await query(
    `SELECT * FROM ${cfg.table} t
      WHERE ($1::TEXT IS NULL OR t.status = $1)
        AND ($3::BOOLEAN = TRUE OR t.status != 'deleted' OR $1 = 'deleted')
        AND ($2::TEXT IS NULL OR t.${nameCol} ILIKE '%'||$2||'%' OR t.phone ILIKE '%'||$2||'%')
        AND ($6::UUID[] IS NULL OR t.status = 'pending' OR EXISTS (
              SELECT 1 FROM ${cfg.sectionTable} st
               WHERE st.${cfg.idCol} = t.id AND st.section_id = ANY($6::UUID[])))
      ORDER BY t.created_at DESC
      LIMIT $4 OFFSET $5`,
    [status || null, search || null, includeDeleted === "true", pg.limit, pg.offset, scope ? [...scope] : null]
  );

  const withSections = await Promise.all(
    rows.map(async (r) => ({ ...stripSecrets(r), sections: await fetchSections(pool, cfg, r.id).catch(() => []) }))
  );

  res.json(withSections.filter((r) => withinScope(r, scope)));
}));

const updateSchema = z.object({
  businessName: z.string().trim().min(2).max(200).optional(),
  phone: z.string().min(9).max(20).optional(),
  address: z.string().max(500).optional(),
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
  businessTypes: z.array(z.string().max(100)).max(30).optional(),
  ownerName: z.string().max(200).optional(),
  contactPerson: z.string().max(200).optional(),
  paymentTerms: z.string().max(500).optional(),
});

accountsRouter.patch("/:kind/:id", requirePermission("accounts.approve"), asyncRoute(async (req, res) => {
  const cfg = assertKind(req.params.kind);
  const body = updateSchema.parse(req.body);

  if (Object.keys(body).length === 0) {
    throw new ApiError(400, "لا توجد بيانات للتعديل");
  }

  const result = await withTransaction(async (client) => {
    const before = await client.query(`SELECT * FROM ${cfg.table} WHERE id = $1 FOR UPDATE`, [req.params.id]);
    if (!before.rows.length) throw new ApiError(404, "الحساب غير موجود");

    const beforeSections = await fetchSections(client, cfg, req.params.id);
    const scope = await getEmployeeSectionScope(req.actor.id);
    if (!withinScope({ ...before.rows[0], sections: beforeSections }, scope)) {
      throw new ApiError(403, "لا تملك صلاحية على هذا الحساب");
    }

    if (body.phone) {
      const normalized = normalizePhone(body.phone);
      const dup = await client.query(
        `SELECT id FROM ${cfg.table} WHERE phone = $1 AND id != $2`,
        [normalized, req.params.id]
      );
      if (dup.rows.length) throw new ApiError(409, "رقم الهاتف مسجّل مسبقًا لحساب آخر");
      body.phone = normalized;
    }

    const fieldMap = {
      businessName: "business_name",
      phone: "phone",
      address: "address",
      latitude: "latitude",
      longitude: "longitude",
      businessTypes: "business_types",
      ownerName: "owner_name",
      contactPerson: "contact_person",
      paymentTerms: "payment_terms",
    };

    const setClauses = [];
    const values = [req.params.id];
    let i = 2;
    for (const [key, col] of Object.entries(fieldMap)) {
      if (body[key] !== undefined) {
        setClauses.push(`${col} = $${i}`);
        values.push(body[key]);
        i++;
      }
    }

    // تغيير رقم الهاتف يلغي أي رمز تحقق صادر للرقم القديم
    if (body.phone !== undefined && body.phone !== before.rows[0].phone) {
      setClauses.push("otp_hash = NULL", "otp_expires_at = NULL", "otp_attempts = 0");
    }

    const { rows } = await client.query(
      `UPDATE ${cfg.table} SET ${setClauses.join(", ")} WHERE id = $1 RETURNING *`,
      values
    );
    const updated = rows[0];

    await writeAudit(client, {
      actorType: "employee", actorId: req.actor.id, actorName: req.actor.name,
      action: `${req.params.kind}.updated`, entityType: req.params.kind, entityId: req.params.id,
      entityLabel: updated.business_name, before: stripSecrets(before.rows[0]), after: stripSecrets(updated), ip: req.ip,
    });

    return { ...stripSecrets(updated), sections: await fetchSections(client, cfg, req.params.id) };
  });

  invalidateAuthCache(req.params.kind, req.params.id);
  res.json(result);
}));

accountsRouter.delete("/:kind/:id", requirePermission("accounts.approve"), asyncRoute(async (req, res) => {
  const cfg = assertKind(req.params.kind);

  const result = await withTransaction(async (client) => {
    const before = await client.query(`SELECT * FROM ${cfg.table} WHERE id = $1 FOR UPDATE`, [req.params.id]);
    if (!before.rows.length) throw new ApiError(404, "الحساب غير موجود");

    const beforeSections = await fetchSections(client, cfg, req.params.id);
    const scope = await getEmployeeSectionScope(req.actor.id);
    if (!withinScope({ ...before.rows[0], sections: beforeSections }, scope)) {
      throw new ApiError(403, "لا تملك صلاحية على هذا الحساب");
    }

    const { rows } = await client.query(
            `UPDATE ${cfg.table} SET status = 'suspended' WHERE id = $1 RETURNING id, business_name, status`,
      [req.params.id]
    );

    await writeAudit(client, {
      actorType: "employee", actorId: req.actor.id, actorName: req.actor.name,
      action: `${req.params.kind}.deleted`, entityType: req.params.kind, entityId: req.params.id,
      entityLabel: before.rows[0].business_name, before: stripSecrets(before.rows[0]), after: rows[0], ip: req.ip,
    });
    return rows[0];
  });

  invalidateAuthCache(req.params.kind, req.params.id);
  res.json(result);
}));

accountsRouter.get("/:kind/:id", requirePermission("accounts.approve"), asyncRoute(async (req, res) => {
  const cfg = assertKind(req.params.kind);
  const { rows } = await query(`SELECT * FROM ${cfg.table} WHERE id = $1`, [req.params.id]);
  if (!rows.length) throw new ApiError(404, "الحساب غير موجود");
  const sections = await fetchSections(pool, cfg, req.params.id);

  const scope = await getEmployeeSectionScope(req.actor.id);
  if (!withinScope({ ...rows[0], sections }, scope)) {
    throw new ApiError(403, "لا تملك صلاحية الاطلاع على هذا الحساب");
  }

  res.json({ ...stripSecrets(rows[0]), sections });
}));

const createSchema = z.object({
  businessName: z.string().trim().min(2).max(200),
  phone: z.string().min(9).max(20),
  address: z.string().max(500).optional(),
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
  sectionIds: z.array(z.string().uuid()).default([]),
  ownerName: z.string().max(200).optional(),
  contactPerson: z.string().max(200).optional(),
  paymentTerms: z.string().max(500).optional(),
  commissionRate: z.number().min(0).max(100).optional(),
});

accountsRouter.post("/:kind", requirePermission("accounts.approve"), asyncRoute(async (req, res) => {
  const cfg = assertKind(req.params.kind);
  const body = createSchema.parse(req.body);
  const phone = normalizePhone(body.phone);

  if (req.params.kind === "supplier" && body.commissionRate === undefined) {
    throw new ApiError(400, "نسبة العمولة مطلوبة عند إضافة مورد");
  }
  // تحديد نسبة العمولة صلاحية مستقلة (نفس قاعدة مسار تعديل العمولة)
  if (req.params.kind === "supplier" && !(await employeeHasPermission(req.actor.id, "finance.commission"))) {
    throw new ApiError(403, "تحديد نسبة عمولة المورد يحتاج صلاحية تعديل العمولة");
  }

  // موظف مقيّد بأقسام يقدر بس ينشئ حساب ويمنحه أقسامًا داخل نطاقه هو
  await assertSectionScope(req.actor.id, body.sectionIds);

  const account = await withTransaction(async (client) => {
    const dup = await client.query(`SELECT id FROM ${cfg.table} WHERE phone = $1`, [phone]);
    if (dup.rows.length) throw new ApiError(409, "رقم الهاتف مسجّل مسبقًا");

    const columns = req.params.kind === "customer"
      ? { extra: "owner_name", value: body.ownerName ?? null }
      : { extra: "contact_person", value: body.contactPerson ?? null };

    const { rows } = await client.query(
      `INSERT INTO ${cfg.table}
         (business_name, phone, address, latitude, longitude, status,
          joined_via, approved_by, approved_at, ${columns.extra}
          ${req.params.kind === "supplier" ? ", payment_terms, commission_rate_percent" : ""})
       VALUES ($1,$2,$3,$4,$5,'approved','admin',$6,now(),$7
               ${req.params.kind === "supplier" ? ",$8,$9" : ""})
       RETURNING *`,
      req.params.kind === "supplier"
        ? [body.businessName, phone, body.address ?? null, body.latitude ?? null, body.longitude ?? null,
           req.actor.id, columns.value, body.paymentTerms ?? null, body.commissionRate]
        : [body.businessName, phone, body.address ?? null, body.latitude ?? null, body.longitude ?? null,
           req.actor.id, columns.value]
    );
    const created = rows[0];

    for (const sectionId of body.sectionIds) {
      await client.query(
        `INSERT INTO ${cfg.sectionTable} (${cfg.idCol}, section_id, enabled, assigned_by)
         VALUES ($1,$2,TRUE,$3)`,
        [created.id, sectionId, req.actor.id]
      );
    }

    await writeAudit(client, {
      actorType: "employee", actorId: req.actor.id, actorName: req.actor.name,
      action: `${req.params.kind}.created`, entityType: req.params.kind, entityId: created.id,
      entityLabel: body.businessName, after: stripSecrets(created), ip: req.ip,
    });
    const loginCode = await setInitialLoginCode(client, cfg.table, created.id);
    return { ...stripSecrets(created), sections: await fetchSections(client, cfg, created.id), loginCode };
  });

  res.status(201).json(account);
}));

accountsRouter.post("/:kind/:id/approve", requirePermission("accounts.approve"), asyncRoute(async (req, res) => {
  const cfg = assertKind(req.params.kind);
  const { sectionIds, commissionRate } = z.object({
    sectionIds: z.array(z.string().uuid()).default([]),
    commissionRate: z.number().min(0).max(100).optional(),
  }).parse(req.body ?? {});

  // موظف مقيّد بأقسام يقدر بس يعتمد الحساب ضمن أقسام نطاقه — لازم يحدد قسم وحد
  // على الأقل من نطاقه، وما يقدرش يمنح أي قسم خارج نطاقه
  await assertSectionScope(req.actor.id, sectionIds);

  // تحديد نسبة العمولة مربوط بصلاحية العمولة (نفس مسار تعديل العمولة)
  const canSetCommission = req.params.kind === "supplier"
    ? await employeeHasPermission(req.actor.id, "finance.commission")
    : false;

  const result = await withTransaction(async (client) => {
    const before = await client.query(`SELECT * FROM ${cfg.table} WHERE id = $1 FOR UPDATE`, [req.params.id]);
    if (!before.rows.length) throw new ApiError(404, "الحساب غير موجود");
    const prev = before.rows[0];
    if (!["pending", "suspended"].includes(prev.status)) throw new ApiError(400, "الحساب ليس بانتظار الاعتماد أو متوقفًا");

    // نفس فحص نطاق الأقسام المستخدم بباقي المسارات (الحسابات بانتظار الاعتماد مسموحة دائمًا)
    const scope = await getEmployeeSectionScope(req.actor.id);
    if (!withinScope({ ...prev, sections: await fetchSections(client, cfg, req.params.id) }, scope)) {
      throw new ApiError(403, "لا تملك صلاحية على هذا الحساب");
    }

    // المورد: النسبة يحددها المعتمِد صراحةً. الحساب الجديد (بانتظار الاعتماد) لازم نسبة جديدة،
    // أما إعادة تفعيل مورد موقوف فتبقى نسبته الحالية إن وُجدت.
    let setRate = null;
    if (req.params.kind === "supplier") {
      const needRate = prev.status === "pending" || prev.commission_rate_percent == null;
      if (needRate && commissionRate === undefined) {
        throw new ApiError(400, "يلزم تحديد نسبة عمولة المورد عند الاعتماد", "COMMISSION_REQUIRED");
      }
      if (commissionRate !== undefined) {
        if (!canSetCommission) {
          throw new ApiError(403, "تحديد نسبة عمولة المورد يحتاج صلاحية تعديل العمولة");
        }
        setRate = commissionRate;
      }
    }

    const { rows } = req.params.kind === "supplier"
      ? await client.query(
          `UPDATE suppliers SET status = 'approved', approved_by = $2, approved_at = now(),
                  commission_rate_percent = COALESCE($3, commission_rate_percent)
            WHERE id = $1 RETURNING *`,
          [req.params.id, req.actor.id, setRate]
        )
      : await client.query(
          `UPDATE ${cfg.table} SET status = 'approved', approved_by = $2, approved_at = now()
            WHERE id = $1 RETURNING *`,
          [req.params.id, req.actor.id]
        );

    for (const sectionId of sectionIds) {
      await client.query(
        `INSERT INTO ${cfg.sectionTable} (${cfg.idCol}, section_id, enabled, assigned_by)
         VALUES ($1,$2,TRUE,$3)
         ON CONFLICT (${cfg.idCol}, section_id) DO UPDATE SET enabled = TRUE, assigned_by = $3, assigned_at = now()`,
        [req.params.id, sectionId, req.actor.id]
      );
    }

    await writeAudit(client, {
      actorType: "employee", actorId: req.actor.id, actorName: req.actor.name,
      action: `${req.params.kind}.approved`, entityType: req.params.kind, entityId: req.params.id,
      entityLabel: rows[0].business_name, before: stripSecrets(prev), after: stripSecrets(rows[0]), ip: req.ip,
    });

    if (req.params.kind === "customer") {
      await queueNotification(client, {
        templateCode: "account.approved", recipientType: "customer", recipientId: req.params.id,
      });
    } else {
      await queueNotification(client, {
        templateCode: "supplier.decision", recipientType: "supplier", recipientId: req.params.id,
        vars: { decision: "اعتماد" },
      });
    }

    // أول اعتماد (الحساب بدون كلمة مرور): نصدر رمز دخول مؤقت تعطيه الإدارة لصاحب الحساب بدل SMS
    const pw = await client.query(`SELECT password_set_at FROM ${cfg.table} WHERE id = $1`, [req.params.id]);
    const loginCode = pw.rows[0]?.password_set_at ? null : await setInitialLoginCode(client, cfg.table, req.params.id);
    return { ...stripSecrets(rows[0]), sections: await fetchSections(client, cfg, req.params.id), loginCode };
  });

  invalidateAuthCache(req.params.kind, req.params.id);
  res.json(result);
}));

// الرفض مخصّص للحسابات "بانتظار الاعتماد" فقط. الحساب المعتمد ما ينقلبش لـ"مرفوض" —
// لإيقافه استخدم مسار الإيقاف (DELETE /accounts/:kind/:id).
accountsRouter.post("/:kind/:id/reject", requirePermission("accounts.approve"), asyncRoute(async (req, res) => {
  const cfg = assertKind(req.params.kind);
  const result = await withTransaction(async (client) => {
    const before = await client.query(`SELECT * FROM ${cfg.table} WHERE id = $1 FOR UPDATE`, [req.params.id]);
    if (!before.rows.length) throw new ApiError(404, "الحساب غير موجود");

    const scope = await getEmployeeSectionScope(req.actor.id);
    if (!withinScope({ ...before.rows[0], sections: await fetchSections(client, cfg, req.params.id) }, scope)) {
      throw new ApiError(403, "لا تملك صلاحية على هذا الحساب");
    }
    if (before.rows[0].status !== "pending") {
      throw new ApiError(409, "الرفض متاح للحسابات بانتظار الاعتماد فقط — لإيقاف حساب معتمد استخدم «إيقاف الحساب»");
    }

    const { rows } = await client.query(
      `UPDATE ${cfg.table} SET status = 'rejected' WHERE id = $1 RETURNING *`, [req.params.id]
    );
    await writeAudit(client, {
      actorType: "employee", actorId: req.actor.id, actorName: req.actor.name,
      action: `${req.params.kind}.rejected`, entityType: req.params.kind, entityId: req.params.id,
      entityLabel: before.rows[0].business_name, before: stripSecrets(before.rows[0]), after: stripSecrets(rows[0]), ip: req.ip,
    });

    if (req.params.kind === "supplier") {
      await queueNotification(client, {
        templateCode: "supplier.decision", recipientType: "supplier", recipientId: req.params.id,
        vars: { decision: "رفض" },
      });
    }
    return stripSecrets(rows[0]);
  });
  invalidateAuthCache(req.params.kind, req.params.id);
  res.json(result);
}));

accountsRouter.patch("/:kind/:id/sections", requirePermission("accounts.sections"), asyncRoute(async (req, res) => {
  const cfg = assertKind(req.params.kind);
  const { sectionIds } = z.object({ sectionIds: z.array(z.string().uuid()) }).parse(req.body);

  // موظف مقيّد بأقسام ما يقدرش يمنح الحساب أي قسم خارج نطاقه
  await assertSectionScope(req.actor.id, sectionIds);

  const sections = await withTransaction(async (client) => {
    const exists = await client.query(`SELECT id FROM ${cfg.table} WHERE id = $1`, [req.params.id]);
    if (!exists.rows.length) throw new ApiError(404, "الحساب غير موجود");

    const scope = await getEmployeeSectionScope(req.actor.id);
    if (scope === null) {
      await client.query(`UPDATE ${cfg.sectionTable} SET enabled = FALSE WHERE ${cfg.idCol} = $1`, [req.params.id]);
    } else {
      await client.query(`UPDATE ${cfg.sectionTable} SET enabled = FALSE WHERE ${cfg.idCol} = $1 AND section_id = ANY($2::UUID[])`, [req.params.id, [...scope]]);
    }

    for (const sectionId of sectionIds) {
      await client.query(
        `INSERT INTO ${cfg.sectionTable} (${cfg.idCol}, section_id, enabled, assigned_by)
         VALUES ($1,$2,TRUE,$3)
         ON CONFLICT (${cfg.idCol}, section_id) DO UPDATE SET enabled = TRUE, assigned_by = $3, assigned_at = now()`,
        [req.params.id, sectionId, req.actor.id]
      );
    }

    await writeAudit(client, {
      actorType: "employee", actorId: req.actor.id, actorName: req.actor.name,
      action: `${req.params.kind}.sections_updated`, entityType: req.params.kind, entityId: req.params.id,
      after: { sectionIds }, ip: req.ip,
    });

    return fetchSections(client, cfg, req.params.id);
  });

  res.json({ sections });
}));

accountsRouter.patch("/customer/:id/credit", requirePermission("accounts.approve"), asyncRoute(async (req, res) => {
  const body = z.object({
    creditEnabled: z.boolean(),
    creditLimit: z.number().nonnegative().default(0),
    creditDays: z.number().int().positive().max(90).default(28),
  }).parse(req.body);

  const result = await withTransaction(async (client) => {
    const before = await client.query(`SELECT * FROM customers WHERE id = $1 FOR UPDATE`, [req.params.id]);
    if (!before.rows.length) throw new ApiError(404, "العميل غير موجود");

    const scope = await getEmployeeSectionScope(req.actor.id);
    if (!withinScope({ ...before.rows[0], sections: await fetchSections(client, ENTITY.customer, req.params.id) }, scope)) {
      throw new ApiError(403, "لا تملك صلاحية على هذا الحساب");
    }

    const { rows } = await client.query(
      `UPDATE customers SET credit_enabled = $2, credit_limit = $3, credit_days = $4
       WHERE id = $1 RETURNING *`,
      [req.params.id, body.creditEnabled, body.creditLimit, body.creditDays]
    );
    await writeAudit(client, {
      actorType: "employee", actorId: req.actor.id, actorName: req.actor.name,
      action: "customer.credit_updated", entityType: "customer", entityId: req.params.id,
      entityLabel: before.rows[0].business_name, before: stripSecrets(before.rows[0]), after: stripSecrets(rows[0]), ip: req.ip,
    });
    return stripSecrets(rows[0]);
  });

  res.json(result);
}));

accountsRouter.patch("/supplier/:id/commission-rate", requirePermission("finance.commission"), asyncRoute(async (req, res) => {
  const { commissionRate } = z.object({
    commissionRate: z.number().min(0).max(100),
  }).parse(req.body);

  const result = await withTransaction(async (client) => {
    const before = await client.query(`SELECT * FROM suppliers WHERE id = $1 FOR UPDATE`, [req.params.id]);
    if (!before.rows.length) throw new ApiError(404, "المورد غير موجود");

    const scope = await getEmployeeSectionScope(req.actor.id);
    if (!withinScope({ ...before.rows[0], sections: await fetchSections(client, ENTITY.supplier, req.params.id) }, scope)) {
      throw new ApiError(403, "لا تملك صلاحية على هذا الحساب");
    }

    const { rows } = await client.query(
      `UPDATE suppliers SET commission_rate_percent = $2 WHERE id = $1 RETURNING *`,
      [req.params.id, commissionRate]
    );

    await writeAudit(client, {
      actorType: "employee", actorId: req.actor.id, actorName: req.actor.name,
      action: "supplier.commission_rate_updated", entityType: "supplier", entityId: req.params.id,
      entityLabel: before.rows[0].business_name, before: stripSecrets(before.rows[0]), after: stripSecrets(rows[0]), ip: req.ip,
    });
    return stripSecrets(rows[0]);
  });

  res.json(result);
}));
