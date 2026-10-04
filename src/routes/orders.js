import { Router } from "express";
import { z } from "zod";
import { pool, query, withTransaction, writeAudit } from "../lib/db.js";
import {
  restoreOrderStock, adjustStock, stockReasons, round2, round3,
  ApiError, asyncRoute, nextDocNumber, resolvePrice, calcDeliveryFee, resolveTreasuryCode,
} from "../lib/helpers.js";
import {
  authenticate, requirePermission, requireActorType, assertCustomerSection, getEmployeeSectionScope,
} from "../middleware/auth.js";
import { queueNotification, notifyStaffWithPermission } from "../lib/notify.js";

export const orderRouter = Router();
orderRouter.use(authenticate);

/* ===================================================================
   ثوابت وأدوات مشتركة
=================================================================== */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v) => typeof v === "string" && UUID_RE.test(v);

// أي معرّف في المسار لازم يكون UUID صحيح — بدل ما يوصل لقاعدة البيانات ويطلع خطأ 500
orderRouter.param("id", (_req, _res, next, id) =>
  isUuid(id) ? next() : next(new ApiError(404, "غير موجود")));
orderRouter.param("osId", (_req, _res, next, id) =>
  isUuid(id) ? next() : next(new ApiError(404, "غير موجود")));
orderRouter.param("itemId", (_req, _res, next, id) =>
  isUuid(id) ? next() : next(new ApiError(404, "غير موجود")));

const TERMINAL = ["delivered", "closed", "cancelled"];
// حالات جزء المورد قبل تأكيد التوفر (المخزون لسا ما اتخصمش)
const PART_UNCONFIRMED = ["pending", "sent"];
// صلاحيات تسمح لموظف بالاطلاع على الطلبيات (المندوب له مسار منفصل: طلبياته فقط)
const STAFF_VIEW_PERMS = [
  "orders.review", "orders.cancel", "orders.assign_driver", "orders.returns",
  "finance.vouchers", "reports.view",
];
// طرق دفع يستلم فيها المورد المبلغ نقدًا عند تسليم الاستلام الشخصي
const CASH_LIKE = ["pay_at_supplier", "cash", "card"];

const STATUS_AR = {
  draft: "مسودة", under_review: "قيد المراجعة", approved: "معتمدة",
  sent_to_supplier: "مرسلة إلى المورد", supplier_preparing: "قيد التجهيز",
  shortage: "يوجد نقص", ready: "جاهزة", ready_for_delivery: "جاهزة للتوصيل",
  ready_for_pickup: "جاهزة للاستلام", assigned_to_driver: "مسندة لمندوب",
  out_for_delivery: "في الطريق", awaiting_pickup: "بانتظار الاستلام",
  delivered: "تم التسليم", closed: "مقفولة", postponed: "مؤجلة", cancelled: "ملغاة",
};
const statusAr = (s) => STATUS_AR[s] || s;

// وحدات تُباع بالكسور (وزن/حجم/طول) — غيرها لازم تكون كمية صحيحة
const FRACTIONAL_UNIT_RE = /(كغ|كجم|كيلو|كلغ|غرام|جرام|غم|لتر|متر|طن|\bkg\b|\bg\b|\bl\b|\bm\b|liter|litre|meter|metre|ton)/i;
const isFractionalUnit = (u) => FRACTIONAL_UNIT_RE.test(String(u || ""));
const MAX_LINE_QTY = 100000;

function assertQtyForUnit(qty, unit, label) {
  if (!(qty > 0) || qty > MAX_LINE_QTY) throw new ApiError(400, `كمية غير صالحة للصنف: ${label}`);
  if (!isFractionalUnit(unit) && !Number.isInteger(qty)) {
    throw new ApiError(400, `الكمية لازم تكون رقم صحيح للصنف: ${label}`);
  }
}

function parsePaging(q) {
  const limit = Math.min(Math.max(parseInt(q.limit, 10) || 200, 1), 500);
  const offset = Math.max(parseInt(q.offset, 10) || 0, 0);
  return { limit, offset };
}

