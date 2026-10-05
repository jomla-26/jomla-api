import { Router } from "express";
import { z } from "zod";
import { pool, query, withTransaction, writeAudit } from "../lib/db.js";
import { ApiError, asyncRoute } from "../lib/helpers.js";
import { parseRange, addRange, addDateColRange, andClause } from "../lib/dateRange.js";
import { authenticate, requirePermission } from "../middleware/auth.js";

export const assetsRouter = Router();
assetsRouter.use(authenticate);
assetsRouter.use(requirePermission("assets.manage"));

async function audit(req, action, entityType, entityId, label, after) {
  try {
    await writeAudit(pool, {
      actorType: "employee", actorId: req.actor.id, actorName: req.actor.name,
      action, entityType, entityId: entityId ?? null, entityLabel: label ?? null, after, ip: req.ip,
    });
  } catch (e) { console.error("[audit]", e.message); }
}

assetsRouter.get("/", asyncRoute(async (req, res) => {
  const { type } = req.query;
  const { rows } = await query(
    `SELECT a.*, vt.name AS vehicle_type_name
       FROM assets a LEFT JOIN vehicle_types vt ON vt.id = a.vehicle_type_id
      WHERE a.is_active AND ($1::TEXT IS NULL OR a.asset_type = $1)
      ORDER BY a.name`,
    [type || null]
  );
  res.json(rows);
}));

assetsRouter.post("/", asyncRoute(async (req, res) => {
  const body = z.object({
    name: z.string().trim().min(2).max(120),
    assetType: z.enum(["generator", "vehicle", "equipment"]),
    plateNumber: z.string().max(30).optional(),
    vehicleTypeId: z.string().uuid().optional(),
  }).parse(req.body);

  const { rows } = await query(
    `INSERT INTO assets (name, asset_type, plate_number, vehicle_type_id) VALUES ($1,$2,$3,$4) RETURNING *`,
    [body.name, body.assetType, body.plateNumber ?? null, body.vehicleTypeId ?? null]
  );
  await audit(req, "asset.created", "asset", rows[0].id, body.name, rows[0]);
  res.status(201).json(rows[0]);
}));

assetsRouter.post("/:id/runs", asyncRoute(async (req, res) => {
  const body = z.object({
    startedAt: z.string(), endedAt: z.string().optional(), purpose: z.string().max(500).optional(),
    fuelLiters: z.number().nonnegative().optional(), fuelCost: z.number().nonnegative().optional(),
  }).parse(req.body);

  const runHours = body.endedAt
    ? (new Date(body.endedAt) - new Date(body.startedAt)) / 3_600_000
    : null;

  const { rows } = await query(
    `INSERT INTO asset_runs (asset_id, started_at, ended_at, run_hours, purpose, fuel_liters, fuel_cost, recorded_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [req.params.id, body.startedAt, body.endedAt ?? null, runHours, body.purpose ?? null,
     body.fuelLiters ?? null, body.fuelCost ?? null, req.actor.id]
  );
  await audit(req, "asset.run_recorded", "asset", req.params.id, null, rows[0]);
  res.status(201).json(rows[0]);
}));

assetsRouter.get("/:id/runs", asyncRoute(async (req, res) => {
  const params = [req.params.id];
  const conds = addRange("started_at", parseRange(req.query), params, []);
  const { rows } = await query(
    `SELECT * FROM asset_runs WHERE asset_id = $1${andClause(conds)} ORDER BY started_at DESC LIMIT 200`, params
  );
  res.json(rows);
}));

assetsRouter.post("/:id/trips", asyncRoute(async (req, res) => {
  const body = z.object({
    tripDate: z.string(), driverId: z.string().uuid().optional(),
    kmStart: z.number().nonnegative().optional(), kmEnd: z.number().nonnegative().optional(),
    fuelCost: z.number().nonnegative().optional(), tripCost: z.number().nonnegative().optional(),
    orderIds: z.array(z.string().uuid()).default([]),
  }).parse(req.body);

  const distance = body.kmStart != null && body.kmEnd != null ? body.kmEnd - body.kmStart : null;

  const trip = await withTransaction(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO asset_trips
         (asset_id, driver_id, trip_date, km_start, km_end, distance_km, fuel_cost, trip_cost, orders_count, recorded_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [req.params.id, body.driverId ?? null, body.tripDate, body.kmStart ?? null, body.kmEnd ?? null,
       distance, body.fuelCost ?? null, body.tripCost ?? null, body.orderIds.length, req.actor.id]
    );
    for (const orderId of body.orderIds) {
      await client.query(
        `INSERT INTO asset_trip_orders (trip_id, order_id) VALUES ($1,$2)`, [rows[0].id, orderId]
      );
    }
    return rows[0];
  });

  await audit(req, "asset.trip_recorded", "asset", req.params.id, null, trip);
  res.status(201).json(trip);
}));

assetsRouter.get("/:id/trips", asyncRoute(async (req, res) => {
  const params = [req.params.id];
  const conds = addDateColRange("trip_date", parseRange(req.query), params, []);
  const { rows } = await query(
    `SELECT * FROM asset_trips WHERE asset_id = $1${andClause(conds)} ORDER BY trip_date DESC LIMIT 200`, params
  );
  res.json(rows);
}));

assetsRouter.post("/:id/maintenance", asyncRoute(async (req, res) => {
  const body = z.object({
    maintenanceType: z.enum(["routine", "repair", "breakdown"]),
    description: z.string().max(1000).optional(),
    cost: z.number().nonnegative().default(0),
    downtimeHours: z.number().nonnegative().optional(),
    startedAt: z.string(), endedAt: z.string().optional(),
  }).parse(req.body);

  const { rows } = await query(
    `INSERT INTO asset_maintenance
       (asset_id, maintenance_type, description, cost, downtime_hours, started_at, ended_at, recorded_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [req.params.id, body.maintenanceType, body.description ?? null, body.cost,
     body.downtimeHours ?? null, body.startedAt, body.endedAt ?? null, req.actor.id]
  );
  await audit(req, "asset.maintenance_recorded", "asset", req.params.id, null, rows[0]);
  res.status(201).json(rows[0]);
}));

assetsRouter.get("/summary", asyncRoute(async (_req, res) => {
  const { rows } = await query(
    `SELECT a.id, a.name, a.asset_type, a.plate_number,
            COALESCE(runs.hours, 0)      AS total_run_hours,
            COALESCE(runs.fuel_cost, 0)  AS run_fuel_cost,
            COALESCE(trips.km, 0)        AS total_km,
            COALESCE(trips.fuel_cost, 0) AS trip_fuel_cost,
            COALESCE(trips.trip_cost, 0) AS total_trip_cost,
            COALESCE(maint.cost, 0)      AS maintenance_cost,
            COALESCE(maint.downtime, 0)  AS downtime_hours
       FROM assets a
       LEFT JOIN (SELECT asset_id, SUM(run_hours) hours, SUM(fuel_cost) fuel_cost
                    FROM asset_runs GROUP BY asset_id) runs ON runs.asset_id = a.id
       LEFT JOIN (SELECT asset_id, SUM(distance_km) km, SUM(fuel_cost) fuel_cost, SUM(trip_cost) trip_cost
                    FROM asset_trips GROUP BY asset_id) trips ON trips.asset_id = a.id
       LEFT JOIN (SELECT asset_id, SUM(cost) cost, SUM(downtime_hours) downtime
                    FROM asset_maintenance GROUP BY asset_id) maint ON maint.asset_id = a.id
      WHERE a.is_active
      ORDER BY a.name`
  );
  res.json(rows);
}));
