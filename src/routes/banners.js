import { Router } from "express";
import { z } from "zod";
import { query, withTransaction, writeAudit } from "../lib/db.js";
import { ApiError, asyncRoute } from "../lib/helpers.js";
import { authenticate, requirePermission } from "../middleware/auth.js";

export const bannerRouter = Router();
bannerRouter.use(authenticate);

// عرض عام: أي مستخدم مسجّل دخول (العميل بالأساس) يشوف بس البانرات النشطة
// وضمن فترة عرضها الحالية، مرتّبة — تُستخدم من الشاشة الرئيسية بتطبيق العميل
bannerRouter.get("/", asyncRoute(async (_req, res) => {
  const { rows } = await query(
    `SELECT id, image_url, title, subtitle, link_url
       FROM promo_banners
      WHERE is_active
        AND (starts_at IS NULL OR starts_at <= now())
        AND (ends_at IS NULL OR ends_at >= now())
      ORDER BY sort_order, created_at`
  );
  res.json(rows);
}));

// عرض كامل لكل البانرات (نشطة وغير نشطة) — لشاشة الإدارة
bannerRouter.get("/admin", requirePermission("catalog.manage"), asyncRoute(async (_req, res) => {
  const { rows } = await query(`SELECT * FROM promo_banners ORDER BY sort_order, created_at`);
  res.json(rows);
}));

const bannerSchema = z.object({
  imageUrl: z.string().url(),
  title: z.string().optional(),
  subtitle: z.string().optional(),
  linkUrl: z.string().url().optional(),
  sortOrder: z.number().int().default(0),
  startsAt: z.string().optional(),
  endsAt: z.string().optional(),
});

bannerRouter.post("/", requirePermission("catalog.manage"), asyncRoute(async (req, res) => {
  const body = bannerSchema.parse(req.body);

  const created = await withTransaction(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO promo_banners
         (image_url, title, subtitle, link_url, sort_order, starts_at, ends_at, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [body.imageUrl, body.title ?? null, body.subtitle ?? null, body.linkUrl ?? null,
       body.sortOrder, body.startsAt ?? null, body.endsAt ?? null, req.actor.id]
    );
    const banner = rows[0];
    await writeAudit(client, {
      actorType: "employee", actorId: req.actor.id, actorName: req.actor.name,
      action: "banner.created", entityType: "promo_banner", entityId: banner.id,
      entityLabel: body.title || "بانر جديد", after: banner, ip: req.ip,
    });
    return banner;
  });

  res.status(201).json(created);
}));

const updateSchema = bannerSchema.partial().extend({ isActive: z.boolean().optional() });

bannerRouter.patch("/:id", requirePermission("catalog.manage"), asyncRoute(async (req, res) => {
  const body = updateSchema.parse(req.body);
  if (Object.keys(body).length === 0) throw new ApiError(400, "لا توجد بيانات للتعديل");

  const fieldMap = {
    imageUrl: "image_url", title: "title", subtitle: "subtitle", linkUrl: "link_url",
    sortOrder: "sort_order", startsAt: "starts_at", endsAt: "ends_at", isActive: "is_active",
  };

  const result = await withTransaction(async (client) => {
    const before = await client.query(`SELECT * FROM promo_banners WHERE id = $1 FOR UPDATE`, [req.params.id]);
    if (!before.rows.length) throw new ApiError(404, "البانر غير موجود");

    const setClauses = [];
    const values = [req.params.id];
    let i = 2;
    for (const [key, col] of Object.entries(fieldMap)) {
      if (body[key] !== undefined) { setClauses.push(`${col} = $${i}`); values.push(body[key]); i++; }
    }

    const { rows } = await client.query(
      `UPDATE promo_banners SET ${setClauses.join(", ")} WHERE id = $1 RETURNING *`, values
    );
    await writeAudit(client, {
      actorType: "employee", actorId: req.actor.id, actorName: req.actor.name,
      action: "banner.updated", entityType: "promo_banner", entityId: req.params.id,
      entityLabel: rows[0].title || req.params.id, before: before.rows[0], after: rows[0], ip: req.ip,
    });
    return rows[0];
  });

  res.json(result);
}));

bannerRouter.delete("/:id", requirePermission("catalog.manage"), asyncRoute(async (req, res) => {
  const result = await withTransaction(async (client) => {
    const before = await client.query(`SELECT * FROM promo_banners WHERE id = $1 FOR UPDATE`, [req.params.id]);
    if (!before.rows.length) throw new ApiError(404, "البانر غير موجود");

    await client.query(`DELETE FROM promo_banners WHERE id = $1`, [req.params.id]);
    await writeAudit(client, {
      actorType: "employee", actorId: req.actor.id, actorName: req.actor.name,
      action: "banner.deleted", entityType: "promo_banner", entityId: req.params.id,
      entityLabel: before.rows[0].title || req.params.id, before: before.rows[0], ip: req.ip,
    });
    return { deleted: true };
  });

  res.json(result);
}));