async function recordStatus(client, { orderId, orderSupplierId = null, from, to, actor, note = null }) {
  await client.query(
    `INSERT INTO order_status_history
       (order_id, order_supplier_id, from_status, to_status, changed_by, changed_by_name, note)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [orderId, orderSupplierId, from, to, actor.id, actor.name, note]
  );
}

// هل الموظف عنده أي صلاحية من القائمة فعليًا (مع احترام الاستثناءات الفردية وحالة الحساب)
async function employeeHasAny(employeeId, codes) {
  const { rows } = await query(
    `SELECT 1
       FROM permissions p
      WHERE p.code = ANY($2::TEXT[])
        AND EXISTS (SELECT 1 FROM employees WHERE id = $1 AND is_active)
        AND COALESCE(
              (SELECT o.granted FROM employee_permission_overrides o
                WHERE o.employee_id = $1 AND o.permission_id = p.id),
              EXISTS (SELECT 1 FROM role_permissions rp JOIN employees e ON e.role_id = rp.role_id
                       WHERE e.id = $1 AND rp.permission_id = p.id)
            )
      LIMIT 1`,
    [employeeId, codes]
  );
  return rows.length > 0;
}

// نطاق الأقسام: موظف مقيّد بأقسام يتعامل بس مع الطلبيات اللي كل أصنافها ضمن نطاقه
async function orderInEmployeeScope(employeeId, orderId) {
  const scope = await getEmployeeSectionScope(employeeId);
  if (scope === null) return true;
  const { rows } = await query(
    `SELECT DISTINCT p.section_id FROM order_items oi JOIN products p ON p.id = oi.product_id
      WHERE oi.order_id = $1`,
    [orderId]
  );
  return rows.every((r) => scope.has(r.section_id));
}

const OUT_OF_SCOPE_MSG = "الطلبية تحتوي على صنف من قسم خارج نطاق صلاحياتك";

const requireOrderScope = asyncRoute(async (req, _res, next) => {
  if (req.actor.type === "employee" && !(await orderInEmployeeScope(req.actor.id, req.params.id))) {
    throw new ApiError(403, OUT_OF_SCOPE_MSG);
  }
  next();
});

// نصيب جزء المورد من المبلغ المتبقي على العميل (للاستلام الشخصي).
// لو الطلبية فيها أكثر من مورد والإدارة ما حددت مورد يستلم المتبقي: المتبقي يتقسم بنسبة قيمة كل جزء لسه ما اتسلمش،
// وآخر جزء مفتوح ياخذ كل اللي فضل. لو الطلبية خالصة يرجع 0.
function computePartDue(order, parts, part) {
  if (!part || part.pickup_confirmed || part.status === "cancelled") return 0;
  const remaining = Math.max(0, round2(Number(order.grand_total) - Number(order.paid_amount)));
  if (remaining <= 0) return 0;
  const open = parts.filter((p) => !p.pickup_confirmed && p.status !== "cancelled");
  const openTotal = open.reduce((sum, p) => sum + Number(p.subtotal || 0), 0);
  if (open.length <= 1 || openTotal <= 0) return remaining;
  // لو الإدارة حددت مورد بعينه يستلم المتبقي كامل، هو بس اللي عليه التحصيل والباقي ما عليهم شي
  const collector = order.remaining_collector_id;
  if (collector && open.some((p) => p.supplier_id === collector)) {
    return part.supplier_id === collector ? remaining : 0;
  }
  return round2((remaining * Number(part.subtotal || 0)) / openTotal);
}

// المطلوب من المورد استلامه عند تسليم الاستلام الشخصي
function partDueNow(order, parts, part) {
  if (order.fulfillment !== "pickup" || !part || part.pickup_confirmed || part.status === "cancelled") return 0;
  if (CASH_LIKE.includes(order.payment_method)) return round2(part.subtotal);
  if (order.payment_method === "deferred") return 0;
  return computePartDue(order, parts, part);
}

// المبلغ المطلوب تحصيله من المندوب عند التسليم (المتبقي على العميل، أو العربون للآجل)
function computeCod(order) {
  const remaining = Math.max(0, round2(Number(order.grand_total) - Number(order.paid_amount)));
  if (order.payment_method === "deferred") {
    return Math.min(remaining, Math.max(0, Number(order.deposit_due_at_delivery || 0)));
  }
  return remaining;
}

// حذف أجزاء الموردين الفاضية (بعد حذف كل أصنافها). السجلات المرتبطة (سجل الحالة/الرسائل) نفك ارتباطها
// أولًا؛ ولو فشل الحذف لأي قيد آخر نكتفي بتعليم الجزء "ملغى" بدل ما نفشّل العملية كلها
async function removeEmptyParts(client, orderId) {
  const { rows: empty } = await client.query(
    `SELECT os.id FROM order_suppliers os
      WHERE os.order_id = $1 AND NOT EXISTS (SELECT 1 FROM order_items oi WHERE oi.order_supplier_id = os.id)`,
    [orderId]
  );
  for (const { id } of empty) {
    await client.query("SAVEPOINT rm_empty_part");
    try {
      await client.query(`UPDATE order_status_history SET order_supplier_id = NULL WHERE order_supplier_id = $1`, [id]);
      await client.query(`UPDATE order_messages SET order_supplier_id = NULL WHERE order_supplier_id = $1`, [id]);
      await client.query(`DELETE FROM order_suppliers WHERE id = $1`, [id]);
      await client.query("RELEASE SAVEPOINT rm_empty_part");
    } catch {
      await client.query("ROLLBACK TO SAVEPOINT rm_empty_part");
      await client.query(`UPDATE order_suppliers SET status = 'cancelled', subtotal = 0 WHERE id = $1`, [id]);
      await client.query("RELEASE SAVEPOINT rm_empty_part");
    }
  }
}

// إعادة حساب كل المبالغ بعد أي تعديل على الأصناف: إجمالي كل جزء، رسوم التوصيل (من الموردين
// اللي لسا عندهم أصناف، إلا لو الإدارة عدّلتها يدويًا)، إجمالي الطلبية، حالة الدفع، والمطلوب من المندوب
// refreshFee=false: يبقي رسوم التوصيل الحالية (مثلًا عند تأكيد توفر المورد — ما تغيّر شي في الموردين)
async function recalcOrderTotals(client, orderId, { refreshFee = true } = {}) {
  await removeEmptyParts(client, orderId);

  await client.query(
    `UPDATE order_suppliers os SET subtotal = sub.total
       FROM (SELECT order_supplier_id, ROUND(COALESCE(SUM(line_total),0), 2) AS total
               FROM order_items WHERE order_id = $1 GROUP BY order_supplier_id) sub
      WHERE os.id = sub.order_supplier_id`,
    [orderId]
  );

  const { rows: [o] } = await client.query(`SELECT * FROM orders WHERE id = $1`, [orderId]);
  if (!o) return null;
  const { rows: [agg] } = await client.query(
    `SELECT ROUND(COALESCE(SUM(line_total),0), 2) AS total FROM order_items WHERE order_id = $1`, [orderId]
  );
  const itemsSubtotal = round2(agg.total);

  let fee = Number(o.delivery_fee) || 0;
  if (o.fulfillment !== "delivery") {
    fee = 0;
  } else if (refreshFee && !o.delivery_fee_overridden) {
    const { rows: sup } = await client.query(
      `SELECT DISTINCT os.supplier_id FROM order_suppliers os
        WHERE os.order_id = $1 AND os.status <> 'cancelled'
          AND EXISTS (SELECT 1 FROM order_items oi WHERE oi.order_supplier_id = os.id)`,
      [orderId]
    );
    const supplierIds = sup.map((r) => r.supplier_id);
    fee = await calcDeliveryFee(client, {
      zoneId: o.delivery_zone_id, vehicleTypeId: o.vehicle_type_id,
      vehiclesCount: o.vehicles_count, supplierCount: supplierIds.length,
      customerId: o.customer_id, supplierIds,
    });
  }

  const grand = round2(itemsSubtotal + fee);
  const paid = Number(o.paid_amount) || 0;
  const paymentStatus = paid > 0 && paid >= grand ? "paid" : paid > 0 ? "partially_paid" : "unpaid";
  await client.query(
    `UPDATE orders SET items_subtotal = $2, delivery_fee = $3, grand_total = $4, payment_status = $5 WHERE id = $1`,
    [orderId, itemsSubtotal, fee, grand, paymentStatus]
  );
  if (["assigned_to_driver", "out_for_delivery"].includes(o.status)) {
    await client.query(`UPDATE orders SET cod_amount = $2 WHERE id = $1`,
      [orderId, computeCod({ ...o, grand_total: grand, paid_amount: paid })]);
  }
  return { itemsSubtotal, fee, grand };
}

// بعد حل أي نقص: لو ما بقاش نقص معلّق في فاتورة المورد نرجّع حالتها "قيد التجهيز" عشان يقدر يعلّمها جاهزة
async function settlePartShortageStatus(client, orderSupplierId) {
  if (!orderSupplierId) return;
  const { rows: [pending] } = await client.query(
    `SELECT COUNT(*)::INT AS remaining FROM order_shortages sh
       JOIN order_items oi ON oi.id = sh.order_item_id
      WHERE oi.order_supplier_id = $1 AND sh.resolved_at IS NULL`,
    [orderSupplierId]
  );
  if (pending.remaining === 0) {
    await client.query(
      `UPDATE order_suppliers SET status = 'preparing' WHERE id = $1 AND status = 'shortage'`,
      [orderSupplierId]
    );
  }
}

/* ---------- إشعارات الموردين (داخل التطبيق فقط — قوالب B-notifications.sql بدون واتساب) ---------- */

// الموردون اللي وصلتهم الطلبية فعلًا (جزءهم ليس "pending") ولسا جزءهم فعّال — تُقرأ قبل تغيير حالة الأجزاء
async function activeSupplierIds(client, orderId) {
  const { rows } = await client.query(
    `SELECT DISTINCT supplier_id FROM order_suppliers
      WHERE order_id = $1 AND status NOT IN ('pending','cancelled','closed','picked_up')`,
    [orderId]
  );
  return rows.map((r) => r.supplier_id);
}

const reasonText = (reason) => (reason && String(reason).trim() ? ` (السبب: ${String(reason).trim()})` : "");

async function notifySuppliers(client, { supplierIds, order, templateCode, reason = "", change = "" }) {
  for (const supplierId of new Set(supplierIds || [])) {
    await queueNotification(client, {
      templateCode, recipientType: "supplier", recipientId: supplierId, orderId: order.id,
      vars: { order_number: order.order_number, reason: reasonText(reason), change },
    });
  }
}

// الرصيد الحالي + قيمة الطلبية ما يتعداش سقف الآجل (نفس منطق دفتر العميل عند الاعتماد)
async function assertCreditAllowed(client, customerId, grandTotal) {
  // قفل على مستوى العميل: عشان طلبين/اعتمادين متزامنين ما يتجاوزوا السقف مع بعض
  await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`credit:${customerId}`]);
  const cust = await client.query(`SELECT credit_enabled, credit_limit FROM customers WHERE id = $1`, [customerId]);
  if (!cust.rows[0]?.credit_enabled) throw new ApiError(400, "البيع الآجل غير مفعّل لهذا العميل");
  // سقف الآجل (0 = بدون سقف)
  const limit = Number(cust.rows[0].credit_limit ?? 0);
  if (limit > 0) {
    const { rows: [bal] } = await client.query(
      `SELECT COALESCE(SUM(debit),0)::numeric - COALESCE(SUM(credit),0)::numeric AS balance
         FROM v_customer_ledger WHERE customer_id = $1`, [customerId]
    );
    const after = Number(bal.balance) + Number(grandTotal);
    if (after > limit + 0.005) {
      throw new ApiError(400, `تجاوز سقف الآجل: الرصيد الحالي ${Number(bal.balance).toFixed(2)} + الطلبية ${Number(grandTotal).toFixed(2)} أكبر من السقف ${limit.toFixed(2)} د.ل`);
    }
  }
}

/* ===================================================================
   المخزون المتاح وقت الطلب
   المتاح = المخزون − مجموع الكميات المطلوبة في طلبيات مفتوحة لسا ما اتأكدت (ما اتخصمتش)
=================================================================== */

// أقفال استشارية لكل صنف بترتيب ثابت (مرتبة) — تمنع طلبين متزامنين من حجز نفس الكمية
async function lockStockForProducts(client, productIds) {
  for (const id of [...new Set(productIds)].sort()) {
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`stock:${id}`]);
  }
}

// lines: [{ productId, variantId, qty, label }] — مدموجة (سطر واحد لكل صنف/نوع)
async function assertStockAvailable(client, lines) {
  if (!lines.length) return;
  await lockStockForProducts(client, lines.map((l) => l.productId));

  const productIds = [...new Set(lines.filter((l) => !l.variantId).map((l) => l.productId))];
  const variantIds = [...new Set(lines.filter((l) => l.variantId).map((l) => l.variantId))];
  // استعلام تجميعي واحد (لقطة واحدة) للمخزون والمحجوز معًا
  const { rows } = await client.query(
    `SELECT p.id AS product_id, NULL::uuid AS variant_id, p.stock_qty,
            COALESCE((SELECT SUM(oi.qty_requested) FROM order_items oi JOIN orders o ON o.id = oi.order_id
                       WHERE oi.product_id = p.id AND oi.variant_id IS NULL AND oi.qty_confirmed IS NULL
                         AND oi.order_supplier_id NOT IN (SELECT id FROM order_suppliers WHERE status = 'cancelled')
                         AND o.status IN ('under_review','approved','sent_to_supplier','supplier_preparing','shortage')), 0) AS reserved
       FROM products p WHERE p.id = ANY($1::uuid[])
     UNION ALL
     SELECT v.product_id, v.id, v.stock_qty,
            COALESCE((SELECT SUM(oi.qty_requested) FROM order_items oi JOIN orders o ON o.id = oi.order_id
                       WHERE oi.variant_id = v.id AND oi.qty_confirmed IS NULL
                         AND oi.order_supplier_id NOT IN (SELECT id FROM order_suppliers WHERE status = 'cancelled')
                         AND o.status IN ('under_review','approved','sent_to_supplier','supplier_preparing','shortage')), 0)
       FROM product_variants v WHERE v.id = ANY($2::uuid[])`,
    [productIds, variantIds]
  );
  const map = new Map(rows.map((r) => [`${r.product_id}:${r.variant_id || ""}`, r]));
  for (const l of lines) {
    const r = map.get(`${l.productId}:${l.variantId || ""}`);
    const stock = r ? Number(r.stock_qty) : 0;
    const available = round3(stock - Number(r?.reserved || 0));
    if (stock <= 0) throw new ApiError(400, `غير متوفر حاليًا: ${l.label}`);
    if (available <= 0) throw new ApiError(400, `غير متوفر حاليًا (الكمية المتبقية محجوزة لطلبيات أخرى): ${l.label}`);
    if (l.qty > available) {
      throw new ApiError(400, `الكمية المطلوبة من ${l.label} أكبر من المتوفر حاليًا (${available})`);
    }
  }
}

/* ===================================================================
   تجهيز أسطر الطلب (تحقق + دمج + تسعير) — مشترك بين الإنشاء والإضافة اليدوية
=================================================================== */

async function prepareLines(client, customerId, rawLines) {
  // دمج السطور المكررة (نفس الصنف/النوع) قبل أي فحص — 5+5 تُفحص كـ 10
  const merged = new Map();
  for (const it of rawLines) {
    const key = `${it.productId}:${it.variantId || ""}`;
    const m = merged.get(key);
    if (m) m.qty = round3(m.qty + it.qty);
    else merged.set(key, { productId: it.productId, variantId: it.variantId || null, qty: round3(it.qty) });
  }
  const lines = [...merged.values()];

  const { rows: prods } = await client.query(
    `SELECT p.id, p.name, p.unit, p.section_id, p.supplier_id, p.purchase_cost, p.supplier_sku,
            p.availability, p.is_active, p.approval_status, s.status AS supplier_status,
            EXISTS (SELECT 1 FROM supplier_sections ss JOIN sections ps ON ps.id = p.section_id
                     WHERE ss.supplier_id = p.supplier_id AND ss.section_id = COALESCE(ps.parent_id, ps.id)
                       AND ss.enabled) AS supplier_section_enabled
       FROM products p JOIN suppliers s ON s.id = p.supplier_id
      WHERE p.id = ANY($1::uuid[])`,
    [lines.map((l) => l.productId)]
  );
  const prodMap = new Map(prods.map((p) => [p.id, p]));

  const variantIds = lines.filter((l) => l.variantId).map((l) => l.variantId);
  const { rows: vars } = variantIds.length
    ? await client.query(
        `SELECT id, product_id, label, price, purchase_cost, is_active FROM product_variants WHERE id = ANY($1::uuid[])`,
        [variantIds]
      )
    : { rows: [] };
  const varMap = new Map(vars.map((v) => [v.id, v]));
  const { rows: hv } = await client.query(
    `SELECT DISTINCT product_id FROM product_variants WHERE product_id = ANY($1::uuid[]) AND is_active`,
    [lines.map((l) => l.productId)]
  );
  const hasVariants = new Set(hv.map((r) => r.product_id));

  const enriched = [];
  for (const l of lines) {
    const p = prodMap.get(l.productId);
    if (!p || !p.is_active || p.approval_status !== "approved") {
      throw new ApiError(404, `صنف غير متاح: ${p?.name ?? l.productId}`);
    }
    if (p.availability === "suspended") throw new ApiError(400, `الصنف موقوف مؤقتًا: ${p.name}`);
    if (p.supplier_status !== "approved") throw new ApiError(400, "المورد غير معتمد حاليًا");
    if (!p.supplier_section_enabled) throw new ApiError(400, `قسم هذا الصنف معطّل عند المورد حاليًا: ${p.name}`);

    let variant = null;
    if (l.variantId) {
      variant = varMap.get(l.variantId);
      if (!variant || variant.product_id !== p.id || !variant.is_active) {
        throw new ApiError(404, `نوع الصنف غير متاح: ${p.name}`);
      }
    } else if (hasVariants.has(p.id)) {
      throw new ApiError(400, `لازم تختار نوع (لون/مقاس/عبوة) للصنف: ${p.name}`);
    }

    const label = variant ? `${p.name} — ${variant.label}` : p.name;
    assertQtyForUnit(l.qty, p.unit, label);
    await assertCustomerSection(customerId, p.section_id);

    const price = Number(await resolvePrice(client, {
      productId: p.id, customerId, qty: l.qty, variantId: l.variantId || undefined,
    }));
    if (!Number.isFinite(price) || price < 0) throw new ApiError(400, `سعر غير صالح للصنف: ${label}`);

    enriched.push({
      productId: p.id, variantId: l.variantId || null, variantLabel: variant?.label ?? null,
      supplier_id: p.supplier_id, unit: p.unit, supplier_sku: p.supplier_sku ?? null,
      name: label, qty: l.qty, price,
      purchase_cost: variant ? (variant.purchase_cost ?? p.purchase_cost) : p.purchase_cost,
      lineTotal: round2(price * l.qty),
    });
  }
  return enriched;
}

/* ===================================================================
   عرض آمن للعميل (بدون حقول داخلية)
=================================================================== */

const CUSTOMER_ORDER_COLS = `o.id, o.order_number, o.status, o.fulfillment, o.payment_method, o.payment_status,
  o.items_subtotal, o.delivery_fee, o.grand_total, o.paid_amount, o.delivery_zone_id, o.vehicle_type_id,
  o.vehicles_count, o.deposit_due_at_delivery, o.deferred_due_date, o.cancel_reason, o.delivered_at, o.created_at`;
const CUSTOMER_ORDER_FIELDS = CUSTOMER_ORDER_COLS.replace(/o\./g, "").split(",").map((s) => s.trim());
function customerOrderView(row) {
  const out = {};
  for (const k of CUSTOMER_ORDER_FIELDS) out[k] = row[k];
  if (row.supplierCount !== undefined) out.supplierCount = row.supplierCount;
  if (row.duplicate) out.duplicate = true;
  return out;
}

const DRIVER_ORDER_COLS = `${CUSTOMER_ORDER_COLS}, o.driver_id, o.assigned_at, o.cod_amount, o.cod_collected, o.cod_settled`;

/* ===================================================================
   إنشاء الطلبية (عميل / إدارة نيابةً عن عميل)
=================================================================== */

const createSchema = z.object({
  fulfillment: z.enum(["delivery", "pickup"]),
  paymentMethod: z.enum(["cash", "card", "transfer", "pay_at_supplier", "deferred"]),
  deliveryZoneId: z.string().uuid().optional(),
  vehicleTypeId: z.string().uuid().optional(),
  vehiclesCount: z.number().int().min(1).max(50).default(1),
  supplierNotes: z.record(z.string().max(1000)).optional(),
  clientKey: z.string().uuid().optional(), // معرّف محاولة الإرسال — يمنع تكرار الطلب لو انقطع الاتصال وأُعيد الإرسال
  items: z.array(z.object({
    productId: z.string().uuid(),
    qty: z.number().positive().max(MAX_LINE_QTY),
    variantId: z.string().uuid().optional(), // نوع الصنف (لون/مقاس/عبوة) لو الصنف عنده أنواع
  })).min(1).max(200),
});

async function createOrderCore(client, { customerId, body, actor, byAdmin, ip }) {
  // 1) منع التكرار: نفس المفتاح لنفس العميل يرجّع الطلبية الموجودة
  if (body.clientKey) {
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`orderkey:${customerId}:${body.clientKey}`]);
    const { rows } = await client.query(
      `SELECT * FROM orders WHERE customer_id = $1 AND client_key = $2`, [customerId, body.clientKey]
    );
    if (rows.length) {
      const { rows: [{ n }] } = await client.query(
        `SELECT COUNT(*)::INT AS n FROM order_suppliers WHERE order_id = $1`, [rows[0].id]
      );
      return { order: rows[0], supplierCount: n, duplicate: true };
    }
  }

  // 2) حالة العميل
  const { rows: [cust] } = await client.query(`SELECT status FROM customers WHERE id = $1`, [customerId]);
  if (!cust) throw new ApiError(404, "العميل غير موجود");
  if (cust.status !== "approved") throw new ApiError(403, "حسابك غير معتمد حاليًا — تواصل مع الإدارة");

  // 3) توافق طريقة التسليم مع الدفع
  let zoneId = null, vehicleTypeId = null, vehiclesCount = 1;
  if (body.fulfillment === "delivery") {
    if (!body.vehicleTypeId && !body.deliveryZoneId) {
      throw new ApiError(400, "اختر نوع السيارة (أو منطقة التوصيل) للطلبات بالتوصيل");
    }
    if (body.paymentMethod === "pay_at_supplier") {
      throw new ApiError(400, "الدفع عند المورد متاح للاستلام الشخصي فقط");
    }
    if (body.deliveryZoneId) {
      const { rows } = await client.query(`SELECT is_active FROM delivery_zones WHERE id = $1`, [body.deliveryZoneId]);
      if (!rows.length || rows[0].is_active === false) throw new ApiError(400, "منطقة التوصيل غير متاحة");
      zoneId = body.deliveryZoneId;
    }
    if (body.vehicleTypeId) {
      const { rows } = await client.query(`SELECT is_active FROM vehicle_types WHERE id = $1`, [body.vehicleTypeId]);
      if (!rows.length || rows[0].is_active === false) throw new ApiError(400, "نوع السيارة غير متاح");
      vehicleTypeId = body.vehicleTypeId;
    }
    vehiclesCount = body.vehiclesCount;
  } else if (body.paymentMethod === "cash") {
    throw new ApiError(400, "الاستلام الشخصي لا يدعم الدفع النقدي عند الاستلام — اختر الدفع عند المورد أو الحوالة");
  }

  // 4) قفل المخزون (صنف بصنف بترتيب ثابت) ثم تجهيز الأسطر والتحقق من المتاح
  await lockStockForProducts(client, body.items.map((i) => i.productId));
  const enriched = await prepareLines(client, customerId, body.items);
  await assertStockAvailable(client, enriched.map((l) => ({
    productId: l.productId, variantId: l.variantId, qty: l.qty, label: l.name,
  })));

  const supplierIds = [...new Set(enriched.map((i) => i.supplier_id))];
  const itemsSubtotal = round2(enriched.reduce((s, i) => s + i.lineTotal, 0));

  const { rows: supplierRates } = await client.query(
    `SELECT id, commission_rate_percent FROM suppliers WHERE id = ANY($1::uuid[])`, [supplierIds]
  );
  const rateMap = Object.fromEntries(supplierRates.map((s) => [s.id, s.commission_rate_percent ?? 0]));

  const deliveryFee = body.fulfillment === "delivery"
    ? await calcDeliveryFee(client, {
        zoneId, vehicleTypeId, vehiclesCount,
        supplierCount: supplierIds.length, customerId, supplierIds,
      })
    : 0;
  const grandTotal = round2(itemsSubtotal + deliveryFee);

  // 5) الآجل: مفعّل للعميل وضمن السقف (نفس منطق الاعتماد)
  if (body.paymentMethod === "deferred") await assertCreditAllowed(client, customerId, grandTotal);

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
    [orderNumber, customerId, body.fulfillment, body.paymentMethod,
     itemsSubtotal, deliveryFee, grandTotal, zoneId, vehicleTypeId, vehiclesCount]
  );
  if (body.clientKey) {
    await client.query(`UPDATE orders SET client_key = $2 WHERE id = $1`, [created.id, body.clientKey]);
  }

  for (const supplierId of supplierIds) {
    const mine = enriched.filter((i) => i.supplier_id === supplierId);
    const subtotal = round2(mine.reduce((s, i) => s + i.lineTotal, 0));
    const { rows: [os] } = await client.query(
      `INSERT INTO order_suppliers (order_id, supplier_id, subtotal, supplier_note, commission_rate)
       VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [created.id, supplierId, subtotal, body.supplierNotes?.[supplierId] ?? null, rateMap[supplierId] ?? 0]
    );
    for (const i of mine) {
      await client.query(
        `INSERT INTO order_items
           (order_id, order_supplier_id, product_id, product_name, unit,
            unit_price, purchase_cost, qty_requested, line_total, supplier_sku, variant_id, variant_label)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [created.id, os.id, i.productId, i.name, i.unit, i.price, i.purchase_cost, i.qty, i.lineTotal,
         i.supplier_sku, i.variantId, i.variantLabel]
      );
    }
  }

  await recordStatus(client, {
    orderId: created.id, from: "draft", to: "under_review", actor,
    note: byAdmin ? "أُنشئت بواسطة الدعم الفني نيابة عن العميل" : null,
  });
  await writeAudit(client, {
    actorType: byAdmin ? "employee" : "customer", actorId: actor.id, actorName: actor.name,
    action: byAdmin ? "order.created_by_admin" : "order.submitted",
    entityType: "order", entityId: created.id, entityLabel: orderNumber, after: created, ip,
  });
  if (!byAdmin) {
    await notifyStaffWithPermission(client, {
      permissionCode: "orders.review", templateCode: "order.new_pending_review",
      orderId: created.id,
      vars: { order_number: orderNumber, customer_name: actor.name, total: grandTotal.toFixed(2) },
    });
  }

  return { order: created, supplierCount: supplierIds.length, duplicate: false };
}

orderRouter.post("/", requireActorType("customer"), asyncRoute(async (req, res) => {
  const body = createSchema.parse(req.body);
  const r = await withTransaction((client) => createOrderCore(client, {
    customerId: req.actor.id, body, actor: req.actor, byAdmin: false, ip: req.ip,
  }));
  res.status(r.duplicate ? 200 : 201)
    .json(customerOrderView({ ...r.order, supplierCount: r.supplierCount, duplicate: r.duplicate }));
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

  const r = await withTransaction((client) => createOrderCore(client, {
    customerId: body.customerId, body, actor: req.actor, byAdmin: true, ip: req.ip,
  }));
  res.status(r.duplicate ? 200 : 201).json({ ...r.order, supplierCount: r.supplierCount });
}));

/* ===================================================================
   القوائم
=================================================================== */

orderRouter.get("/", asyncRoute(async (req, res) => {
  const status = typeof req.query.status === "string" && req.query.status.length < 40 ? req.query.status : null;
  const { limit, offset } = parsePaging(req.query);
  const a = req.actor;

  if (a.type === "customer") {
    const { rows } = await query(
      `SELECT ${CUSTOMER_ORDER_COLS},
              (SELECT COUNT(*) FROM order_suppliers WHERE order_id = o.id) AS supplier_count
         FROM orders o
        WHERE o.customer_id = $1 AND ($2::TEXT IS NULL OR o.status = $2)
        ORDER BY o.created_at DESC
        LIMIT $3 OFFSET $4`,
      [a.id, status, limit, offset]
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
        ORDER BY o.created_at DESC
        LIMIT $3 OFFSET $4`,
      [a.id, status, limit, offset]
    );
    return res.json(rows);
  }

  if (a.type !== "employee") throw new ApiError(403, "لا تملك صلاحية الوصول لهذه الشاشة");

  if (a.role === "driver") {
    const { rows } = await query(
      `SELECT ${DRIVER_ORDER_COLS}, c.business_name AS customer_name, c.phone AS customer_phone, c.address
         FROM orders o JOIN customers c ON c.id = o.customer_id
        WHERE o.driver_id = $1 AND ($2::TEXT IS NULL OR o.status = $2)
        ORDER BY o.created_at DESC
        LIMIT $3 OFFSET $4`,
      [a.id, status, limit, offset]
    );
    return res.json(rows);
  }

  if (!(await employeeHasAny(a.id, STAFF_VIEW_PERMS))) {
    throw new ApiError(403, "لا تملك صلاحية الاطلاع على الطلبيات");
  }
  // موظف مقيّد بأقسام يشوف بس الطلبيات اللي كل أصنافها ضمن نطاقه (فلترة داخل الاستعلام نفسه)
  const scope = await getEmployeeSectionScope(a.id);
  const { rows } = await query(
    `SELECT o.*, c.business_name AS customer_name
       FROM orders o JOIN customers c ON c.id = o.customer_id
      WHERE ($1::TEXT IS NULL OR o.status = $1)
        AND ($2::UUID[] IS NULL OR NOT EXISTS (
              SELECT 1 FROM order_items oi JOIN products p ON p.id = oi.product_id
               WHERE oi.order_id = o.id AND NOT (p.section_id = ANY($2::UUID[]))))
      ORDER BY o.created_at DESC
      LIMIT $3 OFFSET $4`,
    [status, scope ? [...scope] : null, limit, offset]
  );
  res.json(rows);
}));

