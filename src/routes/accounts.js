import { Router } from "express";
import { z } from "zod";
import { pool, query, withTransaction, writeAudit } from "../lib/db.js";
import { ApiError, asyncRoute, normalizePhone } from "../lib/helpers.js";
import { authenticate, requirePermission } from "../middleware/auth.js";
import { queueNotification } from "../lib/notify.js";

export const accountsRouter = Router();

const registerSchema = z.object({
  businessName: z.string().min(2),
  phone: z.string().min(9),
  address: z.string().optional(),
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
  ownerName: z.string().optional(),
  contactPerson: z.string().optional(),
  businessTypes: z.array(z.string()).optional(),
  // نسبة عمولة جملة على مبيعات المورد — إجبارية للمورد فقط، يتم التحقق منها داخل المعالج
  commissionRate: z.number().min(0).max(100).optional(),
});

accountsRouter.post("/:kind/register", asyncRoute(async (req, res) => {
  const cfg = assertKind(req.params.kind);
  const body = registerSchema.parse(req.body);
  const phone = normalizePhone(body.phone);

  if (req.params.kind === "supplier" && body.commissionRate === undefined) {
    throw new ApiError(400, "نسبة العمولة المتفق عليها مطلوبة لتسجيل حساب مورد");
  }

  const created = await withTransaction(async (client) => {
    const dup = await client.query(`SELECT id FROM ${cfg.table} WHERE phone = $1`, [phone]);
    if (dup.rows.length) throw new ApiError(409, "رقم الهاتف مسجّل مسبقًا");

    const columns = req.params.kind === "customer"
      ? { extra: "owner_name", value: body.ownerName ?? null }
      : { extra: "contact_person", value: body.contactPerson ?? null };

    const extraCols = req.params.kind === "supplier" ? ", commission_rate_percent" : "";
    const extraPlaceholder = req.params.kind === "supplier" ? ", $8" : "";
    const values = [body.businessName, phone,
      body.address ?? null, body.latitude ?? null, body.longitude ?? null,
      body.businessTypes ?? null, columns.value];
    if (req.params.kind === "supplier") values.push(body.commissionRate);

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
      entityLabel: body.businessName, after: row, ip: req.ip,
    });
    return row;
  });

  res.status(201).json(created);
}));

accountsRouter.use(authenticate);


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

accountsRouter.get("/:kind", requirePermission("accounts.approve"), asyncRoute(async (req, res) => {
  const cfg = assertKind(req.params.kind);
  const { status, search, includeDeleted } = req.query;

  const nameCol = req.params.kind === "customer" ? "business_name" : "business_name";
  const { rows } = await query(
    `SELECT * FROM ${cfg.table}
      WHERE ($1::TEXT IS NULL OR status = $1)
        AND ($3::BOOLEAN = TRUE OR status != 'deleted' OR $1 = 'deleted')
        AND ($2::TEXT IS NULL OR ${nameCol} ILIKE '%'||$2||'%' OR phone ILIKE '%'||$2||'%')
      ORDER BY created_at DESC`,
    [status || null, search || null, includeDeleted === "true"]
  );

const withSections = await Promise.all(
    rows.map(async (r) => ({ ...r, sections: await fetchSections(pool, cfg, r.id).catch(() => []) }))
  );
  res.json(withSections);
}));

const updateSchema = z.object({
  businessName: z.string().min(2).optional(),
  phone: z.string().min(9).optional(),
  address: z.string().optional(),
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
  businessTypes: z.array(z.string()).optional(),
  ownerName: z.string().optional(),
  contactPerson: z.string().optional(),
  paymentTerms: z.string().optional(),
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

    const { rows } = await client.query(
      `UPDATE ${cfg.table} SET ${setClauses.join(", ")} WHERE id = $1 RETURNING *`,
      values
    );
    const updated = rows[0];

    await writeAudit(client, {
      actorType: "employee", actorId: req.actor.id, actorName: req.actor.name,
      action: `${req.params.kind}.updated`, entityType: req.params.kind, entityId: req.params.id,
      entityLabel: updated.business_name, before: before.rows[0], after: updated, ip: req.ip,
    });

    return { ...updated, sections: await fetchSections(client, cfg, req.params.id) };
  });

  res.json(result);
}));

