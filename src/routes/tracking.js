// تتبع موقع المندوب (GPS) أثناء التوصيل فقط:
//  - المندوب يرسل موقعه من تطبيقه طول ما عنده طلبية "في الطريق" (غير كده ما يتخزن شي)
//  - العميل يشوف مندوب طلبيته على الخريطة وهي في الطريق فقط
//  - الإدارة (صلاحية طلبيات/إسناد مندوب) تشوف كل المناديب اللي في الطريق
import { Router } from "express";
import { z } from "zod";
import { query } from "../lib/db.js";
import { ApiError, asyncRoute } from "../lib/helpers.js";
import { authenticate, requireAnyPermission } from "../middleware/auth.js";

export const trackingRouter = Router();
trackingRouter.use(authenticate);

const FRESH_MIN = 10; // أقدم من كده نعتبر الموقع قديم (التطبيق مقفول أو الإشارة ضاعت)
const isDriver = (a) => a.type === "employee" && a.role === "driver";

const locSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  accuracy: z.number().min(0).max(100000).optional(),
  speed: z.number().min(0).max(500).nullable().optional(),
  heading: z.number().min(0).max(360).nullable().optional(),
});

// المندوب يرسل موقعه (التطبيق يكرر كل ~20 ثانية)
trackingRouter.post("/location", asyncRoute(async (req, res) => {
  if (!isDriver(req.actor)) throw new ApiError(403, "للمناديب فقط");
  const b = locSchema.parse(req.body);
  const { rows } = await query(
    `SELECT 1 FROM orders WHERE driver_id = $1 AND status = 'out_for_delivery' LIMIT 1`, [req.actor.id]
  );
  if (!rows.length) {
    // ما عنده توصيل جاري: ما نخزّن شي ونمسح أي موقع قديم
    await query(`DELETE FROM driver_locations WHERE driver_id = $1`, [req.actor.id]);
    return res.json({ tracking: false });
  }
  await query(
    `INSERT INTO driver_locations (driver_id, lat, lng, accuracy, speed, heading, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6, now())
     ON CONFLICT (driver_id) DO UPDATE
       SET lat = EXCLUDED.lat, lng = EXCLUDED.lng, accuracy = EXCLUDED.accuracy,
           speed = EXCLUDED.speed, heading = EXCLUDED.heading, updated_at = now()`,
    [req.actor.id, b.lat, b.lng, b.accuracy ?? null, b.speed ?? null, b.heading ?? null]
  );
  res.json({ tracking: true });
}));

// المندوب يوقّف المشاركة (خلّص التوصيل)
trackingRouter.delete("/location", asyncRoute(async (req, res) => {
  if (!isDriver(req.actor)) throw new ApiError(403, "للمناديب فقط");
  await query(`DELETE FROM driver_locations WHERE driver_id = $1`, [req.actor.id]);
  res.json({ ok: true });
}));

// موقع مندوب طلبية معيّنة: العميل صاحب الطلبية، أو الإدارة، أو المندوب نفسه
trackingRouter.get("/orders/:orderId", asyncRoute(async (req, res) => {
  const a = req.actor;
  const { rows } = await query(
    `SELECT o.id, o.order_number, o.status, o.customer_id, o.driver_id,
            c.latitude AS dest_lat, c.longitude AS dest_lng, e.name AS driver_name, e.phone AS driver_phone
       FROM orders o
       JOIN customers c ON c.id = o.customer_id
       LEFT JOIN employees e ON e.id = o.driver_id
      WHERE o.id = $1`, [req.params.orderId]
  );
  if (!rows.length) throw new ApiError(404, "الطلبية غير موجودة");
  const o = rows[0];
  if (a.type === "customer") {
    if (o.customer_id !== a.id) throw new ApiError(403, "هذه الطلبية ليست لحسابك");
  } else if (a.type === "employee") {
    if (isDriver(a)) { if (o.driver_id !== a.id) throw new ApiError(403, "هذه الطلبية ليست مسندة لك"); }
    else await new Promise((resolve, reject) => requireAnyPermission("orders.review", "orders.assign_driver")(req, null, (e) => (e ? reject(e) : resolve())));
  } else throw new ApiError(403, "غير مسموح");

  const dest = o.dest_lat != null && o.dest_lng != null ? { lat: Number(o.dest_lat), lng: Number(o.dest_lng) } : null;
  if (o.status !== "out_for_delivery" || !o.driver_id) {
    return res.json({ active: false, status: o.status, destination: dest });
  }
  const { rows: l } = await query(
    `SELECT lat, lng, accuracy, heading, updated_at,
            EXTRACT(EPOCH FROM (now() - updated_at))::int AS age_sec
       FROM driver_locations WHERE driver_id = $1`, [o.driver_id]
  );
  const fresh = l.length && l[0].age_sec <= FRESH_MIN * 60;
  res.json({
    active: true, status: o.status, destination: dest,
    driver: { name: o.driver_name, phone: a.type === "customer" ? o.driver_phone : undefined },
    location: fresh ? { lat: Number(l[0].lat), lng: Number(l[0].lng), accuracy: l[0].accuracy, heading: l[0].heading, updatedAt: l[0].updated_at, ageSec: l[0].age_sec } : null,
  });
}));

// الإدارة: كل المناديب اللي في الطريق الآن ومواقعهم
trackingRouter.get("/drivers", requireAnyPermission("orders.review", "orders.assign_driver"), asyncRoute(async (_req, res) => {
  const { rows } = await query(
    `SELECT e.id AS driver_id, e.name, e.phone,
            l.lat, l.lng, l.accuracy, l.updated_at,
            EXTRACT(EPOCH FROM (now() - l.updated_at))::int AS age_sec,
            json_agg(json_build_object('id', o.id, 'orderNumber', o.order_number, 'customer', c.business_name,
                                       'lat', c.latitude, 'lng', c.longitude) ORDER BY o.order_number) AS orders
       FROM orders o
       JOIN employees e ON e.id = o.driver_id
       JOIN customers c ON c.id = o.customer_id
       LEFT JOIN driver_locations l ON l.driver_id = e.id
      WHERE o.status = 'out_for_delivery'
      GROUP BY e.id, e.name, e.phone, l.lat, l.lng, l.accuracy, l.updated_at
      ORDER BY e.name`
  );
  res.json(rows.map((r) => ({
    driverId: r.driver_id, name: r.name, phone: r.phone, orders: r.orders,
    location: r.lat != null && r.age_sec <= FRESH_MIN * 60
      ? { lat: Number(r.lat), lng: Number(r.lng), accuracy: r.accuracy, updatedAt: r.updated_at, ageSec: r.age_sec } : null,
  })));
}));