/* ===================================================================
   تفاصيل طلبية — حسب هوية الطالب (كل جهة تشوف نصيبها فقط)
=================================================================== */

orderRouter.get("/:id", asyncRoute(async (req, res) => {
  const a = req.actor;
  const orderId = req.params.id;

  const { rows } = await query(
    `SELECT o.*, c.business_name AS customer_name, c.phone AS customer_phone,
            c.address, c.latitude AS customer_latitude, c.longitude AS customer_longitude
       FROM orders o JOIN customers c ON c.id = o.customer_id
      WHERE o.id = $1`,
    [orderId]
  );
  if (!rows.length) throw new ApiError(404, "الطلبية غير موجودة");
  const order = rows[0];
  const FORBIDDEN = new ApiError(403, "لا تملك صلاحية الاطلاع على هذه الطلبية");

  // كل الأجزاء (للحساب الداخلي فقط) — الرد نفسه يحدده نوع الطالب
  const { rows: allParts } = await query(
    `SELECT os.*, s.business_name AS supplier_name, s.phone AS supplier_phone,
            s.address AS supplier_address, s.latitude AS supplier_latitude, s.longitude AS supplier_longitude
       FROM order_suppliers os JOIN suppliers s ON s.id = os.supplier_id
      WHERE os.order_id = $1`,
    [orderId]
  );

  /* ---------- عميل: صاحب الطلبية فقط، بدون أي حقل داخلي ---------- */
  if (a.type === "customer") {
    if (order.customer_id !== a.id) throw FORBIDDEN;
    const { rows: items } = await query(
      `SELECT id, order_supplier_id, product_id, variant_id, variant_label, product_name, unit,
              unit_price, qty_requested, qty_confirmed, availability, line_total
         FROM order_items WHERE order_id = $1 ORDER BY created_at`, [orderId]
    );
    const { rows: history } = await query(
      `SELECT from_status, to_status, changed_at
         FROM order_status_history
        WHERE order_id = $1 AND order_supplier_id IS NULL AND from_status IS DISTINCT FROM to_status
        ORDER BY changed_at`, [orderId]
    );
    const view = customerOrderView(order);
    return res.json({
      ...view,
      customer_name: order.customer_name,
      suppliers: allParts
        .map((s) => ({
          id: s.id, supplier_id: s.supplier_id, supplier_name: s.supplier_name,
          status: s.status, subtotal: s.subtotal, supplier_note: s.supplier_note,
          items: items.filter((i) => i.order_supplier_id === s.id),
        }))
        .filter((s) => s.items.length > 0),
      history,
    });
  }

  /* ---------- مورد: جزءه فقط ---------- */
  if (a.type === "supplier") {
    const mine = allParts.find((s) => s.supplier_id === a.id);
    if (!mine || ["draft", "under_review"].includes(order.status)) throw FORBIDDEN;
    const { rows: items } = await query(
      `SELECT id, order_supplier_id, product_id, variant_id, variant_label, product_name, unit, supplier_sku,
              unit_price, qty_requested, qty_confirmed, availability, line_total
         FROM order_items WHERE order_supplier_id = $1 ORDER BY created_at`, [mine.id]
    );
    const { rows: history } = await query(
      `SELECT from_status, to_status, changed_at
         FROM order_status_history
        WHERE order_id = $1 AND order_supplier_id = $2 AND from_status IS DISTINCT FROM to_status
        ORDER BY changed_at`, [orderId, mine.id]
    );
    // رقم العميل فقط للاستلام الشخصي بعد تأكيد المورد لتوفر جزئه (عشان يتواصل معه للاستلام)؛ ما فيش عنوان/إحداثيات
    const confirmed = !["pending", "sent", "cancelled"].includes(mine.status);
    const collector = order.remaining_collector_id
      ? allParts.find((s) => s.supplier_id === order.remaining_collector_id) : null;
    return res.json({
      id: order.id, order_number: order.order_number, status: order.status, fulfillment: order.fulfillment,
      payment_method: order.payment_method, payment_status: order.payment_status,
      paid_amount: order.paid_amount, grand_total: order.grand_total, created_at: order.created_at,
      remaining_collector_id: order.remaining_collector_id,
      remaining_collector_name: collector?.supplier_name ?? null,
      customer_name: order.customer_name,
      customer_phone: order.fulfillment === "pickup" && confirmed ? order.customer_phone : null,
      suppliers: items.length ? [{
        id: mine.id, supplier_id: mine.supplier_id, supplier_name: mine.supplier_name,
        status: mine.status, subtotal: mine.subtotal, supplier_note: mine.supplier_note,
        pickup_confirmed: mine.pickup_confirmed, payment_received: mine.payment_received,
        due_now: partDueNow(order, allParts, mine),
        items,
      }] : [],
      history,
    });
  }

  if (a.type !== "employee") throw FORBIDDEN;

  /* ---------- مندوب: طلبياته فقط، بدون عمولات/تكلفة ---------- */
  if (a.role === "driver") {
    if (order.driver_id !== a.id) throw FORBIDDEN;
    const { rows: items } = await query(
      `SELECT id, order_supplier_id, product_id, variant_id, variant_label, product_name, unit,
              unit_price, qty_requested, qty_confirmed, availability, line_total
         FROM order_items WHERE order_id = $1 ORDER BY created_at`, [orderId]
    );
    const { rows: history } = await query(
      `SELECT from_status, to_status, changed_at
         FROM order_status_history
        WHERE order_id = $1 AND order_supplier_id IS NULL AND from_status IS DISTINCT FROM to_status
        ORDER BY changed_at`, [orderId]
    );
    const {
      reviewed_by, reviewed_at, credit_approved_by, remaining_collector_id, client_key,
      delivery_fee_overridden, ...safe
    } = order;
    return res.json({
      ...safe,
      suppliers: allParts
        .map((s) => ({
          id: s.id, supplier_id: s.supplier_id, supplier_name: s.supplier_name,
          supplier_phone: s.supplier_phone, supplier_address: s.supplier_address,
          supplier_latitude: s.supplier_latitude, supplier_longitude: s.supplier_longitude,
          status: s.status, subtotal: s.subtotal, supplier_note: s.supplier_note,
          items: items.filter((i) => i.order_supplier_id === s.id),
        }))
        .filter((s) => s.items.length > 0),
      history,
    });
  }

  /* ---------- موظف إدارة: بصلاحية عرض الطلبيات وضمن نطاق أقسامه ---------- */
  if (!(await employeeHasAny(a.id, STAFF_VIEW_PERMS))) throw FORBIDDEN;
  if (!(await orderInEmployeeScope(a.id, orderId))) throw new ApiError(403, OUT_OF_SCOPE_MSG);

  const { rows: items } = await query(`SELECT * FROM order_items WHERE order_id = $1`, [orderId]);
  const { rows: history } = await query(
    `SELECT from_status, to_status, changed_by_name, note, changed_at
       FROM order_status_history WHERE order_id = $1 ORDER BY changed_at`, [orderId]
  );
  res.json({
    ...order,
    suppliers: allParts
      .map((s) => ({
        ...s,
        // المتبقي على العميل اللي لازم المورد يستلمه عند التسليم (استلام شخصي) — 0 لو خالصة
        due_now: partDueNow(order, allParts, s),
        items: items.filter((i) => i.order_supplier_id === s.id),
      }))
      .filter((s) => s.items.length > 0),
    history,
  });
}));

/* ===================================================================
   كرر آخر طلبية / مراجعة محتوى السلة بالأسعار والتوفر الحاليين
=================================================================== */

// يحوّل أسطر (product_id, variant_id, qty) إلى أصناف جاهزة للسلة بأسعار وتوفر الآن
async function resolveCartLines(customerId, wanted) {
  const items = [];
  const unavailable = [];
  for (const it of wanted) {
    const { rows: p } = await query(
      `SELECT p.id, p.name, p.unit, p.image_url, p.availability, p.supplier_id, p.section_id, p.stock_qty,
              p.approval_status, s.business_name AS supplier_name, s.status AS supplier_status,
              EXISTS (SELECT 1 FROM supplier_sections ss JOIN sections ps ON ps.id = p.section_id
                       WHERE ss.supplier_id = p.supplier_id AND ss.section_id = COALESCE(ps.parent_id, ps.id)
                         AND ss.enabled) AS supplier_section_enabled
         FROM products p JOIN suppliers s ON s.id = p.supplier_id
        WHERE p.id = $1 AND p.is_active`,
      [it.product_id]
    );
    if (!p.length || p[0].approval_status !== "approved" || p[0].supplier_status !== "approved"
        || p[0].availability === "suspended" || !p[0].supplier_section_enabled
        || (p[0].availability === "out" && !it.variant_id)) {
      unavailable.push(p[0]?.name ?? "صنف لم يعد متوفرًا");
      continue;
    }
    try { await assertCustomerSection(customerId, p[0].section_id); }
    catch { unavailable.push(p[0].name); continue; }

    let variant = null;
    let stock = Number(p[0].stock_qty);
    if (it.variant_id) {
      const { rows: v } = await query(
        `SELECT id, label, price, stock_qty FROM product_variants WHERE id = $1 AND product_id = $2 AND is_active`,
        [it.variant_id, it.product_id]
      );
      if (!v.length) { unavailable.push(`${p[0].name} (النوع لم يعد متوفرًا)`); continue; }
      variant = v[0];
      stock = Number(v[0].stock_qty);
    }
    if (!(stock > 0)) { unavailable.push(variant ? `${p[0].name} — ${variant.label}` : p[0].name); continue; }

    const qty = Math.min(Number(it.qty), stock);
    const price = await resolvePrice(pool, {
      productId: p[0].id, customerId, qty, variantId: it.variant_id || undefined,
    }).catch(() => null);
    if (price == null) { unavailable.push(p[0].name); continue; }

    const { supplier_status, supplier_section_enabled, approval_status, section_id, stock_qty, ...product } = p[0];
    items.push({
      ...product, price: Number(price), qty, stock_qty: stock,
      variantId: it.variant_id || null, variantLabel: variant?.label ?? null,
      name: variant ? `${product.name} — ${variant.label}` : product.name,
    });
  }
  return { items, unavailable };
}

// "كرر آخر طلبية" — يرجّع أصناف طلبية سابقة بأسعارها وتوفّرها الحاليين (مش
// المحفوظين وقتها)، عشان العميل يقدر يضيفهم للسلة الجديدة بضغطة وحدة
orderRouter.get("/:id/reorder-items", requireActorType("customer"), asyncRoute(async (req, res) => {
  const { rows: orderRows } = await query(`SELECT customer_id FROM orders WHERE id = $1`, [req.params.id]);
  if (!orderRows.length) throw new ApiError(404, "الطلبية غير موجودة");
  if (orderRows[0].customer_id !== req.actor.id) {
    throw new ApiError(403, "لا تملك صلاحية الاطلاع على هذه الطلبية");
  }
  const { rows: pastItems } = await query(
    `SELECT product_id, variant_id, MAX(qty_requested) AS qty
       FROM order_items WHERE order_id = $1
      GROUP BY product_id, variant_id`,
    [req.params.id]
  );
  res.json(await resolveCartLines(req.actor.id, pastItems));
}));

// مراجعة السلة المحفوظة عند العميل: يرجّع الأسعار والتوفر الحاليين لكل سطر (والأصناف اللي ما عادت متاحة)
orderRouter.post("/cart-items", requireActorType("customer"), asyncRoute(async (req, res) => {
  const body = z.object({
    items: z.array(z.object({
      productId: z.string().uuid(),
      variantId: z.string().uuid().nullish(),
      qty: z.number().positive().max(MAX_LINE_QTY),
    })).max(100),
  }).parse(req.body);
  const wanted = body.items.map((i) => ({ product_id: i.productId, variant_id: i.variantId || null, qty: i.qty }));
  res.json(await resolveCartLines(req.actor.id, wanted));
}));

// تقدير تكلفة التوصيل قبل تأكيد الطلبية — نفس حساب السيرفر بالضبط (المنطقة + نوع السيارة +
// المسافة من كل مورد بالسلة للزبون)، عشان العميل يشوف رقم قريب من الفاتورة الفعلية قبل ما يأكد
orderRouter.post("/estimate-delivery-fee", requireActorType("customer"), asyncRoute(async (req, res) => {
  const body = z.object({
    zoneId: z.string().uuid().optional(),
    deliveryZoneId: z.string().uuid().optional(),
    vehicleTypeId: z.string().uuid().optional(),
    vehiclesCount: z.number().int().min(1).max(50).default(1),
    supplierIds: z.array(z.string().uuid()).min(1).max(50),
  }).parse(req.body);

  const supplierIds = [...new Set(body.supplierIds)];
  const fee = await calcDeliveryFee(pool, {
    zoneId: body.zoneId ?? body.deliveryZoneId,
    vehicleTypeId: body.vehicleTypeId,
    vehiclesCount: body.vehiclesCount,
    supplierCount: supplierIds.length,
    customerId: req.actor.id,
    supplierIds,
  });

  res.json({ fee });
}));

/* ===================================================================
   اعتماد / رفض / إلغاء
=================================================================== */

