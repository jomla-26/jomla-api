import { Router } from "express";
import { z } from "zod";
import { query, withTransaction, writeAudit } from "../lib/db.js";
import { ApiError, asyncRoute, nextDocNumber, resolvePrice, calcDeliveryFee } from "../lib/helpers.js";
import { authenticate, requirePermission, requireActorType, assertCustomerSection } from "../middleware/auth.js";
import { queueNotification } from "../lib/notify.js";

export const orderRouter = Router();
orderRouter.use(authenticate);

async function recordStatus(client, { orderId, orderSupplierId = null, from, to, actor, note = null }) {
  await client.query(
    `INSERT INTO order_status_history
       (order_id, order_supplier_id, from_status, to_status, changed_by, changed_by_name, note)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [orderId, orderSupplierId, from, to, actor.id, actor.name, note]
  );
}
// إعادة حساب إجمالي كل جزء (مورد) وإجمالي الطلبية كاملة بعد أي تعديل على الأصناف
async function recalcOrderTotals(client, orderId) {
  await client.query(
    `UPDATE order_suppliers os SET subtotal = sub.total
       FROM (SELECT order_supplier_id, COALESCE(SUM(line_total),0) AS total
               FROM order_items WHERE order_id = $1 GROUP BY order_supplier_id) sub
      WHERE os.id = sub.order_supplier_id`,
    [orderId]
  );
  await client.query(
    `UPDATE orders o SET
       items_subtotal = sub.total,
       grand_total    = sub.total + o.delivery_fee
     FROM (SELECT order_id, COALESCE(SUM(line_total),0) AS total
             FROM order_items WHERE order_id = $1 GROUP BY order_id) sub
     WHERE o.id = $1 AND sub.order_id = o.id`,
    [orderId]
  );
  await client.query(
    `UPDATE orders SET items_subtotal = 0, grand_total = delivery_fee
      WHERE id = $1 AND NOT EXISTS (SELECT 1 FROM order_items WHERE order_id = $1)`,
    [orderId]
  );
}

const createSchema = z.object({
  fulfillment: z.enum(["delivery", "pickup"]),
  paymentMethod: z.enum(["cash", "card", "transfer", "pay_at_supplier", "deferred"]),
  deliveryZoneId: z.string().uuid().optional(),
  vehicleTypeId: z.string().uuid().optional(),
  vehiclesCount: z.number().int().min(1).default(1),
  supplierNotes: z.record(z.string()).optional(),
  items: z.array(z.object({
    productId: z.string().uuid(),
    qty: z.number().positive(),
  })).min(1),
});

orderRouter.post("/", requireActorType("customer"), asyncRoute(async (req, res) => {
  const body = createSchema.parse(req.body);

  const order = await withTransaction(async (client) => {
    const enriched = [];
    for (const item of body.items) {
      const { rows } = await client.query(
        `SELECT p.id, p.name, p.unit, p.section_id, p.supplier_id, p.purchase_cost,
                p.availability, s.status AS supplier_status
           FROM products p JOIN suppliers s ON s.id = p.supplier_id
          WHERE p.id = $1 AND p.is_active`,
        [item.productId]
      );
      if (!rows.length) throw new ApiError(404, `صنف غير متاح: ${item.productId}`);
      const p = rows[0];
      if (p.supplier_status !== "approved") throw new ApiError(400, "المورد غير معتمد حاليًا");
      if (p.availability === "out") throw new ApiError(400, `الصنف غير متوفر: ${p.name}`);

      await assertCustomerSection(req.actor.id, p.section_id);
      const price = await resolvePrice(client, {
        productId: p.id, customerId: req.actor.id, qty: item.qty,
      });
      enriched.push({ ...p, qty: item.qty, price });
    }

    const supplierIds = [...new Set(enriched.map((i) => i.supplier_id))];
    const itemsSubtotal = enriched.reduce((s, i) => s + i.price * i.qty, 0);

    const deliveryFee = body.fulfillment === "delivery"
      ? await calcDeliveryFee(client, {
          zoneId: body.deliveryZoneId,
          vehicleTypeId: body.vehicleTypeId,
          vehiclesCount: body.vehiclesCount,
          supplierCount: supplierIds.length,
        })
      : 0;

    const orderNumber = await nextDocNumber(client, {
      table: "orders", column: "order_number", prefix: "JOMLA", start: 3000,
    });

    const { rows: [created] } = await client.query(
      `INSERT INTO orders
         (order_number, customer_id, status, fulfillment, payment_method,
          items_subtotal, delivery_fee, grand_total,
          delivery_zone_id, vehicle_type_id, vehicles_count)
       VALUES ($1,$2,'under_review',$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING *`,
      [orderNumber, req.actor.id, body.fulfillment, body.paymentMethod,
       itemsSubtotal, deliveryFee, itemsSubtotal + deliveryFee,
       body.deliveryZoneId ?? null, body.vehicleTypeId ?? null, body.vehiclesCount]
    );

    for (const supplierId of supplierIds) {
      const mine = enriched.filter((i) => i.supplier_id === supplierId);
      const subtotal = mine.reduce((s, i) => s + i.price * i.qty, 0);

      const { rows: [os] } = await client.query(
        `INSERT INTO order_suppliers (order_id, supplier_id, subtotal, supplier_note)
         VALUES ($1,$2,$3,$4) RETURNING id`,
        [created.id, supplierId, subtotal, body.supplierNotes?.[supplierId] ?? null]
      );

      for (const i of mine) {
        await client.query(
          `INSERT INTO order_items
             (order_id, order_supplier_id, product_id, product_name, unit,
              unit_price, purchase_cost, qty_requested, line_total)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [created.id, os.id, i.id, i.name, i.unit, i.price, i.purchase_cost, i.qty, i.price * i.qty]
        );
      }
    }

    await recordStatus(client, {
      orderId: created.id, from: "draft", to: "under_review", actor: req.actor,
    });
    await writeAudit(client, {
      actorType: "customer", actorId: req.actor.id, actorName: req.actor.name,
      action: "order.submitted", entityType: "order", entityId: created.id,
      entityLabel: orderNumber, after: created, ip: req.ip,
    });

    return { ...created, supplierCount: supplierIds.length };
  });

  res.status(201).json(order);
}));

