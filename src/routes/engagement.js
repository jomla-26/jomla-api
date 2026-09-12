import { Router } from "express";
import { z } from "zod";
import { query, pool, withTransaction, writeAudit } from "../lib/db.js";
import { ApiError, asyncRoute, nextDocNumber } from "../lib/helpers.js";
import { authenticate, requirePermission } from "../middleware/auth.js";
import { queueNotification } from "../lib/notify.js";

export const engagementRouter = Router();
engagementRouter.use(authenticate);

async function assertThreadAccess(actor, orderId, threadType, orderSupplierId) {
  if (actor.type === "employee") return;
  if (actor.type === "customer" && threadType === "customer_support") {
    const { rows } = await query(`SELECT 1 FROM orders WHERE id = $1 AND customer_id = $2`, [orderId, actor.id]);
    if (!rows.length) throw new ApiError(403, "لا تملك صلاحية الاطلاع على هذه المحادثة");
    return;
  }
  if (actor.type === "supplier" && threadType === "supplier_admin") {
    const { rows } = await query(
      `SELECT 1 FROM order_suppliers WHERE id = $1 AND supplier_id = $2`, [orderSupplierId, actor.id]
    );
    if (!rows.length) throw new ApiError(403, "لا تملك صلاحية الاطلاع على هذه المحادثة");
    return;
  }
  throw new ApiError(403, "لا تملك صلاحية الاطلاع على هذه المحادثة");
}

engagementRouter.get("/orders/:orderId/messages", asyncRoute(async (req, res) => {
  const threadType = req.actor.type === "supplier" ? "supplier_admin" : "customer_support";
  const orderSupplierId = req.query.orderSupplierId || null;
  await assertThreadAccess(req.actor, req.params.orderId, threadType, orderSupplierId);

  const { rows } = await query(
    `SELECT * FROM order_messages
      WHERE order_id = $1 AND thread_type = $2
        AND ($3::UUID IS NULL OR order_supplier_id = $3)
      ORDER BY created_at`,
    [req.params.orderId, threadType, orderSupplierId]
  );
  res.json(rows);
}));

const messageSchema = z.object({
  body: z.string().min(1),
  orderSupplierId: z.string().uuid().optional(),
});

engagementRouter.post("/orders/:orderId/messages", asyncRoute(async (req, res) => {
  const parsed = messageSchema.parse(req.body);
  const threadType = req.actor.type === "supplier" ? "supplier_admin" : "customer_support";
  await assertThreadAccess(req.actor, req.params.orderId, threadType, parsed.orderSupplierId || null);

  const { rows } = await query(
    `INSERT INTO order_messages
       (order_id, order_supplier_id, thread_type, sender_type, sender_id, sender_name, body)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [req.params.orderId, parsed.orderSupplierId ?? null, threadType,
     req.actor.type, req.actor.id, req.actor.name, parsed.body]
  );

  if (req.actor.type === "employee") {
    if (threadType === "customer_support") {
      const o = await query(`SELECT customer_id, order_number FROM orders WHERE id = $1`, [req.params.orderId]);
      if (o.rows.length) {
        await queueNotification(pool, {
          templateCode: "message.received", recipientType: "customer",
          recipientId: o.rows[0].customer_id, orderId: req.params.orderId,
          vars: { order_number: o.rows[0].order_number },
        });
      }
    } else if (parsed.orderSupplierId) {
      const os = await query(
        `SELECT os.supplier_id, o.order_number FROM order_suppliers os
           JOIN orders o ON o.id = os.order_id WHERE os.id = $1`,
        [parsed.orderSupplierId]
      );
      if (os.rows.length) {
        await queueNotification(pool, {
          templateCode: "message.received", recipientType: "supplier",
          recipientId: os.rows[0].supplier_id, orderId: req.params.orderId,
          vars: { order_number: os.rows[0].order_number },
        });
      }
    }
  }

  res.status(201).json(rows[0]);
}));

const feedbackSchema = z.object({
  orderId: z.string().uuid(),
  rating: z.number().int().min(1).max(5).optional(),
  about: z.enum(["delivery", "supplier", "quality", "service"]).optional(),
  supplierId: z.string().uuid().optional(),
  comment: z.string().optional(),
});

engagementRouter.post("/feedback", asyncRoute(async (req, res) => {
  if (req.actor.type !== "customer") throw new ApiError(403, "هذا الإجراء مخصص للعملاء");
  const body = feedbackSchema.parse(req.body);

  const order = await query(
    `SELECT id FROM orders WHERE id = $1 AND customer_id = $2 AND status IN ('delivered','closed')`,
    [body.orderId, req.actor.id]
  );
  if (!order.rows.length) throw new ApiError(400, "لا يمكن التقييم إلا بعد تسليم الطلبية");

  const { rows } = await query(
    `INSERT INTO order_feedback (order_id, customer_id, rating, about, supplier_id, comment)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [body.orderId, req.actor.id, body.rating ?? null, body.about ?? null, body.supplierId ?? null, body.comment ?? null]
  );
  res.status(201).json(rows[0]);
}));