// اعتماد طلبية قيد المراجعة وإرسالها للموردين (مشترك بين /approve والتحويل اليدوي من قيد المراجعة)
async function approveInTx(client, order, actor, { depositDueAtDelivery, deferredDueDate, ip, audit = true }) {
  if (order.status !== "under_review") throw new ApiError(400, "الطلبية ليست قيد المراجعة");

  if (order.payment_method === "deferred") await assertCreditAllowed(client, order.customer_id, order.grand_total);

  const { rows: [updated] } = await client.query(
    `UPDATE orders SET
       status = 'sent_to_supplier',
       reviewed_by = $2, reviewed_at = now(),
       deposit_due_at_delivery = COALESCE($3, deposit_due_at_delivery),
       deferred_due_date       = COALESCE($4::DATE, deferred_due_date),
       credit_approved_by = CASE WHEN payment_method = 'deferred' THEN $2 ELSE credit_approved_by END
     WHERE id = $1 RETURNING *`,
    [order.id, actor.id, depositDueAtDelivery ?? null, deferredDueDate ?? null]
  );

  // فقط الأجزاء اللي لسا ما أُرسلت (لو الطلبية كانت مؤجلة وفيها أجزاء مؤكدة ما نرجّعها لـ "مرسل")
  await client.query(
    `UPDATE order_suppliers SET status = 'sent' WHERE order_id = $1 AND status = 'pending'`, [order.id]
  );
  await recordStatus(client, { orderId: order.id, from: order.status, to: "sent_to_supplier", actor });
  if (audit) {
    await writeAudit(client, {
      actorType: "employee", actorId: actor.id, actorName: actor.name,
      action: "order.approved", entityType: "order", entityId: order.id,
      entityLabel: order.order_number, before: order, after: updated, ip,
    });
  }

  await queueNotification(client, {
    templateCode: "order.status", recipientType: "customer",
    recipientId: order.customer_id, orderId: order.id,
    vars: { order_number: order.order_number, status: "مرسلة إلى المورد" },
  });
  const { rows: suppliers } = await client.query(
    `SELECT DISTINCT supplier_id FROM order_suppliers WHERE order_id = $1 AND status <> 'cancelled'`, [order.id]
  );
  for (const s of suppliers) {
    await queueNotification(client, {
      templateCode: "order.new_for_supplier", recipientType: "supplier",
      recipientId: s.supplier_id, orderId: order.id,
      vars: { order_number: order.order_number },
    });
  }
  return updated;
}

orderRouter.post("/:id/approve", requirePermission("orders.review"), requireOrderScope, asyncRoute(async (req, res) => {
  const body = z.object({
    depositDueAtDelivery: z.number().nonnegative().optional(),
    deferredDueDate: z.string().optional(),
  }).parse(req.body ?? {});

  const result = await withTransaction(async (client) => {
    const { rows } = await client.query(`SELECT * FROM orders WHERE id = $1 FOR UPDATE`, [req.params.id]);
    if (!rows.length) throw new ApiError(404, "الطلبية غير موجودة");
    return approveInTx(client, rows[0], req.actor, { ...body, ip: req.ip });
  });

  res.json(result);
}));

// تأكيد قيمة حوالة مصرفية دخلت فعليًا لحساب الشركة (بعد ما يتأكد الأدمن منها بنفسه بالبنك) —
// يسجّل إيصال قبض معتمد فورًا في خزينة الحوالات، ويحدّث المبلغ المدفوع على الطلبية،
// عشان "المبلغ المطلوب من المندوب" بعدين يُحسب صح (المتبقي بس، مش المبلغ كامل)
orderRouter.post("/:id/confirm-transfer", requirePermission("finance.vouchers"), requireOrderScope, asyncRoute(async (req, res) => {
  const { amount, clientKey: rawKey } = z.object({
    amount: z.number().positive().max(100000000),
    clientKey: z.string().min(8).max(100).optional(), // يمنع تكرار الإيصال لو انضغط الزر مرتين
  }).parse(req.body);
  // نفس نمط finance.js: المفتاح مرتبط بالموظف حتى لا يتصادم بين موظفين
  const clientKey = rawKey ? `${req.actor.id}:${rawKey}` : null;

  const result = await withTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT * FROM orders WHERE id = $1 FOR UPDATE`, [req.params.id]
    );
    if (!rows.length) throw new ApiError(404, "الطلبية غير موجودة");
    const order = rows[0];

    // نفس الضغطة أُعيد إرسالها: نرجّع الإيصال الأول بدل إنشاء ثاني
    if (clientKey) {
      await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, ["vkey:" + clientKey]);
      const { rows: existing } = await client.query(`SELECT * FROM vouchers WHERE client_key = $1`, [clientKey]);
      if (existing.length) {
        return { order, voucher: existing[0], excessAsCredit: 0, duplicate: true };
      }
    }

    if (order.payment_method !== "transfer") throw new ApiError(400, "الطلبية ليست بطريقة الحوالة المصرفية");
    if (["cancelled", "closed"].includes(order.status)) throw new ApiError(409, "الطلبية ملغاة أو مغلقة");

    const remaining = round2(Number(order.grand_total) - Number(order.paid_amount));
    // الحوالات المؤكدة سابقًا (paid_amount) أو الحوالات المعلّقة عند الإدارة تغطي المتبقي كامل: ما فيش داعي لإيصال جديد
    const { rows: [pend] } = await client.query(
      `SELECT COALESCE(SUM(amount),0)::numeric AS pending FROM vouchers
        WHERE order_id = $1 AND voucher_type = 'receipt' AND method = 'transfer' AND approval_status = 'pending'`,
      [order.id]
    );
    if (remaining <= 0.005) {
      throw new ApiError(409, "الحوالات المؤكدة سابقًا تغطي كامل قيمة هذه الطلبية — لا يمكن تأكيد حوالة إضافية");
    }
    if (round2(remaining - Number(pend.pending)) <= 0.005) {
      throw new ApiError(409, "توجد حوالة معلّقة على هذه الطلبية تغطي المتبقي — اعتمدها من شاشة السندات بدل تسجيل حوالة جديدة");
    }
    // الزيادة عن قيمة الفاتورة تُسجَّل بالكامل في الإيصال (تظهر كرصيد للعميل بكشف حسابه)،
    // بس المُطبَّق على هذي الطلبية بالذات محدود بالمتبقي عليها بس
    const appliedToOrder = round2(Math.min(amount, Math.max(remaining, 0)));

    const { rows: cust } = await client.query(`SELECT business_name FROM customers WHERE id = $1`, [order.customer_id]);

    const { rows: tr } = await client.query(
      `SELECT id FROM treasuries WHERE code = $1`, [resolveTreasuryCode("receipt", "transfer")]
    );
    if (!tr.length) throw new ApiError(400, "الخزينة غير معروفة");

    const vNumber = await nextDocNumber(client, {
      table: "vouchers", column: "voucher_number", prefix: "V", start: 1000,
    });
    const { rows: [voucher] } = await client.query(
      `INSERT INTO vouchers
         (voucher_number, voucher_type, party_type, party_id, party_name,
          amount, method, treasury_id, order_id, approval_status, approved_by, approved_at, note, created_by, client_key)
       VALUES ($1,'receipt','customer',$2,$3,$4,'transfer',$5,$6,'approved',$7,now(),$8,$7,$9)
       RETURNING *`,
      [vNumber, order.customer_id, cust[0]?.business_name ?? "عميل", amount, tr[0].id, order.id,
       req.actor.id, `تأكيد حوالة — طلبية ${order.order_number}`, clientKey]
    );

    let { rows: [updated] } = await client.query(
      `UPDATE orders SET
         paid_amount = ROUND(paid_amount + $2, 2),
         payment_status = CASE WHEN paid_amount + $2 >= grand_total THEN 'paid' ELSE 'partially_paid' END
       WHERE id = $1 RETURNING *`,
      [order.id, appliedToOrder]
    );
    // لو الطلبية عند مندوب قبل ما تتأكد الحوالة، نحدّث "المطلوب تحصيله" عشان يطلع المتبقي بس (أو صفر لو خالصة)
    if (updated.driver_id && ["assigned_to_driver", "out_for_delivery"].includes(updated.status)) {
      const { rows: [u2] } = await client.query(
        `UPDATE orders SET cod_amount = GREATEST(ROUND(grand_total - paid_amount, 2), 0) WHERE id = $1 RETURNING *`,
        [order.id]
      );
      updated = u2;
    }

    await writeAudit(client, {
      actorType: "employee", actorId: req.actor.id, actorName: req.actor.name,
      action: "order.transfer_confirmed", entityType: "order", entityId: order.id,
      entityLabel: order.order_number, before: order, after: updated, ip: req.ip,
    });

    return { order: updated, voucher, excessAsCredit: Math.max(0, round2(amount - remaining)) };
  });

  res.json(result);
}));

orderRouter.post("/:id/reject", requirePermission("orders.cancel"), requireOrderScope, asyncRoute(async (req, res) => {
  const { reason, postpone } = z.object({
    reason: z.string().min(3).max(500),
    postpone: z.boolean().default(false),
  }).parse(req.body);

  const result = await withTransaction(async (client) => {
    const { rows } = await client.query(`SELECT * FROM orders WHERE id = $1 FOR UPDATE`, [req.params.id]);
    if (!rows.length) throw new ApiError(404, "الطلبية غير موجودة");
    const order = rows[0];
    if (["delivered", "closed", "cancelled"].includes(order.status)) {
      throw new ApiError(400, "لا يمكن تعديل حالة طلبية مغلقة أو ملغاة");
    }
    if (postpone && order.status === "postponed") throw new ApiError(400, "الطلبية مؤجلة بالفعل");

    const to = postpone ? "postponed" : "cancelled";
    const supplierIds = await activeSupplierIds(client, order.id); // قبل ما تتغير حالة الأجزاء
    const { rows: [updated] } = await client.query(
      `UPDATE orders SET status = $2, cancel_reason = $3 WHERE id = $1 RETURNING *`,
      [order.id, to, reason]
    );
    await recordStatus(client, { orderId: order.id, from: order.status, to, actor: req.actor, note: reason });
    if (to === "cancelled") {
      await client.query(
        `UPDATE order_suppliers SET status = 'cancelled'
          WHERE order_id = $1 AND status NOT IN ('picked_up','closed','cancelled')`,
        [order.id]
      );
      await restoreOrderStock(client, order.id, req.actor.id);
    }
    await notifySuppliers(client, {
      supplierIds, order, reason,
      templateCode: postpone ? "order.part_postponed" : "order.part_cancelled",
    });
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

// العميل يلغي طلبيته بنفسه — فقط وهي لسا قيد المراجعة (المخزون ما اتخصمش، فما فيش شي يتُرجع)
orderRouter.post("/:id/cancel", requireActorType("customer"), asyncRoute(async (req, res) => {
  const { reason } = z.object({ reason: z.string().max(300).optional() }).parse(req.body ?? {});

  const result = await withTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT * FROM orders WHERE id = $1 AND customer_id = $2 FOR UPDATE`, [req.params.id, req.actor.id]
    );
    if (!rows.length) throw new ApiError(404, "الطلبية غير موجودة");
    const order = rows[0];
    if (order.status !== "under_review") {
      throw new ApiError(409, "ما تقدرش تلغي الطلبية بعد ما بدأت مراجعتها — تواصل مع الدعم الفني");
    }

    const note = reason?.trim() ? `ألغاها العميل: ${reason.trim()}` : "ألغاها العميل";
    const { rows: [updated] } = await client.query(
      `UPDATE orders SET status = 'cancelled', cancel_reason = $2 WHERE id = $1 RETURNING *`,
      [order.id, note]
    );
    const supplierIds = await activeSupplierIds(client, order.id);
    await client.query(
      `UPDATE order_suppliers SET status = 'cancelled' WHERE order_id = $1 AND status NOT IN ('cancelled','closed')`,
      [order.id]
    );
    // لو الطلبية رجعت للمراجعة بعد تأجيل وفيها أجزاء مؤكدة (مخزونها اتخصم) نرجّعه — آمن للتكرار ولا يعمل شي لو ما اتخصم شي
    await restoreOrderStock(client, order.id, req.actor.id);
    await notifySuppliers(client, { supplierIds, order, reason: reason?.trim() || "", templateCode: "order.part_cancelled" });
    await recordStatus(client, { orderId: order.id, from: order.status, to: "cancelled", actor: req.actor, note });
    await writeAudit(client, {
      actorType: "customer", actorId: req.actor.id, actorName: req.actor.name,
      action: "order.cancelled_by_customer", entityType: "order", entityId: order.id,
      entityLabel: order.order_number, before: order, after: updated, ip: req.ip,
    });
    await notifyStaffWithPermission(client, {
      permissionCode: "orders.review", templateCode: "order.cancelled_by_customer",
      orderId: order.id,
      vars: { order_number: order.order_number, customer_name: req.actor.name },
    });
    return customerOrderView(updated);
  });

  res.json(result);
}));

// الإدارة تحدد أي مورد يستلم المبلغ المتبقي على العميل كامل (طلبية استلام شخصي بالحوالة فيها أكثر من مورد).
// لو supplierId = null يرجع التقسيم التلقائي بنسبة الفواتير.
orderRouter.post("/:id/remaining-collector", requirePermission("finance.vouchers"), requireOrderScope, asyncRoute(async (req, res) => {
  const { supplierId } = z.object({ supplierId: z.string().uuid().nullable() }).parse(req.body);

  const result = await withTransaction(async (client) => {
    const { rows } = await client.query(`SELECT * FROM orders WHERE id = $1 FOR UPDATE`, [req.params.id]);
    if (!rows.length) throw new ApiError(404, "الطلبية غير موجودة");
    const order = rows[0];
    if (order.fulfillment !== "pickup" || order.payment_method !== "transfer") {
      throw new ApiError(400, "هذا الخيار لطلبيات الاستلام الشخصي بالحوالة فقط");
    }
    if (["cancelled", "closed", "delivered"].includes(order.status)) {
      throw new ApiError(409, "الطلبية ملغاة أو مسلّمة");
    }
    if (supplierId) {
      const { rows: part } = await client.query(
        `SELECT id FROM order_suppliers
          WHERE order_id = $1 AND supplier_id = $2 AND NOT pickup_confirmed AND status <> 'cancelled'`,
        [order.id, supplierId]
      );
      if (!part.length) throw new ApiError(400, "هذا المورد ليس له فاتورة مفتوحة في هذه الطلبية");
    }
    const { rows: [updated] } = await client.query(
      `UPDATE orders SET remaining_collector_id = $2 WHERE id = $1 RETURNING *`,
      [order.id, supplierId]
    );
    await writeAudit(client, {
      actorType: "employee", actorId: req.actor.id, actorName: req.actor.name,
      action: "order.remaining_collector_set", entityType: "order", entityId: order.id,
      entityLabel: order.order_number, before: order, after: updated, ip: req.ip,
    });
    return updated;
  });

  res.json(result);
}));

/* ===================================================================
   تغيير الحالة يدويًا (فردي + جماعي) — مصفوفة انتقالات مسموحة
=================================================================== */

const MANUAL_TRANSITIONS = {
  draft: ["under_review", "cancelled"],
  under_review: ["sent_to_supplier", "postponed", "cancelled"],
  approved: ["sent_to_supplier", "postponed", "cancelled"],
  sent_to_supplier: ["supplier_preparing", "postponed", "cancelled"],
  supplier_preparing: ["sent_to_supplier", "shortage", "ready_for_delivery", "ready_for_pickup", "postponed", "cancelled"],
  shortage: ["supplier_preparing", "postponed", "cancelled"],
  ready: ["ready_for_delivery", "ready_for_pickup", "postponed", "cancelled"],
  ready_for_delivery: ["supplier_preparing", "postponed", "cancelled"],
  ready_for_pickup: ["awaiting_pickup", "delivered", "postponed", "cancelled"],
  awaiting_pickup: ["ready_for_pickup", "delivered", "cancelled"],
  assigned_to_driver: ["ready_for_delivery", "cancelled"],
  out_for_delivery: ["cancelled"],
  postponed: ["under_review", "cancelled"],
};

