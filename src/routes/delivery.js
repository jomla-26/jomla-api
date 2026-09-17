import { Router } from "express";
import { z } from "zod";
import { query, withTransaction, writeAudit } from "../lib/db.js";
import { ApiError, asyncRoute } from "../lib/helpers.js";
import { authenticate, requirePermission } from "../middleware/auth.js";

export const deliveryRouter = Router();
deliveryRouter.use(authenticate);

deliveryRouter.get("/zones", asyncRoute(async (_req, res) => {
  const { rows } = await query(`SELECT * FROM delivery_zones ORDER BY name`);
  res.json(rows);
}));

deliveryRouter.post("/zones", requirePermission("catalog.manage"), asyncRoute(async (req, res) => {
  const body = z.object({ name: z.string().min(2), baseFee: z.number().nonnegative() }).parse(req.body);
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

deliveryRouter.patch("/zones/:id", requirePermission("catalog.manage"), asyncRoute(async (req, res) => {
  const body = z.object({
    name: z.string().min(2).optional(), baseFee: z.number().nonnegative().optional(), isActive: z.boolean().optional(),
  }).parse(req.body);
  const { rows } = await query(
    `UPDATE delivery_zones SET
       name = COALESCE($2, name), base_fee = COALESCE($3, base_fee), is_active = COALESCE($4, is_active)
     WHERE id = $1 RETURNING *`,
    [req.params.id, body.name ?? null, body.baseFee ?? null, body.isActive ?? null]
  );
  if (!rows.length) throw new ApiError(404, "المنطقة غير موجودة");
  res.json(rows[0]);
}));

deliveryRouter.get("/vehicle-types", asyncRoute(async (_req, res) => {
  const { rows } = await query(`SELECT * FROM vehicle_types ORDER BY name`);
  res.json(rows);
}));

deliveryRouter.post("/vehicle-types", requirePermission("catalog.manage"), asyncRoute(async (req, res) => {
  const body = z.object({
    name: z.string().min(2), maxWeightKg: z.number().positive().optional(),
    maxVolumeM3: z.number().positive().optional(), tripCost: z.number().nonnegative(),
  }).parse(req.body);
  const { rows } = await query(
    `INSERT INTO vehicle_types (name, max_weight_kg, max_volume_m3, trip_cost) VALUES ($1,$2,$3,$4) RETURNING *`,
    [body.name, body.maxWeightKg ?? null, body.maxVolumeM3 ?? null, body.tripCost]
  );
  res.status(201).json(rows[0]);
}));

// تعديل نوع سيارة موجود (التكلفة، الاسم، الحدود) أو إيقافه/تفعيله
deliveryRouter.patch("/vehicle-types/:id", requirePermission("catalog.manage"), asyncRoute(async (req, res) => {
  const body = z.object({
    name: z.string().min(2).optional(),
    maxWeightKg: z.number().positive().optional(),
    maxVolumeM3: z.number().positive().optional(),
    tripCost: z.number().nonnegative().optional(),
    isActive: z.boolean().optional(),
  }).parse(req.body);

  const { rows } = await query(
    `UPDATE vehicle_types SET
       name = COALESCE($2, name),
       max_weight_kg = COALESCE($3, max_weight_kg),
       max_volume_m3 = COALESCE($4, max_volume_m3),
       trip_cost = COALESCE($5, trip_cost),
       is_active = COALESCE($6, is_active)
     WHERE id = $1 RETURNING *`,
    [req.params.id, body.name ?? null, body.maxWeightKg ?? null,
     body.maxVolumeM3 ?? null, body.tripCost ?? null, body.isActive ?? null]
  );
  if (!rows.length) throw new ApiError(404, "نوع السيارة غير موجود");
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

deliveryRouter.post("/rates", requirePermission("catalog.manage"), asyncRoute(async (req, res) => {
  const body = z.object({
    zoneId: z.string().uuid(), vehicleTypeId: z.string().uuid(), fee: z.number().nonnegative(),
  }).parse(req.body);
  const { rows } = await query(
    `INSERT INTO delivery_rates (zone_id, vehicle_type_id, fee) VALUES ($1,$2,$3)
     ON CONFLICT (zone_id, vehicle_type_id) DO UPDATE SET fee = $3
     RETURNING *`,
    [body.zoneId, body.vehicleTypeId, body.fee]
  );
  res.status(201).json(rows[0]);
}));

deliveryRouter.get("/settings", asyncRoute(async (_req, res) => {
  const { rows } = await query(`SELECT * FROM delivery_settings WHERE id = 1`);
  res.json(rows[0] ?? { extra_pickup_point_fee: 0 });
}));

deliveryRouter.patch("/settings", requirePermission("catalog.manage"), asyncRoute(async (req, res) => {
  const { extraPickupPointFee } = z.object({ extraPickupPointFee: z.number().nonnegative() }).parse(req.body);
  const { rows } = await query(
    `UPDATE delivery_settings SET extra_pickup_point_fee = $1 WHERE id = 1 RETURNING *`,
    [extraPickupPointFee]
  );
  res.json(rows[0]);
}));
