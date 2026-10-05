import { Router } from "express";
import { z } from "zod";
import { query, withTransaction, writeAudit } from "../lib/db.js";
import { ApiError, asyncRoute } from "../lib/helpers.js";
import { authenticate, requirePermission } from "../middleware/auth.js";
import { ensureBannerSections } from "../lib/bootstrap.js";

export const bannerRouter = Router();
bannerRouter.use(authenticate);

// شرط التوجيه بالأقسام: البانر بلا أي ربط = عام (يظهر للجميع)، أو مربوط بقسم (أو تصنيف فرعي
// يُحتسب على قسمه الرئيسي) مفعّل للحساب في جدول أقسامه (sectionTable: customer_sections / supplier_sections)
const targetingSql = (sectionTable, idCol) => `
  AND (
    NOT EXISTS (SELECT 1 FROM banner_sections bs WHERE bs.banner_id = b.id)
    OR EXISTS (
      SELECT 1 FROM banner_sections bs
        JOIN sections s ON s.id = bs.section_id
        JOIN ${sectionTable} st ON st.section_id = COALESCE(s.parent_id, s.id)
       WHERE bs.banner_id = b.id AND st.${idCol} = $1 AND st.enabled
    )
  )`;

// عرض عام: أي مستخدم مسجّل دخول يشوف بس البانرات النشطة وضمن فترة عرضها الحالية، مرتّبة.
// العميل والمورد: فقط العامة أو المربوطة بأقسامهم المفعّلة. الموظف/غيره: كل البانرات النشطة.
bannerRouter.get("/", asyncRoute(async (req, res) => {
  // شاشة العميل الرئيسية لا تعتمد على نجاح إنشاء الجدول (لو فشل والجدول موجود يكمل الاستعلام عادي)
  await ensureBannerSections().catch((e) => console.error("[banners] ensure:", e?.message));
  const type = req.actor?.type;
  let filter = "";
  const params = [];
  if (type === "customer") { filter = targetingSql("customer_sections", "customer_id"); params.push(req.actor.id); }
  else if (type === "supplier") { filter = targetingSql("supplier_sections", "supplier_id"); params.push(req.actor.id); }

  const { rows } = await query(
    `SELECT b.id, b.image_url, b.title, b.subtitle, b.link_url,
            (SELECT bs.section_id FROM banner_sections bs JOIN sections s ON s.id = bs.section_id
              WHERE bs.banner_id = b.id ORDER BY s.sort_order, s.name LIMIT 1) AS section_id
       FROM promo_banners b
      WHERE b.is_active
        AND (b.starts_at IS NULL OR b.starts_at <= now())
        AND (b.ends_at IS NULL OR b.ends_at >= now())
        ${filter}
      ORDER BY b.sort_order, b.created_at`,
    params
  );
  res.json(rows);
}));

// يرجّع صفوف البانرات مع section_ids و section_names (مرتّبة بنفس ترتيب الأقسام)
async function fetchBannersWithSections(db, onlyId = null) {
  const { rows } = await db.query(
    `SELECT b.*,
            COALESCE(array_agg(bs.section_id::text ORDER BY s.sort_order, s.name) FILTER (WHERE bs.section_id IS NOT NULL), ARRAY[]::text[]) AS section_ids,
            COALESCE(array_agg(s.name ORDER BY s.sort_order, s.name) FILTER (WHERE bs.section_id IS NOT NULL), ARRAY[]::text[]) AS section_names
       FROM promo_banners b
       LEFT JOIN banner_sections bs ON bs.banner_id = b.id
       LEFT JOIN sections s ON s.id = bs.section_id
      ${onlyId ? "WHERE b.id = $1" : ""}
      GROUP BY b.id
      ORDER BY b.sort_order, b.created_at`,
    onlyId ? [onlyId] : []
  );
  return rows;
}

// عرض كامل لكل البانرات (نشطة وغير نشطة) — لشاشة الإدارة، مع الأقسام المستهدفة
bannerRouter.get("/admin", requirePermission("catalog.manage"), asyncRoute(async (_req, res) => {
  await ensureBannerSections();
  res.json(await fetchBannersWithSections({ query }));
}));

// يستبدل روابط أقسام البانر (مصفوفة فاضية = بانر عام)
async function replaceBannerSections(client, bannerId, sectionIds) {
  const ids = [...new Set(sectionIds.map((x) => x.toLowerCase()))];
  if (ids.length) {
    const { rows } = await client.query(`SELECT id FROM sections WHERE id = ANY($1::uuid[])`, [ids]);
    if (rows.length !== ids.length) throw new ApiError(400, "قسم واحد أو أكثر غير موجود");
  }
  await client.query(`DELETE FROM banner_sections WHERE banner_id = $1`, [bannerId]);
  for (const sid of ids) {
    await client.query(`INSERT INTO banner_sections (banner_id, section_id) VALUES ($1, $2)`, [bannerId, sid]);
  }
}

// روابط http/https فقط (z.string().url() لوحده يقبل javascript: و data: وغيرها)
const httpUrl = z.string().max(2000).url().refine((u) => {
  try { return ["http:", "https:"].includes(new URL(u).protocol); } catch { return false; }
}, "الرابط لازم يبدأ بـ http:// أو https://");

const bannerSchema = z.object({
  imageUrl: httpUrl,
  title: z.string().max(200).optional(),
  subtitle: z.string().max(500).optional(),
  linkUrl: httpUrl.optional(),
  sortOrder: z.number().int().default(0),
  startsAt: z.string().max(40).optional(),
  endsAt: z.string().max(40).optional(),
  sectionIds: z.array(z.string().uuid()).max(100).optional(),
});

bannerRouter.post("/", requirePermission("catalog.manage"), asyncRoute(async (req, res) => {
  const body = bannerSchema.parse(req.body);
  await ensureBannerSections();

  const created = await withTransaction(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO promo_banners
         (image_url, title, subtitle, link_url, sort_order, starts_at, ends_at, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [body.imageUrl, body.title ?? null, body.subtitle ?? null, body.linkUrl ?? null,
       body.sortOrder, body.startsAt ?? null, body.endsAt ?? null, req.actor.id]
    );
    const bannerRow = rows[0];
    await replaceBannerSections(client, bannerRow.id, body.sectionIds ?? []);
    const [banner] = await fetchBannersWithSections(client, bannerRow.id);
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
  await ensureBannerSections();

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

    const [beforeFull] = await fetchBannersWithSections(client, req.params.id);
    if (setClauses.length) {
      await client.query(`UPDATE promo_banners SET ${setClauses.join(", ")} WHERE id = $1`, values);
    }
    if (body.sectionIds !== undefined) await replaceBannerSections(client, req.params.id, body.sectionIds);
    const [after] = await fetchBannersWithSections(client, req.params.id);
    await writeAudit(client, {
      actorType: "employee", actorId: req.actor.id, actorName: req.actor.name,
      action: "banner.updated", entityType: "promo_banner", entityId: req.params.id,
      entityLabel: after.title || req.params.id, before: beforeFull, after, ip: req.ip,
    });
    return after;
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