// يرجع نص سبب الرفض (بالعربي) أو null لو الانتقال مسموح من ناحية الحالة والتسليم
function checkTransition(order, to) {
  if (TERMINAL.includes(order.status)) return "لا يمكن تغيير حالة طلبية تم تسليمها أو إلغاؤها";
  if (order.status === to) return "بالفعل في هذه الحالة";
  if (to === "assigned_to_driver") return "الإسناد لمندوب يتم بزر «إسناد مندوب» فقط";
  if (to === "closed") return "إقفال الطلبية يتم بإصدار الإيصال بعد التسليم";
  const allowed = MANUAL_TRANSITIONS[order.status] || [];
  if (!allowed.includes(to)) return `لا يمكن تحويل الطلبية من «${statusAr(order.status)}» إلى «${statusAr(to)}» يدويًا`;
  if (to === "ready_for_delivery" && order.fulfillment !== "delivery") return "الطلبية استلام شخصي";
  if (to === "ready_for_pickup" && order.fulfillment !== "pickup") return "الطلبية توصيل";
  if (to === "delivered" && order.fulfillment !== "pickup") {
    return "طلبيات التوصيل تُسلَّم من تطبيق المندوب (إسناد ثم بدء توصيل ثم تأكيد تسليم)";
  }
  return null;
}

// تحقق داخل المعاملة من أن كل أجزاء الطلبية جاهزة قبل تحويلها لـ "جاهزة"
async function assertAllPartsReady(client, orderId) {
  const { rows: [r] } = await client.query(
    `SELECT COUNT(*)::INT AS total,
            COUNT(*) FILTER (WHERE status NOT IN ('ready','picked_up'))::INT AS notready
       FROM order_suppliers WHERE order_id = $1 AND status <> 'cancelled'`, [orderId]
  );
  if (!r.total || r.notready > 0) throw new ApiError(409, "لسا فيه أجزاء موردين غير جاهزة");
}

// تطبيق تغيير الحالة اليدوي (بعد التحقق من الانتقال والصلاحية)
async function applyManualStatus(client, order, to, actor, { note, ip, audit = true }) {
  let updated;
  if (to === "sent_to_supplier" && order.status === "under_review") {
    updated = await approveInTx(client, order, actor, { ip, audit });
    return updated; // الاعتماد يسجّل الحالة والإشعارات بنفسه
  }
  if (to === "ready_for_delivery" || to === "ready_for_pickup") await assertAllPartsReady(client, order.id);
  const supplierIds = ["cancelled", "postponed"].includes(to) ? await activeSupplierIds(client, order.id) : [];

  ({ rows: [updated] } = await client.query(
    `UPDATE orders SET status = $2::TEXT,
            delivered_at = CASE WHEN $2::TEXT = 'delivered' THEN now() ELSE delivered_at END,
            cancel_reason = CASE WHEN $2::TEXT IN ('cancelled','postponed') THEN COALESCE($3, cancel_reason) ELSE cancel_reason END
      WHERE id = $1 RETURNING *`,
    [order.id, to, note ?? null]
  ));

  if (!["under_review", "draft", "postponed", "cancelled"].includes(to)) {
    await client.query(
      `UPDATE order_suppliers SET status = 'sent' WHERE order_id = $1 AND status = 'pending'`, [order.id]
    );
  }
  if (to === "cancelled") {
    await client.query(
      `UPDATE order_suppliers SET status = 'cancelled'
        WHERE order_id = $1 AND status NOT IN ('picked_up','closed','cancelled')`,
      [order.id]
    );
    await restoreOrderStock(client, order.id, actor.id);
  }
  if (to === "delivered") {
    // تسليم يدوي لاستلام شخصي: نقفل فواتير الموردين ونعلّم الاستلام مؤكدًا.
    // ما نحوّلش المبلغ لـ"مدفوع" تلقائيًا (ما حدا استلم فلوس فعليًا) — المتبقي يبقى على العميل لحد تسجيل سند قبض
    await client.query(
      `UPDATE order_suppliers SET status = 'closed', pickup_confirmed = TRUE,
              confirmed_at = COALESCE(confirmed_at, now())
        WHERE order_id = $1 AND status NOT IN ('closed','cancelled')`,
      [order.id]
    );
  }

  if (supplierIds.length) {
    await notifySuppliers(client, {
      supplierIds, order, reason: note || "",
      templateCode: to === "cancelled" ? "order.part_cancelled" : "order.part_postponed",
    });
  }
  await recordStatus(client, { orderId: order.id, from: order.status, to, actor, note });
  if (audit) {
    await writeAudit(client, {
      actorType: "employee", actorId: actor.id, actorName: actor.name,
      action: "order.status_changed", entityType: "order", entityId: order.id,
      entityLabel: order.order_number, before: order, after: updated, ip,
    });
  }
  await queueNotification(client, {
    templateCode: "order.status", recipientType: "customer",
    recipientId: order.customer_id, orderId: order.id,
    vars: { order_number: order.order_number, status: statusAr(to) },
  });
  return updated;
}

orderRouter.patch("/:id/status", requirePermission("orders.review"), requireOrderScope, asyncRoute(async (req, res) => {
  const { status, note } = z.object({
    status: z.string().max(40), note: z.string().max(500).optional(),
  }).parse(req.body);

  // الإلغاء والتأجيل بنفس صلاحية /reject
  if (["cancelled", "postponed"].includes(status) && !(await employeeHasAny(req.actor.id, ["orders.cancel"]))) {
    throw new ApiError(403, "لا تملك صلاحية إلغاء أو تأجيل الطلبيات");
  }

  const result = await withTransaction(async (client) => {
    const { rows } = await client.query(`SELECT * FROM orders WHERE id = $1 FOR UPDATE`, [req.params.id]);
    if (!rows.length) throw new ApiError(404, "الطلبية غير موجودة");
    const order = rows[0];
    const why = checkTransition(order, status);
    if (why) throw new ApiError(400, why);
    return applyManualStatus(client, order, status, req.actor, { note, ip: req.ip });
  });

  res.json(result);
}));

// أهلية السائق: موظف نشط بدور "مندوب"
async function assertActiveDriver(client, driverId) {
  const { rows } = await client.query(
    `SELECT 1 FROM employees e JOIN roles r ON r.id = e.role_id
      WHERE e.id = $1 AND e.is_active AND r.code = 'driver'`, [driverId]
  );
  if (!rows.length) throw new ApiError(400, "المندوب المختار غير موجود أو غير نشط");
}

const ASSIGNABLE_STATUSES = ["sent_to_supplier", "supplier_preparing", "shortage", "ready", "ready_for_delivery", "assigned_to_driver"];

// يرجع نص سبب الرفض أو null لو الطلبية قابلة للإسناد لمندوب
async function checkAssignable(client, order) {
  if (order.fulfillment !== "delivery") return "الطلبية للاستلام الشخصي";
  if (["out_for_delivery", "delivered", "closed"].includes(order.status)) {
    return "الطلبية خرجت للتوصيل أو تم تسليمها — ما يصحش إعادة إسنادها";
  }
  if (!ASSIGNABLE_STATUSES.includes(order.status)) return "حالة الطلبية الحالية لا تسمح بإسنادها لمندوب";
  const { rows: [r] } = await client.query(
    `SELECT COUNT(*)::INT AS total,
            COUNT(*) FILTER (WHERE status IN ('pending','sent','shortage'))::INT AS unconfirmed
       FROM order_suppliers WHERE order_id = $1 AND status <> 'cancelled'`, [order.id]
  );
  if (!r.total) return "الطلبية ما فيهاش أجزاء موردين فعّالة";
  if (r.unconfirmed > 0) return "لسا فيه أجزاء ما أكدها الموردين أو فيها نقص ما اتحلش";
  return null;
}

async function assignDriverTx(client, order, driverId, actor, { note, ip, audit = true }) {
  const reassign = order.status === "assigned_to_driver" && order.driver_id && order.driver_id !== driverId;
  // الإسناد لا يبدأ التوصيل فعليًا — بس يربط الطلبية بالمندوب وتصير تظهرله في تطبيقه
  // تحت "المسندة إليّ". المندوب نفسه هو اللي يضغط "بدء التوصيل" لما يطلع فعليًا بالطلبية
  const { rows: [updated] } = await client.query(
    `UPDATE orders SET driver_id = $2, assigned_at = now(), status = 'assigned_to_driver', cod_amount = $3
     WHERE id = $1 RETURNING *`,
    [order.id, driverId, computeCod(order)]
  );
  await recordStatus(client, {
    orderId: order.id, from: order.status, to: "assigned_to_driver", actor,
    note: note ?? (reassign ? "إعادة إسناد لمندوب آخر" : null),
  });
  if (audit) {
    await writeAudit(client, {
      actorType: "employee", actorId: actor.id, actorName: actor.name,
      action: "order.driver_assigned", entityType: "order", entityId: order.id,
      entityLabel: order.order_number, before: order, after: updated, ip,
    });
  }
  await queueNotification(client, {
    templateCode: "delivery.scheduled", recipientType: "customer",
    recipientId: order.customer_id, orderId: order.id,
    vars: { order_number: order.order_number },
  });
  return updated;
}