// إنشاء طلبية من لوحة الإدارة نيابة عن عميل موجود ومعتمد
const adminCreateSchema = createSchema.extend({
  customerId: z.string().uuid(),
});

orderRouter.post("/admin-create", requirePermission("orders.review"), asyncRoute(async (req, res) => {
  const body = adminCreateSchema.parse(req.body);

  const cust = await query(`SELECT id, status FROM customers WHERE id = $1`, [body.customerId]);
  if (!cust.rows.length) throw new ApiError(404, "العميل غير موجود");
  if (cust.rows[0].status !== "approved") throw new ApiError(400, "لا يمكن إنشاء طلبية لعميل غير معتمد");

  const order = await withTransaction(async (client) => {
    const enriched = [];
    for (const item of body.items) {
      const { rows } = await client.query(
        `SELECT p.id, p.name, p.unit, p.section_id, p.supplier_id, p.purchase_cost,
                p.availability, s.status AS supplier_status
           FROM products p JOIN suppliers s ON s.id = p.supplier_id
          WHERE p.id = $1 AND p.is_active`,
        [item.productId]
      );
      if (!rows.length) throw new ApiError(404, `صنف غير متاح: ${item.productId}`);
      const p = rows[0];
      if (p.supplier_status !== "approved") throw new ApiError(400, "المورد غير معتمد حاليًا");
      if (p.availability === "out") throw new ApiError(400, `الصنف غير متوفر: ${p.name}`);

      await assertCustomerSection(body.customerId, p.section_id);
      const price = await resolvePrice(client, {
        productId: p.id, customerId: body.customerId, qty: item.qty,
      });
      enriched.push({ ...p, qty: item.qty, price });
    }

    const supplierIds = [...new Set(enriched.map((i) => i.supplier_id))];
    const itemsSubtotal = enriched.reduce((s, i) => s + i.price * i.qty, 0);

    const deliveryFee = body.fulfillment === "delivery"
      ? await calcDeliveryFee(client, {
          zoneId: body.deliveryZoneId,
          vehicleTypeId: body.vehicleTypeId,
          vehiclesCount: body.vehiclesCount,
          supplierCount: supplierIds.length,
        })
      : 0;

    const orderNumber = await nextDocNumber(client, {
      table: "orders", column: "order_number", prefix: "JOMLA", start: 3000,
    });

    const { rows: [created] } = await client.query(
      `INSERT INTO orders
         (order_number, customer_id, status, fulfillment, payment_method,
          items_subtotal, delivery_fee, grand_total,
          delivery_zone_id, vehicle_type_id, vehicles_count)
       VALUES ($1,$2,'under_review',$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING *`,
      [orderNumber, body.customerId, body.fulfillment, body.paymentMethod,
       itemsSubtotal, deliveryFee, itemsSubtotal + deliveryFee,
       body.deliveryZoneId ?? null, body.vehicleTypeId ?? null, body.vehiclesCount]
    );

    for (const supplierId of supplierIds) {
      const mine = enriched.filter((i) => i.supplier_id === supplierId);
      const subtotal = mine.reduce((s, i) => s + i.price * i.qty, 0);

      const { rows: [os] } = await client.query(
        `INSERT INTO order_suppliers (order_id, supplier_id, subtotal, supplier_note)
         VALUES ($1,$2,$3,$4) RETURNING id`,
        [created.id, supplierId, subtotal, body.supplierNotes?.[supplierId] ?? null]
      );

      for (const i of mine) {
        await client.query(
          `INSERT INTO order_items
             (order_id, order_supplier_id, product_id, product_name, unit,
              unit_price, purchase_cost, qty_requested, line_total)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [created.id, os.id, i.id, i.name, i.unit, i.price, i.purchase_cost, i.qty, i.price * i.qty]
        );
      }
    }

    await recordStatus(client, {
      orderId: created.id, from: "draft", to: "under_review", actor: req.actor,
      note: "أُنشئت بواسطة الدعم الفني نيابة عن العميل",
    });
    await writeAudit(client, {
      actorType: "employee", actorId: req.actor.id, actorName: req.actor.name,
      action: "order.created_by_admin", entityType: "order", entityId: created.id,
      entityLabel: orderNumber, after: created, ip: req.ip,
    });

    return { ...created, supplierCount: supplierIds.length };
  });

  res.status(201).json(order);
}));

orderRouter.get("/", asyncRoute(async (req, res) => {
  const { status } = req.query;
  const a = req.actor;

  if (a.type === "customer") {
    const { rows } = await query(
      `SELECT o.*, (SELECT COUNT(*) FROM order_suppliers WHERE order_id = o.id) AS supplier_count
         FROM orders o
        WHERE o.customer_id = $1 AND ($2::TEXT IS NULL OR o.status = $2)
        ORDER BY o.created_at DESC`,
      [a.id, status || null]
    );
    return res.json(rows);
  }

  if (a.type === "supplier") {
    const { rows } = await query(
      `SELECT os.id AS order_supplier_id, os.status, os.subtotal, os.supplier_note,
              o.id AS order_id, o.order_number, o.fulfillment, o.created_at, c.business_name AS customer_name
         FROM order_suppliers os
         JOIN orders o    ON o.id = os.order_id
         JOIN customers c ON c.id = o.customer_id
        WHERE os.supplier_id = $1
          AND o.status NOT IN ('draft','under_review')
          AND ($2::TEXT IS NULL OR os.status = $2)
        ORDER BY o.created_at DESC`,
      [a.id, status || null]
    );
    return res.json(rows);
  }

  if (a.role === "driver") {
    const { rows } = await query(
      `SELECT o.*, c.business_name AS customer_name, c.phone AS customer_phone, c.address
         FROM orders o JOIN customers c ON c.id = o.customer_id
        WHERE o.driver_id = $1 AND ($2::TEXT IS NULL OR o.status = $2)
        ORDER BY o.created_at DESC`,
      [a.id, status || null]
    );
    return res.json(rows);
  }

  const { rows } = await query(
    `SELECT o.*, c.business_name AS customer_name
       FROM orders o JOIN customers c ON c.id = o.customer_id
      WHERE ($1::TEXT IS NULL OR o.status = $1)
      ORDER BY o.created_at DESC`,
    [status || null]
  );
  res.json(rows);
}));

orderRouter.get("/:id", asyncRoute(async (req, res) => {
  const { rows } = await query(
    `SELECT o.*, c.business_name AS customer_name, c.phone AS customer_phone, c.address
       FROM orders o JOIN customers c ON c.id = o.customer_id
      WHERE o.id = $1`,
    [req.params.id]
  );
  if (!rows.length) throw new ApiError(404, "الطلبية غير موجودة");
  const order = rows[0];

  if (req.actor.type === "customer" && order.customer_id !== req.actor.id) {
    throw new ApiError(403, "لا تملك صلاحية الاطلاع على هذه الطلبية");
  }

  const suppliers = await query(
    `SELECT os.*, s.business_name AS supplier_name
       FROM order_suppliers os JOIN suppliers s ON s.id = os.supplier_id
      WHERE os.order_id = $1`,
    [req.params.id]
  );
  const items = await query(`SELECT * FROM order_items WHERE order_id = $1`, [req.params.id]);
  const history = await query(
    `SELECT from_status, to_status, changed_by_name, note, changed_at
       FROM order_status_history WHERE order_id = $1 ORDER BY changed_at`,
    [req.params.id]
  );

  res.json({
    ...order,
    suppliers: suppliers.rows.map((s) => ({
      ...s,
      items: items.rows.filter((i) => i.order_supplier_id === s.id),
    })),
    history: history.rows,
  });
}));
orderRouter.post("/:id/approve", requirePermission("orders.review"), asyncRoute(async (req, res) => {
  const body = z.object({
    depositDueAtDelivery: z.number().nonnegative().optional(),
    deferredDueDate: z.string().optional(),
  }).parse(req.body ?? {});

  const result = await withTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT * FROM orders WHERE id = $1 FOR UPDATE`, [req.params.id]
    );
    if (!rows.length) throw new ApiError(404, "الطلبية غير موجودة");
    const order = rows[0];
    if (order.status !== "under_review") throw new ApiError(400, "الطلبية ليست قيد المراجعة");

    if (order.payment_method === "deferred") {
      const cust = await client.query(`SELECT credit_enabled FROM customers WHERE id = $1`, [order.customer_id]);
      if (!cust.rows[0]?.credit_enabled) throw new ApiError(400, "البيع الآجل غير مفعّل لهذا العميل");
    }

    const { rows: [updated] } = await client.query(
      `UPDATE orders SET
         status = 'sent_to_supplier',
         reviewed_by = $2, reviewed_at = now(),
         deposit_due_at_delivery = COALESCE($3, deposit_due_at_delivery),
         deferred_due_date       = COALESCE($4::DATE, deferred_due_date),
         credit_approved_by = CASE WHEN payment_method = 'deferred' THEN $2 ELSE credit_approved_by END
       WHERE id = $1 RETURNING *`,
      [order.id, req.actor.id, body.depositDueAtDelivery ?? null, body.deferredDueDate ?? null]
    );

    await client.query(
      `UPDATE order_suppliers SET status = 'sent' WHERE order_id = $1`, [order.id]
    );
    await recordStatus(client, {
      orderId: order.id, from: order.status, to: "sent_to_supplier", actor: req.actor,
    });
    await writeAudit(client, {
      actorType: "employee", actorId: req.actor.id, actorName: req.actor.name,
      action: "order.approved", entityType: "order", entityId: order.id,
      entityLabel: order.order_number, before: order, after: updated, ip: req.ip,
    });

    await queueNotification(client, {
      templateCode: "order.status", recipientType: "customer",
      recipientId: order.customer_id, orderId: order.id,
      vars: { order_number: order.order_number, status: "مرسلة إلى المورد" },
    });

    return updated;
  });

  res.json(result);
}));

orderRouter.post("/:id/reject", requirePermission("orders.cancel"), asyncRoute(async (req, res) => {
  const { reason, postpone } = z.object({
    reason: z.string().min(3),
    postpone: z.boolean().default(false),
  }).parse(req.body);

  const result = await withTransaction(async (client) => {
    const { rows } = await client.query(`SELECT * FROM orders WHERE id = $1 FOR UPDATE`, [req.params.id]);
    if (!rows.length) throw new ApiError(404, "الطلبية غير موجودة");
    const order = rows[0];
    if (["delivered", "closed", "cancelled"].includes(order.status)) {
      throw new ApiError(400, "لا يمكن تعديل حالة طلبية مغلقة أو ملغاة");
    }

    const to = postpone ? "postponed" : "cancelled";
    const { rows: [updated] } = await client.query(
      `UPDATE orders SET status = $2, cancel_reason = $3 WHERE id = $1 RETURNING *`,
      [order.id, to, reason]
    );
    await recordStatus(client, { orderId: order.id, from: order.status, to, actor: req.actor, note: reason });
    await writeAudit(client, {
      actorType: "employee", actorId: req.actor.id, actorName: req.actor.name,
      action: postpone ? "order.postponed" : "order.cancelled",
      entityType: "order", entityId: order.id, entityLabel: order.order_number,
      before: order, after: updated, ip: req.ip,
    });
    return updated;
  });

  res.json(result);
}));

orderRouter.patch("/:id/status", requirePermission("orders.review"), asyncRoute(async (req, res) => {
  const { status, note } = z.object({
    status: z.string(), note: z.string().optional(),
  }).parse(req.body);

  const result = await withTransaction(async (client) => {
    const { rows } = await client.query(`SELECT * FROM orders WHERE id = $1 FOR UPDATE`, [req.params.id]);
    if (!rows.length) throw new ApiError(404, "الطلبية غير موجودة");
    const order = rows[0];

    if (["delivered", "cancelled", "closed"].includes(order.status)) {
      throw new ApiError(400, "لا يمكن تغيير حالة طلبية تم تسليمها أو إلغاؤها");
    }

    const { rows: [updated] } = await client.query(
      `UPDATE orders SET status = $2 WHERE id = $1 RETURNING *`, [order.id, status]
    );
    await recordStatus(client, { orderId: order.id, from: order.status, to: status, actor: req.actor, note });
    await writeAudit(client, {
      actorType: "employee", actorId: req.actor.id, actorName: req.actor.name,
      action: "order.status_changed", entityType: "order", entityId: order.id,
      entityLabel: order.order_number, before: order, after: updated, ip: req.ip,
    });
    await queueNotification(client, {
      templateCode: "order.status", recipientType: "customer",
      recipientId: order.customer_id, orderId: order.id,
      vars: { order_number: order.order_number, status },
    });
    return updated;
  });

  res.json(result);
}));

// تغيير طريقة تسليم الطلبية (استلام شخصي ↔ توصيل) — قبل إسناد مندوب
orderRouter.patch("/:id/fulfillment", requirePermission("orders.review"), asyncRoute(async (req, res) => {
  const body = z.object({
    fulfillment: z.enum(["delivery", "pickup"]),
    deliveryZoneId: z.string().uuid().optional(),
    vehicleTypeId: z.string().uuid().optional(),
    vehiclesCount: z.number().int().min(1).default(1),
  }).parse(req.body);

  const result = await withTransaction(async (client) => {
    const { rows } = await client.query(`SELECT * FROM orders WHERE id = $1 FOR UPDATE`, [req.params.id]);
    if (!rows.length) throw new ApiError(404, "الطلبية غير موجودة");
    const order = rows[0];

    if (["delivered", "cancelled", "closed"].includes(order.status)) {
      throw new ApiError(400, "لا يمكن تعديل طريقة تسليم طلبية تم تسليمها أو إلغاؤها");
    }
    if (order.driver_id) {
      throw new ApiError(400, "لا يمكن تغيير طريقة التسليم بعد إسناد الطلبية لمندوب");
    }

    let deliveryFee = 0;
    if (body.fulfillment === "delivery") {
      const { rows: [{ count }] } = await client.query(
        `SELECT COUNT(*)::INT AS count FROM order_suppliers WHERE order_id = $1`, [order.id]
      );
      deliveryFee = await calcDeliveryFee(client, {
        zoneId: body.deliveryZoneId, vehicleTypeId: body.vehicleTypeId,
        vehiclesCount: body.vehiclesCount, supplierCount: count,
      });
    }

    const { rows: [updated] } = await client.query(
      `UPDATE orders SET
         fulfillment = $2, delivery_fee = $3, grand_total = items_subtotal + $3,
         delivery_zone_id = $4, vehicle_type_id = $5, vehicles_count = $6
       WHERE id = $1 RETURNING *`,
      [order.id, body.fulfillment, deliveryFee,
       body.fulfillment === "delivery" ? (body.deliveryZoneId ?? null) : null,
       body.fulfillment === "delivery" ? (body.vehicleTypeId ?? null) : null,
       body.fulfillment === "delivery" ? body.vehiclesCount : 1]
    );

    await recordStatus(client, {
      orderId: order.id, from: order.status, to: order.status, actor: req.actor,
      note: `تم تغيير طريقة التسليم إلى: ${body.fulfillment === "delivery" ? "توصيل" : "استلام شخصي"}`,
    });
    await writeAudit(client, {
      actorType: "employee", actorId: req.actor.id, actorName: req.actor.name,
      action: "order.fulfillment_changed", entityType: "order", entityId: order.id,
      entityLabel: order.order_number, before: order, after: updated, ip: req.ip,
    });

    return updated;
  });

  res.json(result);
}));

// تحويل دفعي لحالة عدة طلبيات مرة واحدة — تُستخدم من شاشة "كل الطلبيات"
orderRouter.patch("/bulk-status", requirePermission("orders.review"), asyncRoute(async (req, res) => {
  const { orderIds, status, note } = z.object({
    orderIds: z.array(z.string().uuid()).min(1),
    status: z.string(),
    note: z.string().optional(),
  }).parse(req.body);

  const result = await withTransaction(async (client) => {
    const updated = [];
    const skipped = [];

    for (const orderId of orderIds) {
      const { rows } = await client.query(`SELECT * FROM orders WHERE id = $1 FOR UPDATE`, [orderId]);
      if (!rows.length) { skipped.push({ orderId, reason: "غير موجودة" }); continue; }
      const order = rows[0];

      if (["delivered", "cancelled", "closed"].includes(order.status)) {
        skipped.push({ orderId, orderNumber: order.order_number, reason: "مغلقة أو ملغاة" });
        continue;
      }
      if (order.status === status) {
        skipped.push({ orderId, orderNumber: order.order_number, reason: "بالفعل في هذه الحالة" });
        continue;
      }

      const { rows: [u] } = await client.query(
        `UPDATE orders SET status = $2 WHERE id = $1 RETURNING *`, [orderId, status]
      );

      if (!["under_review", "draft"].includes(status)) {
        await client.query(
          `UPDATE order_suppliers SET status = 'sent' WHERE order_id = $1 AND status = 'pending'`,
          [orderId]
        );
      }

      await recordStatus(client, { orderId, from: order.status, to: status, actor: req.actor, note });
      await writeAudit(client, {
        actorType: "employee", actorId: req.actor.id, actorName: req.actor.name,
        action: "order.status_changed", entityType: "order", entityId: orderId,
        entityLabel: order.order_number, before: order, after: u, ip: req.ip,
      });
      await queueNotification(client, {
        templateCode: "order.status", recipientType: "customer",
        recipientId: order.customer_id, orderId,
        vars: { order_number: order.order_number, status },
      });
      updated.push(u);
    }

    return { updated, skipped };
  });

  res.json({
    updatedCount: result.updated.length,
    skippedCount: result.skipped.length,
    updated: result.updated,
    skipped: result.skipped,
  });
}));

orderRouter.post("/supplier-parts/:osId/availability", requireActorType("supplier"), asyncRoute(async (req, res) => {
  const body = z.object({
    items: z.array(z.object({
      orderItemId: z.string().uuid(),
      availability: z.enum(["full", "partial", "out"]),
      qtyConfirmed: z.number().nonnegative(),
    })).min(1),
  }).parse(req.body);

  const result = await withTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT os.*, o.order_number, o.customer_id
         FROM order_suppliers os JOIN orders o ON o.id = os.order_id
        WHERE os.id = $1 AND os.supplier_id = $2 FOR UPDATE`,
      [req.params.osId, req.actor.id]
    );
    if (!rows.length) throw new ApiError(404, "الجزء غير موجود");
    const part = rows[0];

    let hasShortage = false;
    let subtotal = 0;

    for (const it of body.items) {
      const { rows: itemRows } = await client.query(
        `SELECT * FROM order_items WHERE id = $1 AND order_supplier_id = $2`,
        [it.orderItemId, part.id]
      );
      if (!itemRows.length) throw new ApiError(404, "صنف غير موجود في هذا الجزء");
      const item = itemRows[0];

      const qty = it.availability === "full" ? item.qty_requested
                : it.availability === "out"  ? 0
                : it.qtyConfirmed;

      await client.query(
        `UPDATE order_items
            SET availability = $2, qty_confirmed = $3, line_total = unit_price * $3
          WHERE id = $1`,
        [item.id, it.availability, qty]
      );
      subtotal += item.unit_price * qty;

      if (it.availability !== "full") {
        hasShortage = true;
        await client.query(
          `INSERT INTO order_shortages (order_item_id, qty_missing)
           VALUES ($1,$2)`,
          [item.id, item.qty_requested - qty]
        );
      }
    }

    const newStatus = hasShortage ? "shortage" : "preparing";
    await client.query(
      `UPDATE order_suppliers SET status = $2, subtotal = $3 WHERE id = $1`,
      [part.id, newStatus, subtotal]
    );
    await recordStatus(client, {
      orderId: part.order_id, orderSupplierId: part.id,
      from: part.status, to: newStatus, actor: req.actor,
    });

    if (hasShortage) {
      await client.query(`UPDATE orders SET status = 'shortage' WHERE id = $1`, [part.order_id]);
      await queueNotification(client, {
        templateCode: "order.shortage", recipientType: "customer",
        recipientId: part.customer_id, orderId: part.order_id,
        vars: { order_number: part.order_number },
      });
    }

    return { orderSupplierId: part.id, status: newStatus, subtotal, hasShortage };
  });

  res.json(result);
}));

orderRouter.get("/:id/shortages", requirePermission("orders.review"), asyncRoute(async (req, res) => {
  const { rows } = await query(
    `SELECT sh.*, oi.product_name, oi.unit, oi.qty_requested, os.supplier_id, s.business_name AS supplier_name
       FROM order_shortages sh
       JOIN order_items oi      ON oi.id = sh.order_item_id
       JOIN order_suppliers os  ON os.id = oi.order_supplier_id
       JOIN suppliers s         ON s.id  = os.supplier_id
      WHERE oi.order_id = $1
      ORDER BY sh.created_at DESC`,
    [req.params.id]
  );
  res.json(rows);
}));

orderRouter.post("/shortages/:id/resolve", requirePermission("orders.review"), asyncRoute(async (req, res) => {
  const body = z.object({
    resolution: z.enum(["reduce_qty", "cancel_item", "accept_substitute", "wait"]),
    substituteProductId: z.string().uuid().optional(),
    customerApproved: z.boolean(),
  }).parse(req.body);

  if (!body.customerApproved) throw new ApiError(400, "يلزم تأكيد موافقة الزبون أولًا");

  const result = await withTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT sh.*, oi.order_id FROM order_shortages sh
         JOIN order_items oi ON oi.id = sh.order_item_id
        WHERE sh.id = $1 FOR UPDATE`,
      [req.params.id]
    );
    if (!rows.length) throw new ApiError(404, "سجل النقص غير موجود");
    const shortage = rows[0];

    const { rows: [updated] } = await client.query(
      `UPDATE order_shortages SET
         resolution = $2, substitute_product_id = $3,
         customer_approved = TRUE, admin_approved = TRUE,
         resolved_by = $4, resolved_at = now()
       WHERE id = $1 RETURNING *`,
      [shortage.id, body.resolution, body.substituteProductId ?? null, req.actor.id]
    );

    if (body.resolution === "cancel_item") {
      await client.query(
        `UPDATE order_items SET qty_confirmed = 0, line_total = 0 WHERE id = $1`,
        [shortage.order_item_id]
      );
    }

    await client.query(
      `UPDATE orders o SET
         items_subtotal = sub.total,
         grand_total    = sub.total + o.delivery_fee
       FROM (SELECT order_id, COALESCE(SUM(line_total),0) AS total
               FROM order_items WHERE order_id = $1 GROUP BY order_id) sub
       WHERE o.id = $1`,
      [shortage.order_id]
    );

    await writeAudit(client, {
      actorType: "employee", actorId: req.actor.id, actorName: req.actor.name,
      action: "shortage.resolved", entityType: "order_shortage", entityId: shortage.id,
      after: updated, ip: req.ip,
    });
    return updated;
  });

  res.json(result);
}));

