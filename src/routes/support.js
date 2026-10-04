import { Router } from "express";
import { z } from "zod";
import { query } from "../lib/db.js";
import { ApiError, asyncRoute } from "../lib/helpers.js";
import { authenticate, requireActorType } from "../middleware/auth.js";

/**
 * الدعم الفني: محادثة واحدة مستمرة بين كل حساب (عميل/مورد/مندوب) والإدارة،
 * مستقلة تمامًا عن دردشة الطلبية. تظهر في لوحة الإدارة مفصولة بحسب النوع.
 */

export const supportRouter = Router();
supportRouter.use(authenticate);

const SUPPORT_TYPES = ["customer", "supplier", "driver"];

// صندوق الدعم للإدارة: موظفو الشركة فقط، والمندوب (دوره driver) ما يقرأ محادثات غيره
const requireStaff = [
  requireActorType("employee"),
  (req, _res, next) => (req.actor.role === "driver"
    ? next(new ApiError(403, "لا تملك صلاحية الوصول لصندوق الدعم الفني"))
    : next()),
];

function pageParams(req, defLimit = 200, maxLimit = 500) {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || defLimit, 1), maxLimit);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
  return { limit, offset };
}

// آخر N رسالة (بترتيب زمني تصاعدي) — الترقيم يبدأ من الأحدث
const MESSAGES_SQL = `
  SELECT * FROM (
    SELECT id, sender_role, body, created_at
      FROM support_messages
     WHERE actor_type = $1 AND actor_id = $2
     ORDER BY created_at DESC
     LIMIT $3 OFFSET $4
  ) m ORDER BY created_at ASC`;

// نوع محادثة الدعم الخاصة بالمستخدم الحالي، أو null لو حسابه غير مؤهل
function resolveOwnActorType(actor) {
  if (actor.type === "customer" || actor.type === "supplier") return actor.type;
  if (actor.type === "employee" && actor.role === "driver") return "driver";
  return null;
}

async function lookupActor(actorType, actorId) {
  if (actorType === "customer") {
    const { rows } = await query(`SELECT business_name AS name, phone FROM customers WHERE id = $1`, [actorId]);
    return rows[0] || null;
  }
  if (actorType === "supplier") {
    const { rows } = await query(`SELECT business_name AS name, phone FROM suppliers WHERE id = $1`, [actorId]);
    return rows[0] || null;
  }
  // محادثات "driver" خاصة بالموظفين ذوي دور المندوب فقط
  const { rows } = await query(
    `SELECT e.name, e.phone FROM employees e JOIN roles r ON r.id = e.role_id WHERE e.id = $1 AND r.code = 'driver'`,
    [actorId]
  );
  return rows[0] || null;
}

const bodySchema = z.object({ body: z.string().trim().min(1).max(2000) });

/* ===================================================================
   محادثتي — للعميل/المورد/المندوب
=================================================================== */

supportRouter.get("/mine", requireActorType("customer", "supplier", "employee"), asyncRoute(async (req, res) => {
  const actorType = resolveOwnActorType(req.actor);
  if (!actorType) throw new ApiError(403, "هذا الحساب لا يملك محادثة دعم فني");

  const pg = pageParams(req);
  const { rows } = await query(MESSAGES_SQL, [actorType, req.actor.id, pg.limit, pg.offset]);

  await query(
    `UPDATE support_messages SET read_by_actor = TRUE
      WHERE actor_type = $1 AND actor_id = $2 AND sender_role = 'admin' AND read_by_actor = FALSE`,
    [actorType, req.actor.id]
  );

  res.json({ messages: rows });
}));

supportRouter.post("/mine", requireActorType("customer", "supplier", "employee"), asyncRoute(async (req, res) => {
  const actorType = resolveOwnActorType(req.actor);
  if (!actorType) throw new ApiError(403, "هذا الحساب لا يملك محادثة دعم فني");

  const { body } = bodySchema.parse(req.body);

  const { rows } = await query(
    `INSERT INTO support_messages (actor_type, actor_id, sender_role, body, read_by_actor, read_by_admin)
     VALUES ($1,$2,'actor',$3, TRUE, FALSE)
     RETURNING id, sender_role, body, created_at`,
    [actorType, req.actor.id, body]
  );

  res.status(201).json(rows[0]);
}));

