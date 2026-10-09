import { Router } from "express";
import { z } from "zod";
import { query, pool, withTransaction, writeAudit } from "../lib/db.js";
import { ApiError, asyncRoute, nextDocNumber, resolveTreasuryCode } from "../lib/helpers.js";
import { authenticate, requirePermission, requireAnyPermission } from "../middleware/auth.js";
import { queueNotification, notifyStaffWithPermission } from "../lib/notify.js";
import { parseRange, addRange, andClause } from "../lib/dateRange.js";

export const engagementRouter = Router();
engagementRouter.use(authenticate);

// صلاحية الموظف على محادثات الطلبيات: أي صلاحية "طلبيات" (مراجعة/إلغاء/مرتجعات/إسناد مندوب)
function assertEmployeeOrdersAccess(req) {
  return new Promise((resolve, reject) => {
    requireAnyPermission("orders.review", "orders.cancel", "orders.returns", "orders.assign_driver")(
      req, null, (err) => (err ? reject(err) : resolve())
    );
  });
}

// المحادثة إما مع العميل (customer_support) أو مع مورد معيّن (supplier_admin).
// المورد نفسه دايمًا في محادثته الخاصة، والأدمن يحدد أي محادثة يقصدها بوجود
// orderSupplierId من عدمه — بدل ما كل شي كان يسقط على محادثة العميل افتراضيًا
function resolveThreadType(actor, orderSupplierId) {
  if (actor.type === "supplier") return "supplier_admin";
  if (actor.type === "employee" && actor.role === "driver") return "customer_support";
  if (actor.type === "employee" && orderSupplierId) return "supplier_admin";
  return "customer_support";
}

// يتحقق من أن الطرف مشارك فعلًا في هذه المحادثة، ويعيد orderSupplierId النهائي (للمورد يُستنتج من الطلبية لو ما أُرسل).
// - العميل: صاحب الطلبية فقط، وفي محادثة الدعم فقط
// - المورد: لازم له جزء (order_suppliers) في هذه الطلبية، وفي محادثته هو فقط
// - الموظف: بصلاحية طلبيات؛ وأي orderSupplierId لازم يتبع نفس الطلبية
// - المندوب وأي نوع آخر: ممنوع (الكود الحالي ما يقصد فتح المحادثة للمناديب)
async function assertThreadAccess(req, orderId, threadType, orderSupplierId) {
  const actor = req.actor;
  const { rows: ord } = await query(`SELECT id, customer_id, order_number FROM orders WHERE id = $1`, [orderId]);
  if (!ord.length) throw new ApiError(404, "الطلبية غير موجودة");
  const deny = () => new ApiError(403, "لا تملك صلاحية الاطلاع على هذه المحادثة");

  // المندوب: يدردش مع العميل فقط، وفقط على طلبياته المسندة إليه
  if (actor.type === "employee" && actor.role === "driver") {
    const { rows: d } = await query(`SELECT driver_id FROM orders WHERE id = $1`, [orderId]);
    if (threadType !== "customer_support" || d[0]?.driver_id !== actor.id) throw deny();
    return { orderSupplierId: null, order: ord[0] };
  }

  if (actor.type === "employee") {
    await assertEmployeeOrdersAccess(req);
    if (threadType === "supplier_admin") {
      const { rows } = await query(`SELECT 1 FROM order_suppliers WHERE id = $1 AND order_id = $2`, [orderSupplierId, orderId]);
      if (!rows.length) throw new ApiError(400, "فاتورة المورد لا تتبع هذه الطلبية");
    }
    return { orderSupplierId: threadType === "supplier_admin" ? orderSupplierId : null, order: ord[0] };
  }

  if (actor.type === "customer") {
    if (threadType !== "customer_support" || ord[0].customer_id !== actor.id) throw deny();
    return { orderSupplierId: null, order: ord[0] };
  }

  if (actor.type === "supplier") {
    const { rows } = await query(
      `SELECT id FROM order_suppliers WHERE order_id = $1 AND supplier_id = $2`, [orderId, actor.id]
    );
    if (!rows.length) throw deny();
    if (orderSupplierId && orderSupplierId !== rows[0].id) throw deny();
    return { orderSupplierId: rows[0].id, order: ord[0] };
  }

  throw deny(); // مندوب أو غيره
}