orderRouter.post("/:id/assign-driver", requirePermission("orders.assign_driver"), asyncRoute(async (req, res) => {
  const { driverId } = z.object({ driverId: z.string().uuid() }).parse(req.body);

  const result = await withTransaction(async (client) => {
    const { rows } = await client.query(`SELECT * FROM orders WHERE id = $1 FOR UPDATE`, [req.params.id]);
    if (!rows.length) throw new ApiError(404, "الطلبية غير موجودة");
    const order = rows[0];
    if (order.fulfillment !== "delivery") throw new ApiError(400, "الطلبية للاستلام الشخصي");

    const cod = order.payment_method === "deferred"
      ? Number(order.deposit_due_at_delivery || 0)
      : Number(order.grand_total) - Number(order.paid_amount);

    const { rows: [updated] } = await client.query(
      `UPDATE orders SET driver_id = $2, assigned_at = now(),
              status = 'out_for_delivery', cod_amount = $3
       WHERE id = $1 RETURNING *`,
      [order.id, driverId, cod > 0 ? cod : 0]
    );
    await recordStatus(client, {
      orderId: order.id, from: order.status, to: "out_for_delivery", actor: req.actor,
    });
    await writeAudit(client, {
      actorType: "employee", actorId: req.actor.id, actorName: req.actor.name,
      action: "order.driver_assigned", entityType: "order", entityId: order.id,
      entityLabel: order.order_number, after: updated, ip: req.ip,
    });
    await queueNotification(client, {
      templateCode: "delivery.scheduled", recipientType: "customer",
      recipientId: order.customer_id, orderId: order.id,
      vars: { order_number: order.order_number },
    });
    return updated;
  });

  res.json(result);
}));