// تعديل نسبة العمولة لفاتورة (جزء مورد) واحدة فقط — استثناء معزول، لا يمس نسبة المورد الأساسية
// ولا أي فاتورة أخرى قديمة أو جديدة. متاح حتى بعد التسليم (تسوية لاحقة)، بصلاحية خاصة بيه
// (orders.commission_override) منفصلة عن صلاحية تعديل نسبة المورد الأساسية، ويتسجل في سجل
// حالة الطلبية (order_status_history) عشان يبان في الجدول الزمني للطلبية نفسها، مو بس بسجل التدقيق العام
orderRouter.patch("/order-suppliers/:id/commission-rate", requirePermission("orders.commission_override"), asyncRoute(async (req, res) => {
  const { commissionRate } = z.object({
    commissionRate: z.number().min(0).max(100),
  }).parse(req.body);

  const result = await withTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT os.*, o.order_number, o.status AS order_status FROM order_suppliers os
         JOIN orders o ON o.id = os.order_id
        WHERE os.id = $1 FOR UPDATE`,
      [req.params.id]
    );
    if (!rows.length) throw new ApiError(404, "الجزء غير موجود");
    const before = rows[0];
    if (!(await orderInEmployeeScope(req.actor.id, before.order_id))) throw new ApiError(403, OUT_OF_SCOPE_MSG);

    const { rows: [updated] } = await client.query(
      `UPDATE order_suppliers SET commission_rate = $2 WHERE id = $1 RETURNING *`,
      [req.params.id, commissionRate]
    );

    await recordStatus(client, {
      orderId: before.order_id, orderSupplierId: before.id,
      from: before.order_status, to: before.order_status, actor: req.actor,
      note: `تعديل نسبة العمولة يدويًا من ${before.commission_rate}% إلى ${commissionRate}% (فاتورة المورد ${before.order_number})`,
    });
    await writeAudit(client, {
      actorType: "employee", actorId: req.actor.id, actorName: req.actor.name,
      action: "order_supplier.commission_rate_overridden", entityType: "order_supplier", entityId: before.id,
      entityLabel: before.order_number, before, after: updated, ip: req.ip,
    });
    return updated;
  });

  res.json(result);
}));

// تغيير طريقة تسليم الطلبية (استلام شخصي ↔ توصيل) — قبل إسناد مندوب
orderRouter.patch("/:id/fulfillment", requirePermission("orders.review"), requireOrderScope, asyncRoute(async (req, res) => {
  const body = z.object({
    fulfillment: z.enum(["delivery", "pickup"]),
    deliveryZoneId: z.string().uuid().optional(),
    vehicleTypeId: z.string().uuid().optional(),
    vehiclesCount: z.number().int().min(1).max(50).default(1),
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
    if (body.fulfillment === "delivery" && !body.vehicleTypeId && !body.deliveryZoneId) {
      throw new ApiError(400, "اختر نوع السيارة (أو منطقة التوصيل) للتوصيل");
    }

    // طريقة الدفع لازم تتوافق مع نوع التسليم (نقدًا عند الاستلام ↔ الدفع عند المورد)
    let paymentMethod = order.payment_method;
    if (body.fulfillment === "pickup" && paymentMethod === "cash") paymentMethod = "pay_at_supplier";
    if (body.fulfillment === "delivery" && paymentMethod === "pay_at_supplier") paymentMethod = "cash";

    const isDelivery = body.fulfillment === "delivery";
    await client.query(
      `UPDATE orders SET fulfillment = $2, payment_method = $3, delivery_fee_overridden = FALSE,
              delivery_zone_id = $4, vehicle_type_id = $5, vehicles_count = $6
        WHERE id = $1`,
      [order.id, body.fulfillment, paymentMethod,
       isDelivery ? (body.deliveryZoneId ?? null) : null,
       isDelivery ? (body.vehicleTypeId ?? null) : null,
       isDelivery ? body.vehiclesCount : 1]
    );
    await recalcOrderTotals(client, order.id); // يحسب رسوم التوصيل من الموردين الفعليين
    const { rows: [updated] } = await client.query(`SELECT * FROM orders WHERE id = $1`, [order.id]);

    await recordStatus(client, {
      orderId: order.id, from: order.status, to: order.status, actor: req.actor,
      note: `تم تغيير طريقة التسليم إلى: ${isDelivery ? "توصيل" : "استلام شخصي"}` +
            (paymentMethod !== order.payment_method ? ` (وتعديل طريقة الدفع تلقائيًا لتتوافق)` : ""),
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

// تعديل يدوي لرسوم التوصيل — حسب الاتفاق مع العميل، بدل الاعتماد حصرًا على حساب
// المنطقة+نوع السيارة الثابت. متاح حتى بعد التسليم (تسوية لاحقة)، بصلاحية خاصة بيه
// (orders.delivery_fee_override) منفصلة عن صلاحية مراجعة الطلبيات العامة
orderRouter.patch("/:id/delivery-fee", requirePermission("orders.delivery_fee_override"), requireOrderScope, asyncRoute(async (req, res) => {
  const { deliveryFee, note } = z.object({
    deliveryFee: z.number().nonnegative().max(10000000),
    note: z.string().max(300).optional(),
  }).parse(req.body);

  const result = await withTransaction(async (client) => {
    const { rows } = await client.query(`SELECT * FROM orders WHERE id = $1 FOR UPDATE`, [req.params.id]);
    if (!rows.length) throw new ApiError(404, "الطلبية غير موجودة");
    const order = rows[0];

    if (order.fulfillment !== "delivery") {
      throw new ApiError(400, "هذي طلبية استلام شخصي، لا رسوم توصيل عليها");
    }
    if (["delivered", "closed", "cancelled"].includes(order.status)) {
      throw new ApiError(400, "ما تقدرش تعدل رسوم التوصيل بعد تسليم الطلبية أو إلغائها");
    }

    // العلم delivery_fee_overridden يحمي الرقم اليدوي من إعادة الحساب التلقائية بعد أي تعديل على الأصناف
    await client.query(
      `UPDATE orders SET delivery_fee = $2, delivery_fee_overridden = TRUE WHERE id = $1`,
      [order.id, round2(deliveryFee)]
    );
    await recalcOrderTotals(client, order.id);
    const { rows: [updated] } = await client.query(`SELECT * FROM orders WHERE id = $1`, [order.id]);

    await recordStatus(client, {
      orderId: order.id, from: order.status, to: order.status, actor: req.actor,
      note: `تعديل رسوم التوصيل يدويًا من ${Number(order.delivery_fee).toFixed(2)} د.ل إلى ${Number(deliveryFee).toFixed(2)} د.ل` +
            (note ? ` — ${note}` : ""),
    });
    await writeAudit(client, {
      actorType: "employee", actorId: req.actor.id, actorName: req.actor.name,
      action: "order.delivery_fee_updated", entityType: "order", entityId: order.id,
      entityLabel: order.order_number, before: order, after: updated, ip: req.ip,
    });

    return updated;
  });

  res.json(result);
}));

// تحويل دفعي لحالة عدة طلبيات مرة واحدة — تُستخدم من شاشة "كل الطلبيات"
orderRouter.patch("/bulk-status", requirePermission("orders.review"), asyncRoute(async (req, res) => {
  const { orderIds, status, note, driverId } = z.object({
    orderIds: z.array(z.string().uuid()).min(1).max(100),
    status: z.string().max(40),
    note: z.string().max(500).optional(),
    driverId: z.string().uuid().optional(),
  }).parse(req.body);

  // التحويل الجماعي إلى "مسندة لمندوب" يحتاج مندوبًا محددًا، ويتخطى تلقائيًا
  // أي طلبية استلام شخصي ضمن التحديد (ما تحتاجش مندوب أصلًا)
  if (status === "assigned_to_driver" && !driverId) {
    throw new ApiError(400, "يلزم اختيار مندوب للتحويل الجماعي إلى هذه الحالة");
  }
  // الإلغاء والتأجيل بنفس صلاحية /reject
  if (["cancelled", "postponed"].includes(status) && !(await employeeHasAny(req.actor.id, ["orders.cancel"]))) {
    throw new ApiError(403, "لا تملك صلاحية إلغاء أو تأجيل الطلبيات");
  }
  const canAssign = status !== "assigned_to_driver" || await employeeHasAny(req.actor.id, ["orders.assign_driver"]);
  if (!canAssign) throw new ApiError(403, "لا تملك صلاحية إسناد الطلبيات لمندوب");

  const scope = await getEmployeeSectionScope(req.actor.id);

  const result = await withTransaction(async (client) => {
    if (status === "assigned_to_driver") await assertActiveDriver(client, driverId);

    const updated = [];
    const skipped = [];

    for (const orderId of [...new Set(orderIds)].sort()) {
      const { rows } = await client.query(`SELECT * FROM orders WHERE id = $1 FOR UPDATE`, [orderId]);
      if (!rows.length) { skipped.push({ orderId, reason: "غير موجودة" }); continue; }
      const order = rows[0];
      const skip = (reason) => skipped.push({ orderId, orderNumber: order.order_number, reason });

      if (scope !== null) {
        const { rows: secs } = await client.query(
          `SELECT DISTINCT p.section_id FROM order_items oi JOIN products p ON p.id = oi.product_id
            WHERE oi.order_id = $1`, [orderId]
        );
        if (!secs.every((s) => scope.has(s.section_id))) { skip("خارج نطاق أقسامك"); continue; }
      }

      // كل طلبية داخل SAVEPOINT: فشل طلبية واحدة (مثلًا مخزون/سقف آجل) ما يلغي الباقي
      await client.query("SAVEPOINT bulk_one");
      try {
        if (status === "assigned_to_driver") {
          const why = await checkAssignable(client, order);
          if (why) { await client.query("RELEASE SAVEPOINT bulk_one"); skip(why); continue; }
          updated.push(await assignDriverTx(client, order, driverId, req.actor, { note, ip: req.ip, audit: false }));
        } else {
          const why = checkTransition(order, status);
          if (why) { await client.query("RELEASE SAVEPOINT bulk_one"); skip(why); continue; }
          updated.push(await applyManualStatus(client, order, status, req.actor, { note, ip: req.ip, audit: false }));
        }
        await client.query("RELEASE SAVEPOINT bulk_one");
      } catch (err) {
        await client.query("ROLLBACK TO SAVEPOINT bulk_one");
        await client.query("RELEASE SAVEPOINT bulk_one");
        if (!(err instanceof ApiError)) throw err;
        skip(err.message);
      }
    }

    // سجل تدقيق ملخّص واحد للعملية كلها
    await writeAudit(client, {
      actorType: "employee", actorId: req.actor.id, actorName: req.actor.name,
      action: "order.bulk_status_changed", entityType: "order", entityId: null,
      entityLabel: `${status} (${updated.length}/${orderIds.length})`,
      after: {
        status, driverId: driverId ?? null, note: note ?? null, requested: orderIds.length,
        updated: updated.map((u) => u.order_number),
        skipped: skipped.map((s) => ({ order: s.orderNumber ?? s.orderId, reason: s.reason })),
      },
      ip: req.ip,
    });

    return { updated, skipped };
  });

  res.json({
    updatedCount: result.updated.length,
    skippedCount: result.skipped.length,
    updated: result.updated,
    skipped: result.skipped,
  });
}));

/* ===================================================================
   توفر الأصناف عند المورد (تأكيد + خصم المخزون)
=================================================================== */

orderRouter.post("/supplier-parts/:osId/availability", requireActorType("supplier"), asyncRoute(async (req, res) => {
  const body = z.object({
    items: z.array(z.object({
      orderItemId: z.string().uuid(),
      availability: z.string().nullish(),
      qtyConfirmed: z.number().nonnegative().max(MAX_LINE_QTY).optional(),
    })).min(1).max(500),
  }).parse(req.body);

  // لازم المورد يحدد حالة التوفر لكل صنف صراحة — ما فيش افتراضي مخفي من السيرفر
  for (const it of body.items) {
    if (!["full", "partial", "out"].includes(it.availability)) {
      throw new ApiError(400, "يلزم تحديد حالة التوفر لكل صنف (متوفر كامل / جزئي / غير متوفر)");
    }
    if (it.availability === "partial" && it.qtyConfirmed === undefined) {
      throw new ApiError(400, "يلزم إدخال الكمية المتوفرة للأصناف المتوفرة جزئيًا");
    }
  }

  const result = await withTransaction(async (client) => {
    // قفل الطلبية أولًا (ترتيب موحّد للأقفال: الطلبية ثم جزء المورد) لمنع التعارض والـdeadlock
    await client.query(
      `SELECT 1 FROM orders WHERE id = (SELECT order_id FROM order_suppliers WHERE id = $1) FOR UPDATE`,
      [req.params.osId]
    );
    const { rows } = await client.query(
      `SELECT os.*, o.order_number, o.customer_id, o.status AS order_status
         FROM order_suppliers os JOIN orders o ON o.id = os.order_id
        WHERE os.id = $1 AND os.supplier_id = $2 FOR UPDATE`,
      [req.params.osId, req.actor.id]
    );
    if (!rows.length) throw new ApiError(404, "الجزء غير موجود");
    const part = rows[0];

    if (part.status !== "sent") {
      throw new ApiError(400, "تم تسجيل توفر هذا الجزء من قبل");
    }
    // الطلبية المؤجلة/الملغاة/قيد المراجعة ما ينفعش يتأكد توفرها
    if (!["sent_to_supplier", "supplier_preparing", "shortage"].includes(part.order_status)) {
      throw new ApiError(409, "الطلبية غير مفعّلة حاليًا (مؤجلة أو ملغاة أو منتهية) ولا يمكن تسجيل التوفر عليها");
    }

    // الأصناف المرسلة لازم تطابق بالضبط أصناف هذا الجزء — لا ناقص ولا غريب ولا مكرر
    const { rows: partItems } = await client.query(
      `SELECT * FROM order_items WHERE order_supplier_id = $1 FOR UPDATE`, [part.id]
    );
    const itemById = new Map(partItems.map((i) => [i.id, i]));
    const seen = new Set();
    for (const it of body.items) {
      if (seen.has(it.orderItemId)) throw new ApiError(400, "صنف مكرر في الطلب");
      seen.add(it.orderItemId);
      if (!itemById.has(it.orderItemId)) throw new ApiError(404, "صنف غير موجود في هذا الجزء");
    }
    if (seen.size !== partItems.length) {
      throw new ApiError(400, "لازم تحدد توفر كل أصناف الفاتورة — فيه أصناف ناقصة في الطلب");
    }

    let hasShortage = false;
    let subtotal = 0;

    for (const it of body.items) {
      const item = itemById.get(it.orderItemId);
      const requested = Number(item.qty_requested);

      // تطبيع الحالة: جزئي بكمية >= المطلوب = كامل، وجزئي بكمية صفر = غير متوفر
      let availability = it.availability;
      let qty;
      if (availability === "full") qty = requested;
      else if (availability === "out") qty = 0;
      else {
        qty = round3(Math.min(it.qtyConfirmed, requested));
        if (!isFractionalUnit(item.unit) && !Number.isInteger(qty)) {
          throw new ApiError(400, `الكمية لازم تكون رقم صحيح للصنف: ${item.product_name}`);
        }
        if (qty >= requested) { availability = "full"; qty = requested; }
        else if (qty <= 0) { availability = "out"; qty = 0; }
      }

      const lineTotal = round2(Number(item.unit_price) * qty);
      await client.query(
        `UPDATE order_items SET availability = $2, qty_confirmed = $3, line_total = $4 WHERE id = $1`,
        [item.id, availability, qty, lineTotal]
      );
      subtotal += lineTotal;

      if (qty > 0) {
        await adjustStock(client, {
          productId: item.product_id, variantId: item.variant_id, delta: -qty,
          reason: stockReasons(part.order_number).sale, actorId: req.actor.id,
        });
      }

      if (availability !== "full") {
        hasShortage = true;
        await client.query(
          `INSERT INTO order_shortages (order_item_id, qty_missing) VALUES ($1,$2)`,
          [item.id, round3(requested - qty)]
        );
      }
    }
    subtotal = round2(subtotal);

    const newStatus = hasShortage ? "shortage" : "preparing";
    await client.query(
      `UPDATE order_suppliers SET status = $2, subtotal = $3 WHERE id = $1`,
      [part.id, newStatus, subtotal]
    );
    await recordStatus(client, {
      orderId: part.order_id, orderSupplierId: part.id,
      from: part.status, to: newStatus, actor: req.actor,
    });
    await recalcOrderTotals(client, part.order_id, { refreshFee: false });

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

orderRouter.get("/:id/shortages", requirePermission("orders.review"), requireOrderScope, asyncRoute(async (req, res) => {
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

  // نعرف الطلبية أولًا لنطبّق نطاق الأقسام ونقفلها قبل سجل النقص (ترتيب موحّد للأقفال)
  const { rows: [pre] } = await query(
    `SELECT oi.order_id FROM order_shortages sh JOIN order_items oi ON oi.id = sh.order_item_id WHERE sh.id = $1`,
    [req.params.id]
  );
  if (!pre) throw new ApiError(404, "سجل النقص غير موجود");
  if (!(await orderInEmployeeScope(req.actor.id, pre.order_id))) throw new ApiError(403, OUT_OF_SCOPE_MSG);

  const result = await withTransaction(async (client) => {
    const { rows: [order] } = await client.query(`SELECT * FROM orders WHERE id = $1 FOR UPDATE`, [pre.order_id]);
    if (["delivered", "closed", "cancelled"].includes(order.status)) {
      throw new ApiError(400, "لا يمكن تعديل طلبية مغلقة أو ملغاة");
    }
    const { rows } = await client.query(
      `SELECT sh.*, oi.order_id, oi.order_supplier_id FROM order_shortages sh
         JOIN order_items oi ON oi.id = sh.order_item_id
        WHERE sh.id = $1 FOR UPDATE`,
      [req.params.id]
    );
    if (!rows.length) throw new ApiError(404, "سجل النقص غير موجود");
    const shortage = rows[0];

    if (body.resolution === "cancel_item") {
      // "إلغاء الصنف" يشيله فعليًا من الفاتورة فورًا (مش بس يصفّره وينتظر حذف يدوي لاحقًا) —
      // هذا يمنع بقاء أصناف صفرية عالقة تظهر بالغلط في الفاتورة وعند مندوب التوصيل.
      // الكمية المؤكدة (اللي اتخصمت من المخزون وقت التأكيد) ترجع للمخزون في نفس المعاملة
      const { rows: [item] } = await client.query(`SELECT * FROM order_items WHERE id = $1 FOR UPDATE`, [shortage.order_item_id]);
      if (item && Number(item.qty_confirmed || 0) > 0) {
        await adjustStock(client, {
          productId: item.product_id, variantId: item.variant_id, delta: Number(item.qty_confirmed),
          reason: stockReasons(order.order_number).editBack, actorId: req.actor.id,
        });
      }
      const { rows: [shPart] } = await client.query(`SELECT supplier_id FROM order_suppliers WHERE id = $1`, [shortage.order_supplier_id]);
      await client.query(`DELETE FROM order_shortages WHERE order_item_id = $1`, [shortage.order_item_id]);
      await client.query(`DELETE FROM order_items WHERE id = $1`, [shortage.order_item_id]);
      await recalcOrderTotals(client, shortage.order_id);
      await settlePartShortageStatus(client, shortage.order_supplier_id);

      // لو انشال آخر صنف في الطلبية ما يبقى معنى لها — تُلغى
      const { rows: [left] } = await client.query(
        `SELECT COUNT(*)::INT AS n FROM order_items WHERE order_id = $1`, [shortage.order_id]
      );
      if (shPart && left.n > 0) {
        await notifySuppliers(client, {
          supplierIds: [shPart.supplier_id], order, templateCode: "order.part_items_changed",
          change: `أُلغي الصنف ${item?.product_name ?? ""} بسبب النقص`.trim(),
        });
      }
      if (left.n === 0) {
        const allSuppliers = await activeSupplierIds(client, shortage.order_id);
        await notifySuppliers(client, {
          supplierIds: [...allSuppliers, ...(shPart ? [shPart.supplier_id] : [])], order, reason: "إلغاء كل الأصناف بسبب النقص", templateCode: "order.part_cancelled",
        });
        await client.query(
          `UPDATE orders SET status = 'cancelled', cancel_reason = 'تم إلغاء كل أصناف الطلبية بسبب النقص' WHERE id = $1`,
          [shortage.order_id]
        );
        await client.query(
          `UPDATE order_suppliers SET status = 'cancelled' WHERE order_id = $1 AND status NOT IN ('picked_up','closed','cancelled')`,
          [shortage.order_id]
        );
        await recordStatus(client, {
          orderId: shortage.order_id, from: order.status, to: "cancelled", actor: req.actor,
          note: "تم إلغاء كل أصناف الطلبية بسبب النقص",
        });
        await restoreOrderStock(client, shortage.order_id, req.actor.id);
      }

      await writeAudit(client, {
        actorType: "employee", actorId: req.actor.id, actorName: req.actor.name,
        action: "shortage.resolved_cancel_item", entityType: "order_shortage", entityId: shortage.id,
        before: shortage, ip: req.ip,
      });

      return { orderId: shortage.order_id, resolution: "cancel_item", itemRemoved: true, orderCancelled: left.n === 0 };
    }

    const { rows: [updated] } = await client.query(
      `UPDATE order_shortages SET
         resolution = $2, substitute_product_id = $3,
         customer_approved = TRUE, admin_approved = TRUE,
         resolved_by = $4, resolved_at = now()
       WHERE id = $1 RETURNING *`,
      [shortage.id, body.resolution, body.substituteProductId ?? null, req.actor.id]
    );

    await recalcOrderTotals(client, shortage.order_id);
    await settlePartShortageStatus(client, shortage.order_supplier_id);

    await writeAudit(client, {
      actorType: "employee", actorId: req.actor.id, actorName: req.actor.name,
      action: "shortage.resolved", entityType: "order_shortage", entityId: shortage.id,
      after: updated, ip: req.ip,
    });
    return updated;
  });

  res.json(result);
}));

/* ===================================================================
   إسناد المندوب والتوصيل
=================================================================== */

orderRouter.post("/:id/assign-driver", requirePermission("orders.assign_driver"), requireOrderScope, asyncRoute(async (req, res) => {
  const { driverId } = z.object({ driverId: z.string().uuid() }).parse(req.body);

  const result = await withTransaction(async (client) => {
    await assertActiveDriver(client, driverId);
    const { rows } = await client.query(`SELECT * FROM orders WHERE id = $1 FOR UPDATE`, [req.params.id]);
    if (!rows.length) throw new ApiError(404, "الطلبية غير موجودة");
    const order = rows[0];
    const why = await checkAssignable(client, order);
    if (why) throw new ApiError(409, why);
    return assignDriverTx(client, order, driverId, req.actor, { ip: req.ip });
  });

  res.json(result);
}));

// المندوب يضغط هذا الزر لما يطلع فعليًا من المخزن بالطلبية — هنا بس تتحول الحالة
// إلى "في الطريق" فعليًا، بعد ما كانت مجرد "مسندة إليه"
orderRouter.post("/:id/start-delivery", requireActorType("employee"), asyncRoute(async (req, res) => {
  if (req.actor.role !== "driver") throw new ApiError(403, "هذا الإجراء مخصص لمندوبي التوصيل");

  const result = await withTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT * FROM orders WHERE id = $1 AND driver_id = $2 FOR UPDATE`,
      [req.params.id, req.actor.id]
    );
    if (!rows.length) throw new ApiError(404, "الطلبية غير مسندة إليك");
    const order = rows[0];
    if (order.status !== "assigned_to_driver") {
      throw new ApiError(400, "لا يمكن بدء التوصيل في حالة هذه الطلبية الحالية");
    }

    const { rows: [updated] } = await client.query(
      `UPDATE orders SET status = 'out_for_delivery' WHERE id = $1 RETURNING *`,
      [order.id]
    );
    await recordStatus(client, {
      orderId: order.id, from: "assigned_to_driver", to: "out_for_delivery", actor: req.actor,
    });
    await writeAudit(client, {
      actorType: "employee", actorId: req.actor.id, actorName: req.actor.name,
      action: "order.delivery_started", entityType: "order", entityId: order.id,
      entityLabel: order.order_number, after: updated, ip: req.ip,
    });
    await queueNotification(client, {
      templateCode: "order.status", recipientType: "customer",
      recipientId: order.customer_id, orderId: order.id,
      vars: { order_number: order.order_number, status: "في الطريق إليك" },
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
    if (order.status !== "out_for_delivery") {
      throw new ApiError(400, "لازم تبدأ التوصيل أولًا قبل تأكيد التسليم");
    }

    // المبلغ المتبقي على العميل وقت التسليم (بعد أي حوالة أكدتها الإدارة). الطلبية الخالصة = 0.
    // المندوب ما يقدر يسلّم لو باقي مبلغ إلا بعد ما يؤكد إنه استلمه (الآجل له معاملته الخاصة).
    const dueNow = order.payment_method === "deferred"
      ? Number(order.cod_amount || 0)
      : Math.max(0, round2(Number(order.grand_total) - Number(order.paid_amount)));
    if (order.payment_method !== "deferred" && dueNow > 0 && !collected) {
      throw new ApiError(400, `باقي على الزبون ${dueNow} د.ل — لازم تستلمه وتأكد الاستلام قبل التسليم`);
    }
    if (order.payment_method !== "deferred" && Number(order.cod_amount) !== dueNow) {
      await client.query(`UPDATE orders SET cod_amount = $2 WHERE id = $1`, [order.id, dueNow]);
      order.cod_amount = dueNow;
    }
    const collectedEffective = dueNow > 0 && collected;

    const { rows: [updated] } = await client.query(
      `UPDATE orders SET status = 'delivered', delivered_at = now(),
              cod_collected = $2,
              paid_amount = paid_amount + CASE WHEN $2 THEN LEAST(cod_amount, GREATEST(grand_total - paid_amount, 0)) ELSE 0 END,
              payment_status = CASE
                WHEN $2 AND paid_amount + cod_amount >= grand_total THEN 'paid'
                WHEN $2 THEN 'partially_paid' ELSE payment_status END
       WHERE id = $1 RETURNING *`,
      [order.id, collectedEffective]
    );
    await recordStatus(client, {
      orderId: order.id, from: order.status, to: "delivered", actor: req.actor,
      note: collectedEffective ? `تم تحصيل ${order.cod_amount}` : (dueNow > 0 ? "تسليم بدون تحصيل" : "تسليم — الطلبية خالصة"),
    });

    // سند قبض حقيقي برقم رسمي باسم المندوب اللي حصّل المبلغ
    if (collectedEffective && Number(order.cod_amount) > 0) {
      const { rows: tr } = await client.query(
        `SELECT id FROM treasuries WHERE code = $1`, [resolveTreasuryCode("receipt", "cash")]
      );
      if (tr.length) {
        const { rows: custRows } = await client.query(
          `SELECT business_name FROM customers WHERE id = $1`, [order.customer_id]
        );
        const vNumber = await nextDocNumber(client, {
          table: "vouchers", column: "voucher_number", prefix: "V", start: 1000,
        });
        await client.query(
          `INSERT INTO vouchers
             (voucher_number, voucher_type, party_type, party_id, party_name,
              amount, method, treasury_id, order_id, approval_status, approved_by, approved_at,
              note, created_by, off_treasury)
           VALUES ($1,'receipt','customer',$2,$3,$4,'cash',$5,$6,'approved',$7,now(),$8,$7,true)`,
          [vNumber, order.customer_id, custRows[0]?.business_name ?? "عميل", order.cod_amount,
           tr[0].id, order.id, req.actor.id,
           `تحصيل نقدي عند التسليم — حصّلها المندوب ${req.actor.name} لطلبية ${order.order_number}`]
        );
      }
    }

    await client.query(
      `UPDATE order_suppliers SET status = 'closed'
        WHERE order_id = $1 AND status NOT IN ('closed','cancelled')`,
      [order.id]
    );
    await writeAudit(client, {
      actorType: "employee", actorId: req.actor.id, actorName: req.actor.name,
      action: "order.delivered", entityType: "order", entityId: order.id,
      entityLabel: order.order_number, after: updated, ip: req.ip,
    });

    const { rows: supplierNames } = await client.query(
      `SELECT DISTINCT s.business_name FROM order_suppliers os
         JOIN suppliers s ON s.id = os.supplier_id WHERE os.order_id = $1`,
      [order.id]
    );
    await queueNotification(client, {
      templateCode: "order.delivered_thanks", recipientType: "customer",
      recipientId: order.customer_id, orderId: order.id,
      vars: {
        order_number: order.order_number,
        total: Number(updated.grand_total).toFixed(2),
        suppliers: supplierNames.map((s) => s.business_name).join("، "),
      },
    });

    return updated;
  });

  res.json(result);
}));