engagementRouter.get("/orders/:orderId/messages", asyncRoute(async (req, res) => {
  const threadType = resolveThreadType(req.actor, req.query.orderSupplierId || null);
  const { orderSupplierId } = await assertThreadAccess(req, req.params.orderId, threadType, req.query.orderSupplierId || null);

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
  body: z.string().trim().min(1, "الرسالة فارغة").max(2000, "الرسالة طويلة جدًا — الحد الأقصى 2000 حرف"),
  orderSupplierId: z.string().uuid().optional(),
});

engagementRouter.post("/orders/:orderId/messages", asyncRoute(async (req, res) => {
  const parsed = messageSchema.parse(req.body);
  const requestedOs = parsed.orderSupplierId || null;
  const threadType = resolveThreadType(req.actor, requestedOs);
  const { orderSupplierId, order } = await assertThreadAccess(req, req.params.orderId, threadType, requestedOs);

  const { rows } = await query(
    `INSERT INTO order_messages
       (order_id, order_supplier_id, thread_type, sender_type, sender_id, sender_name, body)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [req.params.orderId, orderSupplierId, threadType,
     req.actor.type, req.actor.id, req.actor.name, parsed.body]
  );

  // الإشعارات ثانوية: فشلها ما يمنع وصول الرسالة
  try {
    if (req.actor.type === "employee") {
      if (threadType === "customer_support") {
        await queueNotification(pool, {
          templateCode: "message.received", recipientType: "customer",
          recipientId: order.customer_id, orderId: req.params.orderId,
          vars: { order_number: order.order_number },
        });
      } else {
        const os = await query(`SELECT supplier_id FROM order_suppliers WHERE id = $1`, [orderSupplierId]);
        if (os.rows.length) {
          await queueNotification(pool, {
            templateCode: "message.received", recipientType: "supplier",
            recipientId: os.rows[0].supplier_id, orderId: req.params.orderId,
            vars: { order_number: order.order_number },
          });
        }
      }
    } else {
      // العميل أو المورد كتب → ينبَّه موظفو الطلبيات داخل لوحة الإدارة (بدون واتساب)
      await notifyStaffWithPermission(pool, {
        permissionCode: "orders.review", templateCode: "message.staff_received",
        orderId: req.params.orderId,
        vars: { order_number: order.order_number, sender: req.actor.name || (req.actor.type === "supplier" ? "مورد" : "عميل") },
      });
      // لو العميل رد → ينبَّه المندوب المسند للطلبية أيضًا
      if (req.actor.type === "customer") {
        const dr = await query(`SELECT driver_id FROM orders WHERE id = $1`, [req.params.orderId]);
        if (dr.rows[0]?.driver_id) {
          await queueNotification(pool, {
            templateCode: "message.staff_received", recipientType: "employee",
            recipientId: dr.rows[0].driver_id, orderId: req.params.orderId,
            vars: { order_number: order.order_number, sender: req.actor.name || "عميل" },
          });
        }
      }
    }
  } catch (e) {
    console.error("[CHAT_NOTIFY]", e);
  }

  res.status(201).json(rows[0]);
}));

/* ===================================================================
   شكاوي المندوبين (تكت على الطلبية): المندوب يفتح شكوى على طلبيته (الطلبية ما توصلتش، العميل ما يردش...)
   وتظهر للإدارة في قسم خاص بها داخل سجل الطلبية، وتقدر تقفلها بملاحظة.
   الجدول: order_driver_complaints (يُنشأ بسكريبت SQL مرّة وحدة — انظر db/order_driver_complaints.sql)
=================================================================== */

const DRIVER_COMPLAINT_KINDS = ["not_delivered", "customer_unreachable", "wrong_address", "customer_refused", "supplier_issue", "other"];

const isDriver = (actor) => actor.type === "employee" && actor.role === "driver";

// جدول الشكاوي غير موجود بعد (لم يُشغَّل سكريبت الإنشاء): نرجّع رسالة واضحة بدل خطأ عام
function missingTableGuard(e) {
  if (e?.code === "42P01") throw new ApiError(503, "ميزة شكاوي المندوب لم تُفعَّل بعد (جدول الشكاوي غير موجود في قاعدة البيانات)");
  throw e;
}

engagementRouter.post("/orders/:orderId/driver-complaints", asyncRoute(async (req, res) => {
  if (!isDriver(req.actor)) throw new ApiError(403, "هذا الإجراء مخصص للمناديب");
  const body = z.object({
    kind: z.enum(DRIVER_COMPLAINT_KINDS),
    note: z.string().trim().max(1000, "الملاحظة طويلة جدًا — الحد الأقصى 1000 حرف").optional(),
  }).parse(req.body);
  if (body.kind === "other" && (!body.note || body.note.length < 3)) {
    throw new ApiError(400, "اكتب تفاصيل الشكوى");
  }
  if (body.kind === "customer_refused" && !body.note) {
    throw new ApiError(400, "اختر سبب رفض العميل للاستلام");
  }

  const { rows: [order] } = await query(
    `SELECT id, order_number, driver_id FROM orders WHERE id = $1`, [req.params.orderId]
  );
  if (!order) throw new ApiError(404, "الطلبية غير موجودة");
  if (order.driver_id !== req.actor.id) throw new ApiError(403, "هذه الطلبية ليست مسندة لك");

  let row;
  try {
    ({ rows: [row] } = await query(
      `INSERT INTO order_driver_complaints (order_id, driver_id, kind, note)
       VALUES ($1,$2,$3,$4) RETURNING *`,
      [order.id, req.actor.id, body.kind, body.note || null]
    ));
  } catch (e) { missingTableGuard(e); }

  // التنبيه ثانوي: فشله ما يمنع تسجيل الشكوى
  try {
    await notifyStaffWithPermission(pool, {
      permissionCode: "orders.review", templateCode: "message.staff_received",
      orderId: order.id,
      vars: { order_number: order.order_number, sender: `المندوب ${req.actor.name || ""}`.trim() },
    });
  } catch (e) {
    console.error("[DRIVER_COMPLAINT_NOTIFY]", e);
  }

  res.status(201).json(row);
}));

engagementRouter.get("/orders/:orderId/driver-complaints", asyncRoute(async (req, res) => {
  const { rows: [order] } = await query(`SELECT id, driver_id FROM orders WHERE id = $1`, [req.params.orderId]);
  if (!order) throw new ApiError(404, "الطلبية غير موجودة");
  if (isDriver(req.actor)) {
    if (order.driver_id !== req.actor.id) throw new ApiError(403, "هذه الطلبية ليست مسندة لك");
  } else if (req.actor.type === "employee") {
    await assertEmployeeOrdersAccess(req);
  } else {
    throw new ApiError(403, "لا تملك صلاحية الاطلاع على شكاوي المندوب");
  }
  try {
    const { rows } = await query(
      `SELECT c.*, e.name AS driver_name
         FROM order_driver_complaints c
         LEFT JOIN employees e ON e.id = c.driver_id
        WHERE c.order_id = $1
        ORDER BY c.created_at DESC`,
      [order.id]
    );
    res.json(rows);
  } catch (e) {
    if (e?.code === "42P01") return res.json([]); // الميزة لم تُفعَّل بعد → قائمة فاضية بدل خطأ
    throw e;
  }
}));

engagementRouter.patch("/driver-complaints/:id/close", requirePermission("orders.review"), asyncRoute(async (req, res) => {
  const body = z.object({
    note: z.string().trim().max(1000, "الملاحظة طويلة جدًا — الحد الأقصى 1000 حرف").optional(),
  }).parse(req.body ?? {});
  let row;
  try {
    ({ rows: [row] } = await query(
      `UPDATE order_driver_complaints
          SET status = 'closed', admin_note = $2, closed_by = $3, closed_at = now()
        WHERE id = $1 AND status = 'open' RETURNING *`,
      [req.params.id, body.note || null, req.actor.id]
    ));
  } catch (e) { missingTableGuard(e); }
  if (!row) throw new ApiError(404, "الشكوى غير موجودة أو مقفلة مسبقًا");
  res.json(row);
}));

const feedbackSchema = z.object({
  orderId: z.string().uuid(),
  rating: z.number().int().min(1).max(5).optional(),
  about: z.enum(["delivery", "supplier", "quality", "service"]).optional(),
  supplierId: z.string().uuid().optional(),
  comment: z.string().trim().max(1000, "الملاحظة طويلة جدًا — الحد الأقصى 1000 حرف").optional(),
});

engagementRouter.post("/feedback", asyncRoute(async (req, res) => {
  if (req.actor.type !== "customer") throw new ApiError(403, "هذا الإجراء مخصص للعملاء");
  const body = feedbackSchema.parse(req.body);

  const order = await query(
    `SELECT id FROM orders WHERE id = $1 AND customer_id = $2 AND status IN ('delivered','closed')`,
    [body.orderId, req.actor.id]
  );
  if (!order.rows.length) throw new ApiError(400, "لا يمكن التقييم إلا بعد تسليم الطلبية");

  // المورد المقيَّم لازم يكون أحد موردي هذه الطلبية فعلًا
  if (body.supplierId) {
    const sup = await query(
      `SELECT 1 FROM order_suppliers WHERE order_id = $1 AND supplier_id = $2`, [body.orderId, body.supplierId]
    );
    if (!sup.rows.length) throw new ApiError(400, "هذا المورد ليس من موردي هذه الطلبية");
  }

  const already = await query(
    `SELECT 1 FROM order_feedback WHERE order_id = $1 AND customer_id = $2`, [body.orderId, req.actor.id]
  );
  if (already.rows.length) throw new ApiError(409, "سبق أن أرسلت تقييمك لهذه الطلبية");

  try {
    const { rows } = await query(
      `INSERT INTO order_feedback (order_id, customer_id, rating, about, supplier_id, comment)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [body.orderId, req.actor.id, body.rating ?? null, body.about ?? null, body.supplierId ?? null, body.comment || null]
    );
    res.status(201).json(rows[0]);
  } catch (e) {
    if (e?.code === "23505") throw new ApiError(409, "سبق أن أرسلت تقييمك لهذه الطلبية");
    throw e;
  }
}));

