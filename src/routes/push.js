import { Router } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { query } from "../lib/db.js";
import { asyncRoute, ApiError } from "../lib/helpers.js";
import { authenticate } from "../middleware/auth.js";
import { pushConfigured, vapidPublicKey, peekForEndpoint } from "../lib/push.js";

export const pushRouter = Router();

pushRouter.get("/key", (_req, res) => {
  if (!pushConfigured()) return res.status(503).json({ error: "إشعارات الهاتف غير مفعّلة بعد" });
  res.json({ key: vapidPublicKey() });
});

// تستدعيه الخدمة (service worker) بدون تسجيل دخول: العنوان نفسه سر الجهاز
pushRouter.post("/peek", rateLimit({ windowMs: 60_000, limit: 60, standardHeaders: true, legacyHeaders: false }),
  asyncRoute(async (req, res) => {
    const { endpoint } = z.object({ endpoint: z.string().url().max(1000) }).parse(req.body);
    res.json({ items: await peekForEndpoint(endpoint) });
  }));

pushRouter.post("/subscribe", authenticate, asyncRoute(async (req, res) => {
  if (!pushConfigured()) throw new ApiError(503, "إشعارات الهاتف غير مفعّلة بعد");
  const b = z.object({
    endpoint: z.string().url().max(1000),
    keys: z.object({ p256dh: z.string().max(200), auth: z.string().max(100) }).partial().optional(),
  }).parse(req.body);
  await query(
    `INSERT INTO push_subscriptions (actor_type, actor_id, endpoint, p256dh, auth)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (endpoint) DO UPDATE SET actor_type = EXCLUDED.actor_type, actor_id = EXCLUDED.actor_id,
       p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth, last_peek_at = now()`,
    [req.actor.type, req.actor.id, b.endpoint, b.keys?.p256dh ?? null, b.keys?.auth ?? null]
  );
  res.json({ ok: true });
}));

pushRouter.post("/unsubscribe", authenticate, asyncRoute(async (req, res) => {
  const { endpoint } = z.object({ endpoint: z.string().url().max(1000) }).parse(req.body);
  await query(`DELETE FROM push_subscriptions WHERE endpoint = $1 AND actor_id = $2`, [endpoint, req.actor.id]);
  res.json({ ok: true });
}));