/* ===================================================================
   استلام شخصي من المورد
=================================================================== */

orderRouter.post("/supplier-parts/:osId/pickup-confirm", requireActorType("supplier"), asyncRoute(async (req, res) => {
  const { paymentReceived, amountReceived } = z.object({
    paymentReceived: z.boolean(),
    amountReceived: z.number().min(0).max(100000000).optional(),
  }).parse(req.body);

  const result = await withTransaction(async (client) => {
    // قفل الطلبية أولًا (ترتيب موحّد للأقفال: الطلبية ثم جزء المورد) لمنع التعارض والـdeadlock
    await client.query(
      `SELECT 1 FROM orders WHERE id = (SELECT order_id FROM order_suppliers WHERE id = $1) FOR UPDATE`,
      [req.params.osId]
    );
    const { rows } = await client.query(
      `SELECT os.*, o.order_number, o.payment_method, o.customer_id, o.fulfillment, o.status AS order_status
         FROM order_suppliers os JOIN orders o ON o.id = os.order_id
        WHERE os.id = $1 AND os.supplier_id = $2 FOR UPDATE`,
      [req.params.osId, req.actor.id]
    );
    if (!rows.length) throw new ApiError(404, "الجزء غير موجود");
    const part = rows[0];

    if (part.fulfillment !== "pickup") {
      throw new ApiError(400, "هذه طلبية توصيل — تُسلَّم عبر مندوب جملة وليس من هنا");
    }
    if (!["sent_to_supplier", "supplier_preparing", "shortage", "ready_for_pickup", "awaiting_pickup"].includes(part.order_status)) {
      throw new ApiError(409, "حالة الطلبية الحالية لا تسمح بتأكيد الاستلام (مؤجلة أو ملغاة أو منتهية)");
    }
    if (part.status !== "ready") {
      throw new ApiError(400, "لازم تعلّم الفاتورة كجاهزة أولًا قبل تأكيد حضور العميل");
    }

    // المبلغ المطلوب استلامه نقدًا من العميل عند التسليم
    let due = 0;
    if (CASH_LIKE.includes(part.payment_method)) {
      due = round2(part.subtotal);
      if (due > 0) {
        if (!paymentReceived) throw new ApiError(400, "يلزم تأكيد استلام قيمة الفاتورة من العميل قبل التسليم");
        if (amountReceived === undefined || Math.abs(amountReceived - due) > 0.01) {
          throw new ApiError(400, `لازم تدخل المبلغ المستلم، وقيمة هذه الفاتورة ${due} د.ل`);
        }
      }
    } else if (part.payment_method === "transfer") {
      // الحوالة: المدفوع فعليًا هو اللي أكدته الإدارة. لو باقي مبلغ على العميل، المورد لازم يستلمه نقدًا
      // ويأكد استلامه قبل التسليم. لو الطلبية خالصة، يسلّم بدون أي تحصيل.
      const { rows: [ord] } = await client.query(
        `SELECT grand_total, paid_amount, remaining_collector_id FROM orders WHERE id = $1`, [part.order_id]
      );
      const { rows: allParts } = await client.query(
        `SELECT id, supplier_id, subtotal, pickup_confirmed, status FROM order_suppliers WHERE order_id = $1`, [part.order_id]
      );
      if (Number(ord.paid_amount) <= 0) {
        throw new ApiError(409, "الحوالة لم تُؤكَّد من الإدارة بعد — انتظر تأكيد الإدارة قبل تسليم الطلبية");
      }
      due = computePartDue(ord, allParts, part);
      if (due > 0) {
        if (!paymentReceived) {
          throw new ApiError(400, `باقي على الزبون ${due} د.ل — لازم تستلمه وتأكد الاستلام قبل التسليم`);
        }
        if (amountReceived === undefined || Math.abs(amountReceived - due) > 0.01) {
          throw new ApiError(400, `المبلغ المتبقي المطلوب استلامه من الزبون هو ${due} د.ل`);
        }
      }
    } // الآجل: لا تحصيل عند التسليم

    const received = due > 0 && paymentReceived;
    await client.query(
      `UPDATE order_suppliers
          SET pickup_confirmed = TRUE, payment_received = $2,
              status = 'picked_up', confirmed_at = now()
        WHERE id = $1`,
      [part.id, received]
    );

    const cashNote = part.payment_method === "transfer" ? " (المتبقي بعد الحوالة)" : "";
    if (received) {
      await client.query(
        `UPDATE orders SET
            paid_amount = ROUND(paid_amount + $2, 2),
            payment_status = CASE WHEN paid_amount + $2 >= grand_total THEN 'paid' ELSE 'partially_paid' END
          WHERE id = $1`,
        [part.order_id, due]
      );

      // سند قبض حقيقي برقم رسمي — يظهر في كشف حساب العميل كدفعة موثّقة بدل سطر بلا رقم
      const { rows: tr } = await client.query(
        `SELECT id FROM treasuries WHERE code = $1`, [resolveTreasuryCode("receipt", "cash")]
      );
      if (tr.length) {
        const { rows: custRows } = await client.query(
          `SELECT business_name FROM customers WHERE id = $1`, [part.customer_id]
        );
        const vNumber = await nextDocNumber(client, {
          table: "vouchers", column: "voucher_number", prefix: "V", start: 1000,
        });
        await client.query(
          `INSERT INTO vouchers
             (voucher_number, voucher_type, party_type, party_id, party_name,
              amount, method, treasury_id, order_id, approval_status, approved_by, approved_at,
              note, created_by, off_treasury)
           VALUES ($1,'receipt','customer',$2,$3,$4,'cash',$5,$6,'approved',NULL,now(),$7,NULL,true)`,
          [vNumber, part.customer_id, custRows[0]?.business_name ?? "عميل", due,
           tr[0].id, part.order_id, `دفع نقدًا عند الاستلام${cashNote} — استلمها المورد ${req.actor.name} لطلبية ${part.order_number}`]
        );
      }

      // سند دفع مقابل — يعكس إن المورد احتفظ بالمبلغ لنفسه (خصمًا مما تدين له به الشركة)
      const { rows: trPay } = await client.query(
        `SELECT id FROM treasuries WHERE code = $1`, [resolveTreasuryCode("payment", "cash")]
      );
      if (trPay.length) {
        const vNumber2 = await nextDocNumber(client, {
          table: "vouchers", column: "voucher_number", prefix: "V", start: 1000,
        });
        await client.query(
          `INSERT INTO vouchers
             (voucher_number, voucher_type, party_type, party_id, party_name,
              amount, method, treasury_id, order_id, approval_status, approved_by, approved_at,
              note, created_by, off_treasury)
           VALUES ($1,'payment','supplier',$2,$3,$4,'cash',$5,$6,'approved',NULL,now(),$7,NULL,true)`,
          [vNumber2, req.actor.id, req.actor.name, due, trPay[0].id, part.order_id,
           `استلمها المورد مباشرة من العميل عند الاستلام${cashNote} — طلبية ${part.order_number}`]
        );
      }
    }

    // الأجزاء الملغاة ما تُحسب كمعلّقة (وإلا الطلبية ما تتسلّم أبدًا)
    const { rows: [pending] } = await client.query(
      `SELECT COUNT(*)::INT AS remaining FROM order_suppliers
        WHERE order_id = $1 AND NOT pickup_confirmed AND status <> 'cancelled'`,
      [part.order_id]
    );

    if (pending.remaining === 0) {
      const { rows: [deliveredOrder] } = await client.query(
        `UPDATE orders SET status = 'delivered', delivered_at = now() WHERE id = $1 RETURNING *`,
        [part.order_id]
      );
      await recordStatus(client, {
        orderId: part.order_id, from: part.order_status, to: "delivered", actor: req.actor,
      });

      const { rows: supplierNames } = await client.query(
        `SELECT DISTINCT s.business_name FROM order_suppliers os
           JOIN suppliers s ON s.id = os.supplier_id WHERE os.order_id = $1`,
        [part.order_id]
      );
      await queueNotification(client, {
        templateCode: "order.delivered_thanks", recipientType: "customer",
        recipientId: deliveredOrder.customer_id, orderId: part.order_id,
        vars: {
          order_number: part.order_number,
          total: Number(deliveredOrder.grand_total).toFixed(2),
          suppliers: supplierNames.map((s) => s.business_name).join("، "),
        },
      });
    }

    return { confirmed: true, remainingParts: pending.remaining };
  });

  res.json(result);
}));