orderRouter.post("/:id/deliver", requireActorType("employee"), asyncRoute(async (req, res) => {
  if (req.actor.role !== "driver") throw new ApiError(403, "هذا الإجراء مخصص لمندوبي التوصيل");
  const { collected } = z.object({ collected: z.boolean() }).parse(req.body);

  const result = await withTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT * FROM orders WHERE id = $1 AND driver_id = $2 FOR UPDATE`,
      [req.params.id, req.actor.id]
    );
    if (!rows.length) throw new ApiError(404, "الطلبية غير مسندة إليك");
    const order = rows[0];

    const { rows: [updated] } = await client.query(
      `UPDATE orders SET status = 'delivered', delivered_at = now(),
              cod_collected = $2,
              paid_amount = paid_amount + CASE WHEN $2 THEN cod_amount ELSE 0 END,
              payment_status = CASE
                WHEN $2 AND paid_amount + cod_amount >= grand_total THEN 'paid'
                WHEN $2 THEN 'partially_paid' ELSE payment_status END
       WHERE id = $1 RETURNING *`,
      [order.id, collected]
    );
    await recordStatus(client, {
      orderId: order.id, from: order.status, to: "delivered", actor: req.actor,
      note: collected ? `تم تحصيل ${order.cod_amount}` : "تسليم بدون تحصيل",
    });
    await writeAudit(client, {
      actorType: "employee", actorId: req.actor.id, actorName: req.actor.name,
      action: "order.delivered", entityType: "order", entityId: order.id,
      entityLabel: order.order_number, after: updated, ip: req.ip,
    });
    return updated;
  });

  res.json(result);
}));

orderRouter.post("/supplier-parts/:osId/pickup-confirm", requireActorType("supplier"), asyncRoute(async (req, res) => {
  const { paymentReceived } = z.object({ paymentReceived: z.boolean() }).parse(req.body);

  const result = await withTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT os.*, o.order_number, o.payment_method
         FROM order_suppliers os JOIN orders o ON o.id = os.order_id
        WHERE os.id = $1 AND os.supplier_id = $2 FOR UPDATE`,
      [req.params.osId, req.actor.id]
    );
    if (!rows.length) throw new ApiError(404, "الجزء غير موجود");
    const part = rows[0];

    if (!paymentReceived && part.payment_method !== "deferred") {
      throw new ApiError(400, "يلزم تأكيد استلام قيمة الفاتورة أو اعتماد الحوالة");
    }

    await client.query(
      `UPDATE order_suppliers
          SET pickup_confirmed = TRUE, payment_received = $2,
              status = 'picked_up', confirmed_at = now()
        WHERE id = $1`,
      [part.id, paymentReceived]
    );

    const { rows: [pending] } = await client.query(
      `SELECT COUNT(*)::INT AS remaining FROM order_suppliers
        WHERE order_id = $1 AND NOT pickup_confirmed`,
      [part.order_id]
    );

    if (pending.remaining === 0) {
      await client.query(
        `UPDATE orders SET status = 'delivered', delivered_at = now() WHERE id = $1`,
        [part.order_id]
      );
      await recordStatus(client, {
        orderId: part.order_id, from: "awaiting_pickup", to: "delivered", actor: req.actor,
      });
    }

    return { confirmed: true, remainingParts: pending.remaining };
  });

  res.json(result);
}));