engagementRouter.get("/feedback", requirePermission("orders.review"), asyncRoute(async (req, res) => {
  const { status } = req.query;
  const { rows } = await query(
    `SELECT f.*, o.order_number, c.business_name AS customer_name, s.business_name AS supplier_name
       FROM order_feedback f
       JOIN orders o     ON o.id = f.order_id
       JOIN customers c  ON c.id = f.customer_id
       LEFT JOIN suppliers s ON s.id = f.supplier_id
      WHERE ($1::TEXT IS NULL OR f.resolution_status = $1)
      ORDER BY f.created_at DESC`,
    [status || null]
  );
  res.json(rows);
}));

engagementRouter.patch("/feedback/:id/resolve", requirePermission("orders.review"), asyncRoute(async (req, res) => {
  const body = z.object({
    resolutionType: z.enum(["replacement", "discount", "credit_note", "no_action"]),
    resolutionAmount: z.number().nonnegative().optional(),
  }).parse(req.body);

  const { rows } = await query(
    `UPDATE order_feedback SET
       resolution_status = 'resolved', resolution_type = $2, resolution_amount = $3,
       handled_by = $4, resolved_at = now()
     WHERE id = $1 RETURNING *`,
    [req.params.id, body.resolutionType, body.resolutionAmount ?? null, req.actor.id]
  );
  if (!rows.length) throw new ApiError(404, "الملاحظة غير موجودة");

  const withOrder = await query(
    `SELECT f.customer_id, o.order_number FROM order_feedback f
       JOIN orders o ON o.id = f.order_id WHERE f.id = $1`,
    [req.params.id]
  );
  if (withOrder.rows.length) {
    await queueNotification(pool, {
      templateCode: "feedback.resolved", recipientType: "customer",
      recipientId: withOrder.rows[0].customer_id, orderId: rows[0].order_id,
      vars: { order_number: withOrder.rows[0].order_number },
    });
  }

  res.json(rows[0]);
}));

engagementRouter.get("/favorites", asyncRoute(async (req, res) => {
  if (req.actor.type !== "customer") throw new ApiError(403, "هذا الإجراء مخصص للعملاء");
  const { rows } = await query(
    `SELECT p.*, s.business_name AS supplier_name
       FROM customer_favorites cf
       JOIN products p  ON p.id = cf.product_id
       JOIN suppliers s ON s.id = p.supplier_id
      WHERE cf.customer_id = $1
      ORDER BY cf.added_at DESC`,
    [req.actor.id]
  );
  res.json(rows);
}));

engagementRouter.post("/favorites/:productId", asyncRoute(async (req, res) => {
  if (req.actor.type !== "customer") throw new ApiError(403, "هذا الإجراء مخصص للعملاء");
  await query(
    `INSERT INTO customer_favorites (customer_id, product_id) VALUES ($1,$2)
     ON CONFLICT DO NOTHING`,
    [req.actor.id, req.params.productId]
  );
  res.status(201).json({ added: true });
}));

engagementRouter.delete("/favorites/:productId", asyncRoute(async (req, res) => {
  if (req.actor.type !== "customer") throw new ApiError(403, "هذا الإجراء مخصص للعملاء");
  await query(`DELETE FROM customer_favorites WHERE customer_id = $1 AND product_id = $2`, [req.actor.id, req.params.productId]);
  res.json({ removed: true });
}));

const returnSchema = z.object({
  orderId: z.string().uuid(),
  supplierId: z.string().uuid().optional(),
  reason: z.string().min(2),
  items: z.array(z.object({
    orderItemId: z.string().uuid(),
    qty: z.number().positive(),
  })).min(1),
});