accountsRouter.delete("/:kind/:id", requirePermission("accounts.approve"), asyncRoute(async (req, res) => {
  const cfg = assertKind(req.params.kind);

  const result = await withTransaction(async (client) => {
    const before = await client.query(`SELECT * FROM ${cfg.table} WHERE id = $1 FOR UPDATE`, [req.params.id]);
    if (!before.rows.length) throw new ApiError(404, "الحساب غير موجود");

    const { rows } = await client.query(
            `UPDATE ${cfg.table} SET status = 'suspended' WHERE id = $1 RETURNING id, business_name, status`,
      [req.params.id]
    );

    await writeAudit(client, {
      actorType: "employee", actorId: req.actor.id, actorName: req.actor.name,
      action: `${req.params.kind}.deleted`, entityType: req.params.kind, entityId: req.params.id,
      entityLabel: before.rows[0].business_name, before: before.rows[0], after: rows[0], ip: req.ip,
    });
    return rows[0];
  });

  res.json(result);
}));

accountsRouter.get("/:kind/:id", requirePermission("accounts.approve"), asyncRoute(async (req, res) => {
  const cfg = assertKind(req.params.kind);
  const { rows } = await query(`SELECT * FROM ${cfg.table} WHERE id = $1`, [req.params.id]);
  if (!rows.length) throw new ApiError(404, "الحساب غير موجود");
  const sections = await fetchSections(pool, cfg, req.params.id);
  res.json({ ...rows[0], sections });
}));

const createSchema = z.object({
  businessName: z.string().min(2),
  phone: z.string().min(9),
  address: z.string().optional(),
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
  sectionIds: z.array(z.string().uuid()).default([]),
  ownerName: z.string().optional(),
  contactPerson: z.string().optional(),
  paymentTerms: z.string().optional(),
  commissionRate: z.number().min(0).max(100).optional(),
});

accountsRouter.post("/:kind", requirePermission("accounts.approve"), asyncRoute(async (req, res) => {
  const cfg = assertKind(req.params.kind);
  const body = createSchema.parse(req.body);
  const phone = normalizePhone(body.phone);

  if (req.params.kind === "supplier" && body.commissionRate === undefined) {
    throw new ApiError(400, "نسبة العمولة مطلوبة عند إضافة مورد");
  }

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
      entityLabel: body.businessName, after: created, ip: req.ip,
    });
    return { ...created, sections: await fetchSections(client, cfg, created.id) };
  });

  res.status(201).json(account);
}));