/* ===================================================================
   صندوق الدعم الفني — لوحة الإدارة (موظفون فقط)
=================================================================== */

// قائمة المحادثات لنوع معيّن (customer / supplier / driver)، مرتّبة بآخر رسالة
supportRouter.get("/threads", ...requireStaff, asyncRoute(async (req, res) => {
  const type = String(req.query.type || "");
  const pg = pageParams(req);
  if (!SUPPORT_TYPES.includes(type)) throw new ApiError(400, "نوع محادثة غير صالح");

  const joinSql =
    type === "driver" ? `JOIN employees a ON a.id = s.actor_id`
    : type === "customer" ? `JOIN customers a ON a.id = s.actor_id`
    : `JOIN suppliers a ON a.id = s.actor_id`;
  const nameCol = type === "driver" ? "a.name" : "a.business_name";

  const { rows } = await query(
    `SELECT s.actor_id, ${nameCol} AS name, a.phone,
            MAX(s.created_at) AS last_at,
            (ARRAY_AGG(s.body ORDER BY s.created_at DESC))[1] AS last_body,
            COUNT(*) FILTER (WHERE s.sender_role = 'actor' AND s.read_by_admin = FALSE) AS unread_count
       FROM support_messages s
       ${joinSql}
      WHERE s.actor_type = $1
      GROUP BY s.actor_id, ${nameCol}, a.phone
      ORDER BY last_at DESC
      LIMIT $2 OFFSET $3`,
    [type, pg.limit, pg.offset]
  );

  res.json(rows);
}));

// عدد الرسائل غير المقروءة لكل نوع — لعرض شارات صغيرة في لوحة الإدارة
supportRouter.get("/unread-counts", ...requireStaff, asyncRoute(async (_req, res) => {
  const { rows } = await query(
    `SELECT actor_type, COUNT(*) AS unread
       FROM support_messages
      WHERE sender_role = 'actor' AND read_by_admin = FALSE
      GROUP BY actor_type`
  );
  const result = { customer: 0, supplier: 0, driver: 0 };
  for (const r of rows) result[r.actor_type] = Number(r.unread);
  res.json(result);
}));

// محادثة كاملة مع حساب بعينه
supportRouter.get("/threads/:actorType/:actorId", ...requireStaff, asyncRoute(async (req, res) => {
  const { actorType, actorId } = req.params;
  if (!SUPPORT_TYPES.includes(actorType)) throw new ApiError(400, "نوع محادثة غير صالح");

  const actorInfo = await lookupActor(actorType, actorId);
  if (!actorInfo) throw new ApiError(404, "الحساب غير موجود");

  const pg = pageParams(req);
  const { rows } = await query(MESSAGES_SQL, [actorType, actorId, pg.limit, pg.offset]);

  await query(
    `UPDATE support_messages SET read_by_admin = TRUE
      WHERE actor_type = $1 AND actor_id = $2 AND sender_role = 'actor' AND read_by_admin = FALSE`,
    [actorType, actorId]
  );

  res.json({ actor: actorInfo, messages: rows });
}));

// رد الإدارة على حساب بعينه
supportRouter.post("/threads/:actorType/:actorId", ...requireStaff, asyncRoute(async (req, res) => {
  const { actorType, actorId } = req.params;
  if (!SUPPORT_TYPES.includes(actorType)) throw new ApiError(400, "نوع محادثة غير صالح");

  const actorInfo = await lookupActor(actorType, actorId);
  if (!actorInfo) throw new ApiError(404, "الحساب غير موجود");

  const { body } = bodySchema.parse(req.body);

  const { rows } = await query(
    `INSERT INTO support_messages (actor_type, actor_id, sender_role, admin_id, body, read_by_actor, read_by_admin)
     VALUES ($1,$2,'admin',$3,$4, FALSE, TRUE)
     RETURNING id, sender_role, body, created_at`,
    [actorType, actorId, req.actor.id, body]
  );

  res.status(201).json(rows[0]);
}));