// المورد يعلن إنه خلّص تجهيز فاتورته — يحوّل حالة جزئه إلى "جاهز"، ولو كل أجزاء
// الطلبية بقت جاهزة، تتحول حالة الطلبية كاملة تلقائيًا: "جاهزة للتوصيل" (لو توصيل،
// عشان الأدمن يسند مندوب) أو "جاهزة للاستلام" (لو استلام شخصي، بانتظار حضور العميل)
orderRouter.post("/supplier-parts/:osId/mark-ready", requireActorType("supplier"), asyncRoute(async (req, res) => {
  const result = await withTransaction(async (client) => {
    // قفل الطلبية أولًا (ترتيب موحّد للأقفال: الطلبية ثم جزء المورد) لمنع التعارض والـdeadlock
    await client.query(
      `SELECT 1 FROM orders WHERE id = (SELECT order_id FROM order_suppliers WHERE id = $1) FOR UPDATE`,
      [req.params.osId]
    );
    const { rows } = await client.query(
      `SELECT os.*, o.order_number, o.fulfillment, o.status AS order_status
         FROM order_suppliers os JOIN orders o ON o.id = os.order_id
        WHERE os.id = $1 AND os.supplier_id = $2 FOR UPDATE`,
      [req.params.osId, req.actor.id]
    );
    if (!rows.length) throw new ApiError(404, "الجزء غير موجود");
    const part = rows[0];

    if (part.status !== "preparing") {
      throw new ApiError(400, "لا يمكن تعليم هذا الجزء كجاهز في حالته الحالية");
    }
    if (!["sent_to_supplier", "supplier_preparing", "shortage"].includes(part.order_status)) {
      throw new ApiError(409, "الطلبية غير مفعّلة حاليًا (مؤجلة أو ملغاة أو منتهية)");
    }

    await client.query(`UPDATE order_suppliers SET status = 'ready' WHERE id = $1`, [part.id]);
    await recordStatus(client, {
      orderId: part.order_id, orderSupplierId: part.id,
      from: "preparing", to: "ready", actor: req.actor,
    });

    const { rows: [pending] } = await client.query(
      `SELECT COUNT(*)::INT AS remaining FROM order_suppliers
        WHERE order_id = $1 AND status NOT IN ('ready','picked_up','cancelled')`,
      [part.order_id]
    );

    let orderReady = false;
    const nextOrderStatus = part.fulfillment === "delivery" ? "ready_for_delivery" : "ready_for_pickup";
    if (pending.remaining === 0
        && ["sent_to_supplier", "supplier_preparing", "shortage"].includes(part.order_status)) {
      await client.query(`UPDATE orders SET status = $2 WHERE id = $1`, [part.order_id, nextOrderStatus]);
      await recordStatus(client, {
        orderId: part.order_id, from: part.order_status, to: nextOrderStatus, actor: req.actor,
      });
      orderReady = true;
    }

    return { orderSupplierId: part.id, status: "ready", orderReady };
  });

  res.json(result);
}));

/* ===================================================================
   الإيصالات
=================================================================== */

orderRouter.post("/:id/receipt", requirePermission("orders.review"), requireOrderScope, asyncRoute(async (req, res) => {
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
    const remaining = Math.max(0, round2(Number(order.grand_total) - Number(order.paid_amount)));

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

// الإيصالات: العميل صاحب الطلبية أو موظف بصلاحية عرض الطلبيات (ضمن نطاقه) — لا موردين ولا مندوبين
orderRouter.get("/:id/receipts", asyncRoute(async (req, res) => {
  const { rows: ord } = await query(`SELECT customer_id FROM orders WHERE id = $1`, [req.params.id]);
  if (!ord.length) throw new ApiError(404, "الطلبية غير موجودة");
  const a = req.actor;
  const FORBIDDEN = new ApiError(403, "لا تملك صلاحية الاطلاع على هذه الطلبية");
  if (a.type === "customer") {
    if (ord[0].customer_id !== a.id) throw FORBIDDEN;
  } else if (a.type === "employee" && a.role !== "driver") {
    if (!(await employeeHasAny(a.id, STAFF_VIEW_PERMS))) throw FORBIDDEN;
    if (!(await orderInEmployeeScope(a.id, req.params.id))) throw new ApiError(403, OUT_OF_SCOPE_MSG);
  } else {
    throw FORBIDDEN;
  }
  const { rows } = await query(
    `SELECT id, receipt_number, order_id, invoice_total, amount_paid, amount_remaining,
            payment_method, due_date, issued_at
       FROM order_receipts WHERE order_id = $1 ORDER BY issued_at DESC`,
    [req.params.id]
  );
  res.json(rows);
}));

/* ===================================================================
   تعديل أصناف فاتورة طلبية (إدارة) — مع إبقاء المخزون متسقًا
   القاعدة: لو جزء المورد أكّد التوفر (status خارج pending/sent) فالمخزون اتخصم بقيمة
   qty_confirmed، وأي تعديل بعدها يكتب فرق المخزون + حركة مخزون في نفس المعاملة.
=================================================================== */

// إضافة صنف جديد لفاتورة طلبية بعد اعتمادها
orderRouter.post("/:id/items", requirePermission("orders.review"), requireOrderScope, asyncRoute(async (req, res) => {
  const body = z.object({
    productId: z.string().uuid(),
    qty: z.number().positive().max(MAX_LINE_QTY),
    variantId: z.string().uuid().optional(),
  }).parse(req.body);

  const result = await withTransaction(async (client) => {
    const { rows: orderRows } = await client.query(`SELECT * FROM orders WHERE id = $1 FOR UPDATE`, [req.params.id]);
    if (!orderRows.length) throw new ApiError(404, "الطلبية غير موجودة");
    const order = orderRows[0];
    if (["delivered", "cancelled", "closed"].includes(order.status)) {
      throw new ApiError(400, "لا يمكن تعديل فاتورة طلبية تم تسليمها أو إلغاؤها");
    }

    await lockStockForProducts(client, [body.productId]);
    const [line] = await prepareLines(client, order.customer_id, [body]);

    const { rows: osRows } = await client.query(
      `SELECT id, status FROM order_suppliers WHERE order_id = $1 AND supplier_id = $2 FOR UPDATE`,
      [order.id, line.supplier_id]
    );
    let orderSupplierId;
    let partConfirmed = false;
    let partStatusNow = order.status === "under_review" ? "pending" : "sent";
    if (osRows.length) {
      partStatusNow = osRows[0].status;
      orderSupplierId = osRows[0].id;
      partConfirmed = !PART_UNCONFIRMED.includes(osRows[0].status) && osRows[0].status !== "cancelled";
      if (osRows[0].status === "cancelled") throw new ApiError(400, "فاتورة هذا المورد ملغاة في هذه الطلبية");
    } else {
      const { rows: rateRows } = await client.query(
        `SELECT commission_rate_percent FROM suppliers WHERE id = $1`, [line.supplier_id]
      );
      const { rows: createdOs } = await client.query(
        `INSERT INTO order_suppliers (order_id, supplier_id, subtotal, status, commission_rate)
         VALUES ($1,$2,0, CASE WHEN $3 = 'under_review' THEN 'pending' ELSE 'sent' END, $4)
         RETURNING id`,
        [order.id, line.supplier_id, order.status, rateRows[0]?.commission_rate_percent ?? 0]
      );
      orderSupplierId = createdOs[0].id;
      // مورد جديد لسا ما أكّد: لو الطلبية كانت "جاهزة" نرجعها لمرحلة الإرسال للمورد عشان تنتظره
      if (["ready", "ready_for_delivery", "ready_for_pickup"].includes(order.status)) {
        await client.query(`UPDATE orders SET status = 'sent_to_supplier' WHERE id = $1`, [order.id]);
        await recordStatus(client, {
          orderId: order.id, from: order.status, to: "sent_to_supplier", actor: req.actor,
          note: "إضافة مورد جديد للطلبية — بانتظار تأكيد توفره",
        });
      }
    }

    if (partConfirmed) {
      // الجزء مؤكّد: الصنف الجديد يُعتبر مؤكّدًا فورًا ويُخصم من المخزون (يرفض لو ما يكفي)
      await adjustStock(client, {
        productId: line.productId, variantId: line.variantId, delta: -line.qty,
        reason: stockReasons(order.order_number).sale, actorId: req.actor.id,
      });
    } else {
      // الجزء لسا ما أكّد: المورد بيأكده لاحقًا وقتها يتخصم — هنا نتحقق بس من المتاح بعد المحجوز
      await assertStockAvailable(client, [{
        productId: line.productId, variantId: line.variantId, qty: line.qty, label: line.name,
      }]);
    }

    const { rows: [item] } = await client.query(
      `INSERT INTO order_items
         (order_id, order_supplier_id, product_id, product_name, unit,
          unit_price, purchase_cost, qty_requested, qty_confirmed, availability, line_total, supplier_sku,
          variant_id, variant_label)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
      [order.id, orderSupplierId, line.productId, line.name, line.unit, line.price, line.purchase_cost, line.qty,
       partConfirmed ? line.qty : null, partConfirmed ? "full" : null, line.lineTotal, line.supplier_sku,
       line.variantId, line.variantLabel]
    );

    await recalcOrderTotals(client, order.id);

    await recordStatus(client, {
      orderId: order.id, from: order.status, to: order.status, actor: req.actor,
      note: `تمت إضافة صنف: ${line.name} × ${line.qty} ${line.unit}`,
    });
    if (partStatusNow !== "pending") {
      await notifySuppliers(client, {
        supplierIds: [line.supplier_id], order, templateCode: "order.part_items_changed",
        change: `أُضيف الصنف ${line.name} بكمية ${line.qty} ${line.unit ?? ""}`.trim(),
      });
    }
    await writeAudit(client, {
      actorType: "employee", actorId: req.actor.id, actorName: req.actor.name,
      action: "order_item.added", entityType: "order_item", entityId: item.id,
      entityLabel: `${order.order_number} — ${line.name}`, after: item, ip: req.ip,
    });

    const { rows: [updatedOrder] } = await client.query(`SELECT * FROM orders WHERE id = $1`, [order.id]);
    return { item, order: updatedOrder };
  });

  res.status(201).json(result);
}));

// تعديل كمية صنف موجود في فاتورة طلبية
orderRouter.patch("/:id/items/:itemId", requirePermission("orders.review"), requireOrderScope, asyncRoute(async (req, res) => {
  const { qty: rawQty } = z.object({ qty: z.number().positive().max(MAX_LINE_QTY) }).parse(req.body);
  const qty = round3(rawQty);

  const result = await withTransaction(async (client) => {
    const { rows: orderRows } = await client.query(`SELECT * FROM orders WHERE id = $1 FOR UPDATE`, [req.params.id]);
    if (!orderRows.length) throw new ApiError(404, "الطلبية غير موجودة");
    const order = orderRows[0];
    if (["delivered", "cancelled", "closed"].includes(order.status)) {
      throw new ApiError(400, "لا يمكن تعديل فاتورة طلبية تم تسليمها أو إلغاؤها");
    }

    const { rows: itemRows } = await client.query(
      `SELECT oi.*, os.status AS part_status FROM order_items oi
         JOIN order_suppliers os ON os.id = oi.order_supplier_id
        WHERE oi.id = $1 AND oi.order_id = $2 FOR UPDATE OF oi`,
      [req.params.itemId, order.id]
    );
    if (!itemRows.length) throw new ApiError(404, "الصنف غير موجود في هذه الطلبية");
    const before = itemRows[0];
    assertQtyForUnit(qty, before.unit, before.product_name);

    const partConfirmed = !PART_UNCONFIRMED.includes(before.part_status) && before.part_status !== "cancelled";
    const lineTotal = round2(Number(before.unit_price) * qty);
    let updated;
    if (partConfirmed) {
      // المخزون اتخصم بقيمة qty_confirmed — نكتب الفرق فقط (رجوع لو نقصت الكمية، خصم إضافي لو زادت)
      const deducted = Number(before.qty_confirmed || 0);
      const delta = round3(qty - deducted);
      if (delta !== 0) {
        await lockStockForProducts(client, [before.product_id]);
        const r = stockReasons(order.order_number);
        await adjustStock(client, {
          productId: before.product_id, variantId: before.variant_id, delta: -delta,
          reason: delta > 0 ? r.sale : r.editBack, actorId: req.actor.id,
        });
      }
      ({ rows: [updated] } = await client.query(
        `UPDATE order_items SET qty_requested = $2, qty_confirmed = $2, availability = 'full', line_total = $3 WHERE id = $1 RETURNING *`,
        [before.id, qty, lineTotal]
      ));
      // الكمية المطلوبة صارت = المؤكدة: ما بقي نقص معلّق على هذا الصنف
      await client.query(
        `UPDATE order_shortages SET resolution = 'reduce_qty', customer_approved = TRUE, admin_approved = TRUE,
                resolved_by = $2, resolved_at = now()
          WHERE order_item_id = $1 AND resolved_at IS NULL`,
        [before.id, req.actor.id]
      );
    } else {
      // الجزء لسا ما أكّد: ما فيش خصم مخزون بعد؛ نتحقق بس من المتاح لو الكمية زادت
      const extra = round3(qty - Number(before.qty_requested));
      if (extra > 0) {
        await assertStockAvailable(client, [{
          productId: before.product_id, variantId: before.variant_id, qty: extra, label: before.product_name,
        }]);
      }
      ({ rows: [updated] } = await client.query(
        `UPDATE order_items SET qty_requested = $2, line_total = $3 WHERE id = $1 RETURNING *`,
        [before.id, qty, lineTotal]
      ));
    }

    await recalcOrderTotals(client, order.id);
    await settlePartShortageStatus(client, before.order_supplier_id);

    await recordStatus(client, {
      orderId: order.id, from: order.status, to: order.status, actor: req.actor,
      note: `تم تعديل كمية صنف: ${before.product_name} — من ${before.qty_requested} إلى ${qty}`,
    });
    if (before.part_status !== "pending") {
      const { rows: [pt] } = await client.query(`SELECT supplier_id FROM order_suppliers WHERE id = $1`, [before.order_supplier_id]);
      if (pt) {
        await notifySuppliers(client, {
          supplierIds: [pt.supplier_id], order, templateCode: "order.part_items_changed",
          change: `تعديل كمية ${before.product_name} من ${Number(before.qty_requested)} إلى ${qty}`,
        });
      }
    }
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
orderRouter.delete("/:id/items/:itemId", requirePermission("orders.review"), requireOrderScope, asyncRoute(async (req, res) => {
  const result = await withTransaction(async (client) => {
    const { rows: orderRows } = await client.query(`SELECT * FROM orders WHERE id = $1 FOR UPDATE`, [req.params.id]);
    if (!orderRows.length) throw new ApiError(404, "الطلبية غير موجودة");
    const order = orderRows[0];
    if (["delivered", "cancelled", "closed"].includes(order.status)) {
      throw new ApiError(400, "لا يمكن تعديل فاتورة طلبية تم تسليمها أو إلغاؤها");
    }

    const { rows: itemRows } = await client.query(
      `SELECT oi.*, os.status AS part_status FROM order_items oi
         JOIN order_suppliers os ON os.id = oi.order_supplier_id
        WHERE oi.id = $1 AND oi.order_id = $2 FOR UPDATE OF oi`,
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

    // لو الجزء مؤكّد فالكمية المؤكدة اتخصمت من المخزون — نرجّعها مع حركة مخزون في نفس المعاملة
    const partConfirmed = !PART_UNCONFIRMED.includes(item.part_status) && item.part_status !== "cancelled";
    if (partConfirmed && Number(item.qty_confirmed || 0) > 0) {
      await lockStockForProducts(client, [item.product_id]);
      await adjustStock(client, {
        productId: item.product_id, variantId: item.variant_id, delta: Number(item.qty_confirmed),
        reason: stockReasons(order.order_number).editBack, actorId: req.actor.id,
      });
    }

    const { rows: [delPart] } = await client.query(`SELECT supplier_id FROM order_suppliers WHERE id = $1`, [item.order_supplier_id]);

    // لازم نحذف أي سجل نقص مرتبط بهذا الصنف أول، وإلا الحذف يترفض بسبب قيد
    // المفتاح الأجنبي (يصير هذا كثير مع أصناف مرّت بمسار "نقص" قبل كذا)
    await client.query(`DELETE FROM order_shortages WHERE order_item_id = $1`, [item.id]);
    await client.query(`DELETE FROM order_items WHERE id = $1`, [item.id]);

    // recalcOrderTotals يشيل فاتورة المورد لو فضيت من كل أصنافها، ويعيد حساب رسوم التوصيل من الموردين الباقين
    await recalcOrderTotals(client, order.id);
    await settlePartShortageStatus(client, item.order_supplier_id);

    await recordStatus(client, {
      orderId: order.id, from: order.status, to: order.status, actor: req.actor,
      note: `تم حذف صنف: ${item.product_name} × ${item.qty_requested} ${item.unit}`,
    });
    if (item.part_status !== "pending" && delPart) {
      await notifySuppliers(client, {
        supplierIds: [delPart.supplier_id], order, templateCode: "order.part_items_changed",
        change: `حُذف الصنف ${item.product_name} (${Number(item.qty_requested)} ${item.unit ?? ""})`.trim(),
      });
    }
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