engagementRouter.get("/feedback", requirePermission("orders.review"), asyncRoute(async (req, res) => {
  const { status } = req.query;
  const params = [status || null];
  const conds = addRange("f.created_at", parseRange(req.query), params, []);
  const { rows } = await query(
    `SELECT f.*, o.order_number, c.business_name AS customer_name, s.business_name AS supplier_name
       FROM order_feedback f
       JOIN orders o     ON o.id = f.order_id
       JOIN customers c  ON c.id = f.customer_id
       LEFT JOIN suppliers s ON s.id = f.supplier_id
      WHERE ($1::TEXT IS NULL OR f.resolution_status = $1)${andClause(conds)}
      ORDER BY f.created_at DESC`,
    params
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

// جرس الإشعارات — كل حساب (مورد/عميل/موظف) يشوف إشعاراته هو بس
engagementRouter.get("/notifications", asyncRoute(async (req, res) => {
  const { rows } = await query(
    `SELECT * FROM notifications
      WHERE recipient_type = $1 AND recipient_id = $2
      ORDER BY created_at DESC
      LIMIT 100`,
    [req.actor.type, req.actor.id]
  );
  const unreadCount = rows.filter((n) => !n.in_app_read_at).length;
  res.json({ notifications: rows, unreadCount });
}));

engagementRouter.patch("/notifications/:id/read", asyncRoute(async (req, res) => {
  const { rows } = await query(
    `UPDATE notifications SET in_app_read_at = now()
      WHERE id = $1 AND recipient_type = $2 AND recipient_id = $3 AND in_app_read_at IS NULL
     RETURNING *`,
    [req.params.id, req.actor.type, req.actor.id]
  );
  res.json(rows[0] || { alreadyRead: true });
}));

engagementRouter.post("/notifications/read-all", asyncRoute(async (req, res) => {
  await query(
    `UPDATE notifications SET in_app_read_at = now()
      WHERE recipient_type = $1 AND recipient_id = $2 AND in_app_read_at IS NULL`,
    [req.actor.type, req.actor.id]
  );
  res.json({ done: true });
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

engagementRouter.post("/returns", requirePermission("orders.returns"), asyncRoute(async (req, res) => {
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
        `SELECT unit_price, COALESCE(qty_confirmed, qty_requested) AS qty_ok FROM order_items WHERE id = $1 AND order_id = $2`, [item.orderItemId, body.orderId]
      );
      if (!oi.rows.length) throw new ApiError(400, "صنف غير موجود في هذه الطلبية");
      const prev = await client.query(
        `SELECT COALESCE(SUM(ri.qty),0) AS q FROM return_items ri JOIN returns r ON r.id = ri.return_id
          WHERE ri.order_item_id = $1 AND r.status <> 'rejected'`, [item.orderItemId]
      );
      if (Number(prev.rows[0].q) + Number(item.qty) > Number(oi.rows[0].qty_ok)) {
        throw new ApiError(400, "كمية الإرجاع أكبر من الكمية المسلّمة (بعد خصم المرتجعات السابقة)");
      }
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

engagementRouter.get("/returns", requirePermission("orders.returns"), asyncRoute(async (req, res) => {
  const { status } = req.query;
  const params = [status || null];
  const conds = addRange("r.created_at", parseRange(req.query), params, []);
  const { rows } = await query(
    `SELECT r.*, o.order_number, c.business_name AS customer_name, s.business_name AS supplier_name,
            (SELECT SUM(line_total) FROM return_items WHERE return_id = r.id) AS total
       FROM returns r
       JOIN orders o     ON o.id = r.order_id
       JOIN customers c  ON c.id = r.customer_id
       LEFT JOIN suppliers s ON s.id = r.supplier_id
      WHERE ($1::TEXT IS NULL OR r.status = $1)${andClause(conds)}
      ORDER BY r.created_at DESC`,
    params
  );
  res.json(rows);
}));

engagementRouter.patch("/returns/:id/status", requirePermission("orders.returns"), asyncRoute(async (req, res) => {
  const body = z.object({
    status: z.enum(["approved", "rejected", "received", "refunded"]),
    refundMethod: z.enum(["cash", "credit_note", "replacement"]).optional(),
  }).parse(req.body);

  const result = await withTransaction(async (client) => {
    const before = await client.query(`SELECT * FROM returns WHERE id = $1 FOR UPDATE`, [req.params.id]);
    if (!before.rows.length) throw new ApiError(404, "طلب الإرجاع غير موجود");
    if (["refunded", "rejected"].includes(before.rows[0].status)) {
      throw new ApiError(409, "طلب الإرجاع مُغلق ولا يمكن تغيير حالته");
    }

    let refundAmount = before.rows[0].refund_amount;
    let refundVoucherId = before.rows[0].refund_voucher_id;
    if (body.status === "refunded") {
      const total = await client.query(`SELECT SUM(line_total) AS total FROM return_items WHERE return_id = $1`, [req.params.id]);
      refundAmount = Number(total.rows[0].total || 0);
      
if (refundAmount > 0 && body.refundMethod === "credit_note") {
await client.query(
`UPDATE orders SET paid_amount = paid_amount + $2,
payment_status = CASE WHEN paid_amount + $2 >= grand_total THEN 'paid' ELSE 'partially_paid' END
WHERE id = $1`,
[before.rows[0].order_id, refundAmount]
);
} else if (refundAmount > 0 && (body.refundMethod === "cash" || !body.refundMethod)) {
const treasuryCode = resolveTreasuryCode("payment", "cash");
const { rows: tr } = await client.query(`SELECT id FROM treasuries WHERE code = $1`, [treasuryCode]);
if (tr.length) {
const voucherNumber = await nextDocNumber(client, {
table: "vouchers", column: "voucher_number", prefix: "V", start: 1000,
});
const { rows: custRows } = await client.query(`SELECT business_name FROM customers WHERE id = $1`, [before.rows[0].customer_id]);
const { rows: [voucher] } = await client.query(
`INSERT INTO vouchers
(voucher_number, voucher_type, party_type, party_id, party_name,
amount, method, treasury_id, order_id, approval_status, approved_by, approved_at, note, created_by)
VALUES ($1,'payment','customer',$2,$3,$4,'cash',$5,$6,'approved',$8,now(),$7,$8)
RETURNING *`,
[voucherNumber, before.rows[0].customer_id, custRows[0]?.business_name || "", refundAmount,
tr[0].id, before.rows[0].order_id, `استرجاع نقدي - ${before.rows[0].return_number}`, req.actor.id]
);
refundVoucherId = voucher.id;
}
}
    }

    const { rows } = await client.query(
      `UPDATE returns SET status = $2, refund_method = COALESCE($3, refund_method),
              refund_amount = $4, refund_voucher_id = $5, approved_by = $6
       WHERE id = $1 RETURNING *`,
            [req.params.id, body.status, body.refundMethod ?? null, refundAmount, refundVoucherId, req.actor.id]
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