accountsRouter.post("/:kind/:id/approve", requirePermission("accounts.approve"), asyncRoute(async (req, res) => {
  const cfg = assertKind(req.params.kind);
  const { sectionIds } = z.object({ sectionIds: z.array(z.string().uuid()).default([]) }).parse(req.body ?? {});

  const result = await withTransaction(async (client) => {
    const before = await client.query(`SELECT * FROM ${cfg.table} WHERE id = $1 FOR UPDATE`, [req.params.id]);
    if (!before.rows.length) throw new ApiError(404, "الحساب غير موجود");
        if (!["pending", "suspended"].includes(before.rows[0].status)) throw new ApiError(400, "الحساب ليس بانتظار الاعتماد أو متوقفًا");

    const { rows } = await client.query(
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
      entityLabel: rows[0].business_name, before: before.rows[0], after: rows[0], ip: req.ip,
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

    return { ...rows[0], sections: await fetchSections(client, cfg, req.params.id) };
  });

  res.json(result);
}));

accountsRouter.post("/:kind/:id/reject", requirePermission("accounts.approve"), asyncRoute(async (req, res) => {
  const cfg = assertKind(req.params.kind);
  const result = await withTransaction(async (client) => {
    const before = await client.query(`SELECT * FROM ${cfg.table} WHERE id = $1 FOR UPDATE`, [req.params.id]);
    if (!before.rows.length) throw new ApiError(404, "الحساب غير موجود");

    const { rows } = await client.query(
      `UPDATE ${cfg.table} SET status = 'rejected' WHERE id = $1 RETURNING *`, [req.params.id]
    );
    await writeAudit(client, {
      actorType: "employee", actorId: req.actor.id, actorName: req.actor.name,
      action: `${req.params.kind}.rejected`, entityType: req.params.kind, entityId: req.params.id,
      entityLabel: before.rows[0].business_name, before: before.rows[0], after: rows[0], ip: req.ip,
    });

    if (req.params.kind === "supplier") {
      await queueNotification(client, {
        templateCode: "supplier.decision", recipientType: "supplier", recipientId: req.params.id,
        vars: { decision: "رفض" },
      });
    }
    return rows[0];
  });
  res.json(result);
}));

accountsRouter.patch("/:kind/:id/sections", requirePermission("accounts.sections"), asyncRoute(async (req, res) => {
  const cfg = assertKind(req.params.kind);
  const { sectionIds } = z.object({ sectionIds: z.array(z.string().uuid()) }).parse(req.body);

  const sections = await withTransaction(async (client) => {
    const exists = await client.query(`SELECT id FROM ${cfg.table} WHERE id = $1`, [req.params.id]);
    if (!exists.rows.length) throw new ApiError(404, "الحساب غير موجود");

    await client.query(`UPDATE ${cfg.sectionTable} SET enabled = FALSE WHERE ${cfg.idCol} = $1`, [req.params.id]);

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

    const { rows } = await client.query(
      `UPDATE customers SET credit_enabled = $2, credit_limit = $3, credit_days = $4
       WHERE id = $1 RETURNING *`,
      [req.params.id, body.creditEnabled, body.creditLimit, body.creditDays]
    );
    await writeAudit(client, {
      actorType: "employee", actorId: req.actor.id, actorName: req.actor.name,
      action: "customer.credit_updated", entityType: "customer", entityId: req.params.id,
      entityLabel: before.rows[0].business_name, before: before.rows[0], after: rows[0], ip: req.ip,
    });
    return rows[0];
  });

  res.json(result);
}));

// سجل تدقيق عام لكل العمليات المسجّلة في المنظومة (اعتماد، تعديل، حذف...) — عرض فقط
accountsRouter.get("/audit/logs", requirePermission("accounts.approve"), asyncRoute(async (req, res) => {
  const { entityType, search, limit } = req.query;
  const { rows } = await query(
    `SELECT * FROM audit_log
      WHERE ($1::TEXT IS NULL OR entity_type = $1)
        AND ($2::TEXT IS NULL OR actor_name ILIKE '%'||$2||'%' OR entity_label ILIKE '%'||$2||'%' OR action ILIKE '%'||$2||'%')
      ORDER BY created_at DESC
      LIMIT $3`,
    [entityType || null, search || null, Math.min(Number(limit) || 200, 500)]
  );
  res.json(rows);
}));
accountsRouter.patch("/supplier/:id/commission-rate", requirePermission("finance.commission"), asyncRoute(async (req, res) => {
  const { commissionRate } = z.object({
    commissionRate: z.number().min(0).max(100),
  }).parse(req.body);

  const result = await withTransaction(async (client) => {
    const before = await client.query(`SELECT * FROM suppliers WHERE id = $1 FOR UPDATE`, [req.params.id]);
    if (!before.rows.length) throw new ApiError(404, "المورد غير موجود");

    const { rows } = await client.query(
      `UPDATE suppliers SET commission_rate_percent = $2 WHERE id = $1 RETURNING *`,
      [req.params.id, commissionRate]
    );

    await writeAudit(client, {
      actorType: "employee", actorId: req.actor.id, actorName: req.actor.name,
      action: "supplier.commission_rate_updated", entityType: "supplier", entityId: req.params.id,
      entityLabel: before.rows[0].business_name, before: before.rows[0], after: rows[0], ip: req.ip,
    });
    return rows[0];
  });

  res.json(result);
}));
