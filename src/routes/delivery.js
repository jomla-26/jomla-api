import { Router } from "express";
import { z } from "zod";
import { pool, query, withTransaction, writeAudit } from "../lib/db.js";
import { ApiError, asyncRoute } from "../lib/helpers.js";
import { authenticate, requirePermission } from "../middleware/auth.js";

export const deliveryRouter = Router();
deliveryRouter.use(authenticate);

// تسجيل مختصر لتعديلات إعدادات التوصيل بسجل التدقيق (لا يعطّل العملية لو فشل التسجيل)
async function audit(req, action, entityType, entityId, label, after) {
  try {
    await writeAudit(pool, {
      actorType: "employee", actorId: req.actor.id, actorName: req.actor.name,
      action, entityType, entityId: entityId ?? null, entityLabel: label ?? null, after, ip: req.ip,
    });
  } catch (e) { console.error("[audit]", e.message); }
}

deliveryRouter.get("/zones", asyncRoute(async (_req, res) => {
  const { rows } = await query(`SELECT * FROM delivery_zones ORDER BY name`);
  res.json(rows);
}));

deliveryRouter.post("/zones", requirePermission("delivery.manage"), asyncRoute(async (req, res) => {
  const body = z.object({ name: z.string().trim().min(2).max(120), baseFee: z.number().nonnegative().max(1_000_000) }).parse(req.body);
  const zone = await withTransaction(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO delivery_zones (name, base_fee) VALUES ($1,$2) RETURNING *`, [body.name, body.baseFee]
    );

await writeAudit(client, {
      actorType: "employee", actorId: req.actor.id, actorName: req.actor.name,
      action: "delivery_zone.created", entityType: "delivery_zone", entityId: rows[0].id,
      entityLabel: body.name, after: rows[0], ip: req.ip,
    });
    return rows[0];
  });
  res.status(201).json(zone);
}));

deliveryRouter.patch("/zones/:id", requirePermission("delivery.manage"), asyncRoute(async (req, res) => {
  const body = z.object({
    name: z.string().trim().min(2).max(120).optional(), baseFee: z.number().nonnegative().max(1_000_000).optional(), isActive: z.boolean().optional(),
  }).parse(req.body);
  const { rows } = await query(
    `UPDATE delivery_zones SET
       name = COALESCE($2, name), base_fee = COALESCE($3, base_fee), is_active = COALESCE($4, is_active)
     WHERE id = $1 RETURNING *`,
    [req.params.id, body.name ?? null, body.baseFee ?? null, body.isActive ?? null]
  );
  if (!rows.length) throw new ApiError(404, "المنطقة غير موجودة");
  await audit(req, "delivery_zone.updated", "delivery_zone", rows[0].id, rows[0].name, rows[0]);
  res.json(rows[0]);
}));

deliveryRouter.get("/vehicle-types", asyncRoute(async (_req, res) => {
  const { rows } = await query(`SELECT * FROM vehicle_types ORDER BY name`);
  res.json(rows);
}));

deliveryRouter.post("/vehicle-types", requirePermission("delivery.manage"), asyncRoute(async (req, res) => {
  const body = z.object({
    name: z.string().trim().min(2).max(120), maxWeightKg: z.number().positive().optional(),
    maxVolumeM3: z.number().positive().optional(), tripCost: z.number().nonnegative(),
    feePerKm: z.number().nonnegative().optional(),
  }).parse(req.body);
  const { rows } = await query(
    `INSERT INTO vehicle_types (name, max_weight_kg, max_volume_m3, trip_cost, fee_per_km)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [body.name, body.maxWeightKg ?? null, body.maxVolumeM3 ?? null, body.tripCost, body.feePerKm ?? 0]
  );
  await audit(req, "vehicle_type.created", "vehicle_type", rows[0].id, rows[0].name, rows[0]);
  res.status(201).json(rows[0]);
}));

// تعديل نوع سيارة موجود (التكلفة، سعر الكيلومتر، الاسم، الحدود) أو إيقافه/تفعيله
deliveryRouter.patch("/vehicle-types/:id", requirePermission("delivery.manage"), asyncRoute(async (req, res) => {
  const body = z.object({
    name: z.string().trim().min(2).max(120).optional(),
    maxWeightKg: z.number().positive().optional(),
    maxVolumeM3: z.number().positive().optional(),
    tripCost: z.number().nonnegative().optional(),
    feePerKm: z.number().nonnegative().optional(),
    isActive: z.boolean().optional(),
  }).parse(req.body);

  const { rows } = await query(
    `UPDATE vehicle_types SET
       name = COALESCE($2, name),
       max_weight_kg = COALESCE($3, max_weight_kg),
       max_volume_m3 = COALESCE($4, max_volume_m3),
       trip_cost = COALESCE($5, trip_cost),
       fee_per_km = COALESCE($6, fee_per_km),
       is_active = COALESCE($7, is_active)
     WHERE id = $1 RETURNING *`,
    [req.params.id, body.name ?? null, body.maxWeightKg ?? null,
     body.maxVolumeM3 ?? null, body.tripCost ?? null, body.feePerKm ?? null, body.isActive ?? null]
  );
  if (!rows.length) throw new ApiError(404, "نوع السيارة غير موجود");
  await audit(req, "vehicle_type.updated", "vehicle_type", rows[0].id, rows[0].name, rows[0]);
  res.json(rows[0]);
}));

deliveryRouter.get("/rates", asyncRoute(async (_req, res) => {
  const { rows } = await query(
    `SELECT dr.*, z.name AS zone_name, vt.name AS vehicle_name
       FROM delivery_rates dr
       JOIN delivery_zones z  ON z.id  = dr.zone_id
       JOIN vehicle_types vt ON vt.id = dr.vehicle_type_id
      ORDER BY z.name, vt.name`
  );
  res.json(rows);
}));

deliveryRouter.post("/rates", requirePermission("delivery.manage"), asyncRoute(async (req, res) => {
  const body = z.object({
    zoneId: z.string().uuid(), vehicleTypeId: z.string().uuid(), fee: z.number().nonnegative(),
  }).parse(req.body);
  const { rows } = await query(
    `INSERT INTO delivery_rates (zone_id, vehicle_type_id, fee) VALUES ($1,$2,$3)
     ON CONFLICT (zone_id, vehicle_type_id) DO UPDATE SET fee = $3
     RETURNING *`,
    [body.zoneId, body.vehicleTypeId, body.fee]
  );
  await audit(req, "delivery_rate.upserted", "delivery_rate", rows[0].id, null, rows[0]);
  res.status(201).json(rows[0]);
}));

deliveryRouter.get("/settings", asyncRoute(async (_req, res) => {
  const { rows } = await query(`SELECT * FROM delivery_settings WHERE id = 1`);
  res.json(rows[0] ?? { extra_pickup_point_fee: 0 });
}));

deliveryRouter.patch("/settings", requirePermission("delivery.manage"), asyncRoute(async (req, res) => {
  const body = z.object({
    extraPickupPointFee: z.number().nonnegative().optional(),
    freeKm: z.number().nonnegative().optional(),
  }).parse(req.body);

  const { rows } = await query(
    `UPDATE delivery_settings SET
       extra_pickup_point_fee = COALESCE($1, extra_pickup_point_fee),
       free_km = COALESCE($2, free_km)
     WHERE id = 1 RETURNING *`,
    [body.extraPickupPointFee ?? null, body.freeKm ?? null]
  );
  await audit(req, "delivery_settings.updated", "delivery_settings", null, "إعدادات التوصيل", rows[0]);
  res.json(rows[0]);
}));