orderRouter.post("/:id/receipt", requirePermission("orders.review"), asyncRoute(async (req, res) => {
  const receipt = await withTransaction(async (client) => {
    const { rows } = await client.query(`SELECT * FROM orders WHERE id = $1 FOR UPDATE`, [req.params.id]);
    if (!rows.length) throw new ApiError(404, "الطلبية غير موجودة");
    const order = rows[0];
    if (!["delivered", "closed"].includes(order.status)) {
      throw new ApiError(400, "لا يمكن إصدار إيصال إلا بعد تسليم الطلبية");
    }

    const number = await nextDocNumber(client, {
      table: "order_receipts", column: "receipt_number", prefix: "REC", start: 1000,
    });
    const remaining = Math.max(0, Number(order.grand_total) - Number(order.paid_amount));

    const { rows: created } = await client.query(
      `INSERT INTO order_receipts
         (receipt_number, order_id, invoice_total, amount_paid, amount_remaining,
          payment_method, due_date, issued_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [number, order.id, order.grand_total, order.paid_amount, remaining,
       order.payment_method, order.deferred_due_date, req.actor.id]
    );

    if (remaining <= 0 && order.status === "delivered") {
      await client.query(`UPDATE orders SET status = 'closed' WHERE id = $1`, [order.id]);
      await recordStatus(client, { orderId: order.id, from: "delivered", to: "closed", actor: req.actor });
    }

    await writeAudit(client, {
      actorType: "employee", actorId: req.actor.id, actorName: req.actor.name,
      action: "receipt.issued", entityType: "order_receipt", entityId: created[0].id,
      entityLabel: number, after: created[0], ip: req.ip,
    });
    return created[0];
  });

  res.status(201).json(receipt);
}));

orderRouter.get("/:id/receipts", asyncRoute(async (req, res) => {
  const order = await query(`SELECT customer_id FROM orders WHERE id = $1`, [req.params.id]);
  if (!order.rows.length) throw new ApiError(404, "الطلبية غير موجودة");
  if (req.actor.type === "customer" && order.rows[0].customer_id !== req.actor.id) {
    throw new ApiError(403, "لا تملك صلاحية الاطلاع على هذه الطلبية");
  }
  const { rows } = await query(`SELECT * FROM order_receipts WHERE order_id = $1 ORDER BY issued_at DESC`, [req.params.id]);
  res.json(rows);
}));

// إضافة صنف جديد لفاتورة طلبية بعد اعتمادها
orderRouter.post("/:id/items", requirePermission("orders.review"), asyncRoute(async (req, res) => {
  const body = z.object({
    productId: z.string().uuid(),
    qty: z.number().positive(),
  }).parse(req.body);

  const result = await withTransaction(async (client) => {
    const { rows: orderRows } = await client.query(`SELECT * FROM orders WHERE id = $1 FOR UPDATE`, [req.params.id]);
    if (!orderRows.length) throw new ApiError(404, "الطلبية غير موجودة");
    const order = orderRows[0];
    if (["delivered", "cancelled", "closed"].includes(order.status)) {
      throw new ApiError(400, "لا يمكن تعديل فاتورة طلبية تم تسليمها أو إلغاؤها");
    }

    const { rows: prodRows } = await client.query(
      `SELECT p.id, p.name, p.unit, p.section_id, p.supplier_id, p.purchase_cost,
              p.availability, s.status AS supplier_status
         FROM products p JOIN suppliers s ON s.id = p.supplier_id
        WHERE p.id = $1 AND p.is_active`,
      [body.productId]
    );
    if (!prodRows.length) throw new ApiError(404, "الصنف غير موجود");
    const p = prodRows[0];
    if (p.supplier_status !== "approved") throw new ApiError(400, "المورد غير معتمد حاليًا");
    if (p.availability === "out") throw new ApiError(400, `الصنف غير متوفر: ${p.name}`);

    await assertCustomerSection(order.customer_id, p.section_id);
    const price = await resolvePrice(client, {
      productId: p.id, customerId: order.customer_id, qty: body.qty,
    });

    const { rows: osRows } = await client.query(
      `SELECT id FROM order_suppliers WHERE order_id = $1 AND supplier_id = $2`,
      [order.id, p.supplier_id]
    );
    let orderSupplierId;
    if (osRows.length) {
      orderSupplierId = osRows[0].id;
    } else {
      const { rows: createdOs } = await client.query(
        `INSERT INTO order_suppliers (order_id, supplier_id, subtotal, status)
         VALUES ($1,$2,0, CASE WHEN $3 = 'under_review' THEN 'pending' ELSE 'sent' END)
         RETURNING id`,
        [order.id, p.supplier_id, order.status]
      );
      orderSupplierId = createdOs[0].id;
    }

    const lineTotal = price * body.qty;
    const { rows: [item] } = await client.query(
      `INSERT INTO order_items
         (order_id, order_supplier_id, product_id, product_name, unit,
          unit_price, purchase_cost, qty_requested, qty_confirmed, availability, line_total)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8,'full',$9) RETURNING *`,
      [order.id, orderSupplierId, p.id, p.name, p.unit, price, p.purchase_cost, body.qty, lineTotal]
    );

    await recalcOrderTotals(client, order.id);

    await recordStatus(client, {
      orderId: order.id, from: order.status, to: order.status, actor: req.actor,
      note: `تمت إضافة صنف: ${p.name} × ${body.qty} ${p.unit}`,
    });
    await writeAudit(client, {
      actorType: "employee", actorId: req.actor.id, actorName: req.actor.name,
      action: "order_item.added", entityType: "order_item", entityId: item.id,
      entityLabel: `${order.order_number} — ${p.name}`, after: item, ip: req.ip,
    });

    const { rows: [updatedOrder] } = await client.query(`SELECT * FROM orders WHERE id = $1`, [order.id]);
    return { item, order: updatedOrder };
  });

  res.status(201).json(result);
}));

// تعديل كمية صنف موجود في فاتورة طلبية
orderRouter.patch("/:id/items/:itemId", requirePermission("orders.review"), asyncRoute(async (req, res) => {
  const { qty } = z.object({ qty: z.number().positive() }).parse(req.body);

  const result = await withTransaction(async (client) => {
    const { rows: orderRows } = await client.query(`SELECT * FROM orders WHERE id = $1 FOR UPDATE`, [req.params.id]);
    if (!orderRows.length) throw new ApiError(404, "الطلبية غير موجودة");
    const order = orderRows[0];
    if (["delivered", "cancelled", "closed"].includes(order.status)) {
      throw new ApiError(400, "لا يمكن تعديل فاتورة طلبية تم تسليمها أو إلغاؤها");
    }

    const { rows: itemRows } = await client.query(
      `SELECT * FROM order_items WHERE id = $1 AND order_id = $2 FOR UPDATE`,
      [req.params.itemId, order.id]
    );
    if (!itemRows.length) throw new ApiError(404, "الصنف غير موجود في هذه الطلبية");
    const before = itemRows[0];

    const { rows: [updated] } = await client.query(
      `UPDATE order_items SET qty_requested = $2, qty_confirmed = $2, line_total = unit_price * $2
        WHERE id = $1 RETURNING *`,
      [before.id, qty]
    );

    await recalcOrderTotals(client, order.id);

    await recordStatus(client, {
      orderId: order.id, from: order.status, to: order.status, actor: req.actor,
      note: `تم تعديل كمية صنف: ${before.product_name} — من ${before.qty_requested} إلى ${qty}`,
    });
    await writeAudit(client, {
      actorType: "employee", actorId: req.actor.id, actorName: req.actor.name,
      action: "order_item.qty_updated", entityType: "order_item", entityId: before.id,
      entityLabel: before.product_name, before, after: updated, ip: req.ip,
    });

    const { rows: [updatedOrder] } = await client.query(`SELECT * FROM orders WHERE id = $1`, [order.id]);
    return { item: updated, order: updatedOrder };
  });

  res.json(result);
}));

// حذف صنف من فاتورة طلبية
orderRouter.delete("/:id/items/:itemId", requirePermission("orders.review"), asyncRoute(async (req, res) => {
  const result = await withTransaction(async (client) => {
    const { rows: orderRows } = await client.query(`SELECT * FROM orders WHERE id = $1 FOR UPDATE`, [req.params.id]);
    if (!orderRows.length) throw new ApiError(404, "الطلبية غير موجودة");
    const order = orderRows[0];
    if (["delivered", "cancelled", "closed"].includes(order.status)) {
      throw new ApiError(400, "لا يمكن تعديل فاتورة طلبية تم تسليمها أو إلغاؤها");
    }

    const { rows: itemRows } = await client.query(
      `SELECT * FROM order_items WHERE id = $1 AND order_id = $2 FOR UPDATE`,
      [req.params.itemId, order.id]
    );
    if (!itemRows.length) throw new ApiError(404, "الصنف غير موجود في هذه الطلبية");
    const item = itemRows[0];

    const { rows: [{ total }] } = await client.query(
      `SELECT COUNT(*)::INT AS total FROM order_items WHERE order_id = $1`, [order.id]
    );
    if (Number(total) <= 1) {
      throw new ApiError(400, "لا يمكن حذف آخر صنف في الطلبية — استخدم إلغاء الطلبية بدلاً من ذلك");
    }

    const { rows: [{ count: partCount }] } = await client.query(
      `SELECT COUNT(*)::INT AS count FROM order_items WHERE order_supplier_id = $1`,
      [item.order_supplier_id]
    );

    await client.query(`DELETE FROM order_items WHERE id = $1`, [item.id]);

    if (Number(partCount) <= 1) {
      await client.query(`DELETE FROM order_suppliers WHERE id = $1`, [item.order_supplier_id]);
    }

    await recalcOrderTotals(client, order.id);

    await recordStatus(client, {
      orderId: order.id, from: order.status, to: order.status, actor: req.actor,
      note: `تم حذف صنف: ${item.product_name} × ${item.qty_requested} ${item.unit}`,
    });
    await writeAudit(client, {
      actorType: "employee", actorId: req.actor.id, actorName: req.actor.name,
      action: "order_item.removed", entityType: "order_item", entityId: item.id,
      entityLabel: item.product_name, before: item, ip: req.ip,
    });

    const { rows: [updatedOrder] } = await client.query(`SELECT * FROM orders WHERE id = $1`, [order.id]);
    return { removed: true, order: updatedOrder };
  });

  res.json(result);
}));