engagementRouter.post("/returns", asyncRoute(async (req, res) => {
  const body = returnSchema.parse(req.body);
  const isCustomer = req.actor.type === "customer";
  const isEmployee = req.actor.type === "employee";
  if (!isCustomer && !isEmployee) throw new ApiError(403, "لا تملك صلاحية تقديم طلب إرجاع");

  const ret = await withTransaction(async (client) => {
    const order = await client.query(
      `SELECT id, customer_id FROM orders WHERE id = $1 AND status IN ('delivered','closed')`, [body.orderId]
    );
    if (!order.rows.length) throw new ApiError(400, "لا يمكن الإرجاع إلا لطلبية مُسلَّمة");
    if (isCustomer && order.rows[0].customer_id !== req.actor.id) {
      throw new ApiError(403, "هذه الطلبية ليست لحسابك");
    }

    const number = await nextDocNumber(client, {
      table: "returns", column: "return_number", prefix: "RET", start: 1000,
    });
    const { rows } = await client.query(
      `INSERT INTO returns (return_number, order_id, customer_id, supplier_id, reason)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [number, body.orderId, order.rows[0].customer_id, body.supplierId ?? null, body.reason]
    );
    const created = rows[0];

    for (const item of body.items) {
      const oi = await client.query(
        `SELECT unit_price FROM order_items WHERE id = $1 AND order_id = $2`, [item.orderItemId, body.orderId]
      );
      if (!oi.rows.length) throw new ApiError(400, "صنف غير موجود في هذه الطلبية");
      await client.query(
        `INSERT INTO return_items (return_id, order_item_id, qty, unit_price, line_total)
         VALUES ($1,$2,$3,$4,$5)`,
        [created.id, item.orderItemId, item.qty, oi.rows[0].unit_price, oi.rows[0].unit_price * item.qty]
      );
    }

    await writeAudit(client, {
      actorType: req.actor.type, actorId: req.actor.id, actorName: req.actor.name,
      action: "return.requested", entityType: "return", entityId: created.id,
      entityLabel: number, after: created, ip: req.ip,
    });
    return created;
  });

  res.status(201).json(ret);
}));

engagementRouter.get("/returns", requirePermission("orders.review"), asyncRoute(async (req, res) => {
  const { status } = req.query;
  const { rows } = await query(
    `SELECT r.*, o.order_number, c.business_name AS customer_name, s.business_name AS supplier_name,
            (SELECT SUM(line_total) FROM return_items WHERE return_id = r.id) AS total
       FROM returns r
       JOIN orders o     ON o.id = r.order_id
       JOIN customers c  ON c.id = r.customer_id
       LEFT JOIN suppliers s ON s.id = r.supplier_id
      WHERE ($1::TEXT IS NULL OR r.status = $1)
      ORDER BY r.created_at DESC`,
    [status || null]
  );
  res.json(rows);
}));

engagementRouter.patch("/returns/:id/status", requirePermission("orders.review"), asyncRoute(async (req, res) => {
  const body = z.object({
    status: z.enum(["approved", "rejected", "received", "refunded"]),
    refundMethod: z.enum(["cash", "credit_note", "replacement"]).optional(),
  }).parse(req.body);

  const result = await withTransaction(async (client) => {
    const before = await client.query(`SELECT * FROM returns WHERE id = $1 FOR UPDATE`, [req.params.id]);
    if (!before.rows.length) throw new ApiError(404, "طلب الإرجاع غير موجود");

    let refundAmount = before.rows[0].refund_amount;
    if (body.status === "refunded") {
      const total = await client.query(`SELECT SUM(line_total) AS total FROM return_items WHERE return_id = $1`, [req.params.id]);
      refundAmount = Number(total.rows[0].total || 0);
    }

    const { rows } = await client.query(
      `UPDATE returns SET status = $2, refund_method = COALESCE($3, refund_method),
              refund_amount = $4, approved_by = $5
       WHERE id = $1 RETURNING *`,
      [req.params.id, body.status, body.refundMethod ?? null, refundAmount, req.actor.id]
    );

    await writeAudit(client, {
      actorType: "employee", actorId: req.actor.id, actorName: req.actor.name,
      action: "return.status_changed", entityType: "return", entityId: req.params.id,
      before: before.rows[0], after: rows[0], ip: req.ip,
    });

    const o = await client.query(`SELECT order_number FROM orders WHERE id = $1`, [rows[0].order_id]);
    await queueNotification(client, {
      templateCode: "return.decision", recipientType: "customer",
      recipientId: rows[0].customer_id, orderId: rows[0].order_id,
      vars: { return_number: rows[0].return_number, status: body.status, order_number: o.rows[0]?.order_number || "" },
    });

    return rows[0];
  });

  res.json(result);
}));
