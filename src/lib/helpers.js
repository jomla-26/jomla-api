import bcrypt from "bcrypt";
import crypto from "node:crypto";

export class ApiError extends Error {
  constructor(status, message, code = null) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const asyncRoute = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

export async function nextDocNumber(client, { table, column, prefix, start = 1000 }) {
  await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`${table}.${column}`]);
  const { rows } = await client.query(
    `SELECT COALESCE(MAX(NULLIF(regexp_replace(${column}, '\\D', '', 'g'), '')::BIGINT), $1) AS last
       FROM ${table}`,
    [start]
  );
  return `${prefix}-${Number(rows[0].last) + 1}`;
}

// رقم الطلبية من تسلسل قاعدة البيانات (بدون قفل يخلي الطلبات تنتظر بعضها). لو التسلسل غير موجود يرجع للطريقة القديمة.
// ملاحظة: قد تظهر قفزات في الأرقام لو فشلت طلبية بعد أخذ رقمها — هذا طبيعي.
export async function nextOrderNumber(client) {
  try {
    await client.query("SAVEPOINT order_seq");
    const { rows } = await client.query(`SELECT nextval('order_number_seq') AS n`);
    await client.query("RELEASE SAVEPOINT order_seq");
    return `JOMLA-${rows[0].n}`;
  } catch {
    await client.query("ROLLBACK TO SAVEPOINT order_seq");
    return nextDocNumber(client, { table: "orders", column: "order_number", prefix: "JOMLA", start: 3000 });
  }
}

// رمز تحقق من 4 خانات — مولّد عشوائي آمن (crypto) بدل Math.random
export function generateOtp() {
  return String(crypto.randomInt(0, 10000)).padStart(4, "0");
}

// تقريب المبالغ المالية لخانتين عشريتين — دالة واحدة تُستخدم في كل مكان
// (سعر السطر، مجموع الجزء، إجمالي الطلبية) عشان المجاميع تتطابق دائمًا
export function round2(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return 0;
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

// تقريب الكميات لثلاث خانات (نفس دقة أعمدة الكمية في قاعدة البيانات)
export function round3(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return 0;
  return Math.round((n + Number.EPSILON) * 1000) / 1000;
}

export const hashOtp = (otp) => bcrypt.hash(otp, 10);
export const verifyOtp = (otp, hash) => bcrypt.compare(otp, hash);

export function normalizePhone(phone) {
  const digits = String(phone || "").replace(/\D/g, "");
  if (digits.startsWith("218")) return "0" + digits.slice(3);
  return digits;
}

export async function resolvePrice(client, { productId, customerId, qty, variantId }) {
  // خيارات الصنف (ألوان/مقاسات/عبوات) لها سعرها الخاص المستقل تمامًا —
  // قواعد التسعير (عروض/أسعار عملاء) لسا على مستوى الصنف الأساسي بس، مو على كل خيار لحاله
  if (variantId) {
    const { rows } = await client.query(
      `SELECT price FROM product_variants WHERE id = $1 AND product_id = $2`,
      [variantId, productId]
    );
    if (!rows.length) throw new ApiError(404, "خيار الصنف غير موجود");
    return rows[0].price;
  }

  const { rows } = await client.query(
    `SELECT price, rule_type
       FROM product_price_rules
      WHERE product_id = $1
        AND is_active
        AND (customer_id = $2 OR customer_id IS NULL)
        AND min_qty <= $3
        AND (valid_from IS NULL OR valid_from <= CURRENT_DATE)
        AND (valid_to   IS NULL OR valid_to   >= CURRENT_DATE)
      ORDER BY (customer_id IS NOT NULL) DESC, min_qty DESC
      LIMIT 1`,
    [productId, customerId, qty]
  );
  if (rows.length) return rows[0].price;

  const base = await client.query(`SELECT base_price FROM products WHERE id = $1`, [productId]);
  if (!base.rows.length) throw new ApiError(404, "الصنف غير موجود");
  return base.rows[0].base_price;
}

// خزينة الحوالات (hawala) تستقبل/تُخصم منها أي عملية بطريقة "حوالة مصرفية"،
// سواء كانت قبض أو دفع — قبل هذا الإصلاح كل عمليات القبض كانت تذهب لخزينة
// المبيعات (sales) دائمًا بدون التحقق من الطريقة
export function resolveTreasuryCode(direction, method) {
  if (method === "transfer") return "hawala";
  return direction === "receipt" ? "sales" : "main";
}

// المسافة المستقيمة بين نقطتين (كم) — صيغة Haversine، بدون أي API خارجي
export function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export async function calcDeliveryFee(client, { zoneId, vehicleTypeId, vehiclesCount, supplierCount, customerId, supplierIds }) {
  // null = لسا ما لقينا سعر. الصفر سعر شرعي (توصيل مجاني لمنطقة معيّنة) ولا يجوز التعامل معه كأنه "ما فيش سعر"
  let fee = null;

  if (zoneId && vehicleTypeId) {
    const { rows } = await client.query(
      `SELECT fee FROM delivery_rates WHERE zone_id = $1 AND vehicle_type_id = $2`,
      [zoneId, vehicleTypeId]
    );
    if (rows.length && rows[0].fee != null) fee = Number(rows[0].fee);
  }
  if (fee === null && zoneId) {
    const { rows } = await client.query(`SELECT base_fee FROM delivery_zones WHERE id = $1`, [zoneId]);
    if (rows.length && rows[0].base_fee != null) fee = Number(rows[0].base_fee);
  }
  if (fee === null && vehicleTypeId) {
    const { rows: vt } = await client.query(`SELECT trip_cost FROM vehicle_types WHERE id = $1`, [vehicleTypeId]);
    if (vt.length && vt[0].trip_cost != null) fee = Number(vt[0].trip_cost) || 0;
  }
  if (fee === null) fee = 0;
  fee *= Math.max(1, vehiclesCount || 1);

  // رسم إضافي حسب المسافة الفعلية: مافيش مخزن للشركة — المندوب ياخذ البضاعة من
  // المورد (أو عدة موردين) ويوصّلها للزبون مباشرة. فنحسب مسافة كل مورد في
  // الطلبية للزبون (خط مستقيم) ونجمعها، عشان تقارب المشوار الحقيقي للمندوب.
  // سعر الكيلومتر يختلف حسب نوع السيارة (بورتر مو زي سيارة عادية)، فيتحدد لكل
  // نوع سيارة لحاله. يشتغل بس لو سعر الكيلومتر مفعّل لهذا النوع، وإلا يفضل كل
  // شي زي قبل.
  if (customerId && supplierIds?.length && vehicleTypeId) {
    const { rows: vtRows } = await client.query(
      `SELECT fee_per_km FROM vehicle_types WHERE id = $1`, [vehicleTypeId]
    );
    const feePerKm = Number(vtRows[0]?.fee_per_km || 0);
    if (feePerKm > 0) {
      const { rows: settingsRows } = await client.query(
        `SELECT free_km FROM delivery_settings WHERE id = 1`
      );
      const freeKm = Number(settingsRows[0]?.free_km || 0);
      const { rows: custRows } = await client.query(
        `SELECT latitude, longitude FROM customers WHERE id = $1`, [customerId]
      );
      const c = custRows[0];
      if (c?.latitude != null && c?.longitude != null) {
        const { rows: supplierRows } = await client.query(
          `SELECT latitude, longitude FROM suppliers WHERE id = ANY($1)`, [supplierIds]
        );
        let totalKm = 0;
        for (const sup of supplierRows) {
          if (sup.latitude == null || sup.longitude == null) continue;
          totalKm += haversineKm(
            Number(sup.latitude), Number(sup.longitude),
            Number(c.latitude), Number(c.longitude)
          );
        }
        const billableKm = Math.max(0, totalKm - freeKm);
        fee += billableKm * feePerKm * Math.max(1, vehiclesCount || 1);
      }
    }
  }

  if (supplierCount > 1) {
    const { rows } = await client.query(`SELECT extra_pickup_point_fee FROM delivery_settings WHERE id = 1`);
    const extra = rows.length ? Number(rows[0].extra_pickup_point_fee || 0) : 0;
    fee += extra * (supplierCount - 1);
  }

  return round2(fee);
}

// أسباب حركات المخزون المرتبطة بطلبية — نص ثابت يُبنى من رقم الطلبية، ويُستعمل للبيع والإرجاع معًا
export const stockReasons = (orderNumber) => ({
  sale: `بيع — طلب ${orderNumber}`,
  cancelBack: `إرجاع — إلغاء طلب ${orderNumber}`,
  editBack: `إرجاع — تعديل طلب ${orderNumber}`,
});

// تعديل مخزون صنف (أو نوع) داخل معاملة قائمة + تسجيل حركة المخزون.
// delta سالب = خصم (يرفض لو المخزون ما يكفي)، موجب = إضافة.
export async function adjustStock(client, { productId, variantId = null, delta, reason, actorId = null }) {
  const d = round3(delta);
  if (!d) return;
  if (d < 0) {
    const r = variantId
      ? await client.query(`UPDATE product_variants SET stock_qty = stock_qty + $2 WHERE id = $1 AND stock_qty + $2 >= 0`, [variantId, d])
      : await client.query(`UPDATE products SET stock_qty = stock_qty + $2 WHERE id = $1 AND stock_qty + $2 >= 0`, [productId, d]);
    if (!r.rowCount) throw new ApiError(409, "الكمية المؤكدة أكبر من المخزون المسجّل لأحد الأصناف — حدّث المخزون أولًا");
  } else if (variantId) {
    await client.query(`UPDATE product_variants SET stock_qty = stock_qty + $2 WHERE id = $1`, [variantId, d]);
  } else {
    await client.query(`UPDATE products SET stock_qty = stock_qty + $2 WHERE id = $1`, [productId, d]);
  }
  await client.query(
    `INSERT INTO stock_movements (product_id, variant_id, change_qty, reason, created_by) VALUES ($1,$2,$3,$4,$5)`,
    [productId, variantId || null, d, reason, actorId || null]
  );
}

// إرجاع مخزون طلبية ملغاة: يعتمد على سجل حركات المخزون الفعلي للطلبية نفسها
// (مجموع كل الخصومات − كل الإرجاعات السابقة لكل صنف/نوع) وليس على الأصناف الباقية في الطلبية،
// فيشمل الأصناف اللي انحذفت أو اتعدّلت بعد التأكيد — وآمن للتكرار (المرة الثانية صافيها صفر)
export async function restoreOrderStock(client, orderId, actorId) {
  const { rows: [o] } = await client.query(`SELECT order_number FROM orders WHERE id = $1`, [orderId]);
  if (!o) return;
  const r = stockReasons(o.order_number);
  const { rows } = await client.query(
    `SELECT product_id, variant_id, SUM(change_qty) AS net
       FROM stock_movements WHERE reason = ANY($1)
      GROUP BY product_id, variant_id HAVING SUM(change_qty) < 0`,
    [[r.sale, r.cancelBack, r.editBack]]
  );
  for (const row of rows) {
    await adjustStock(client, {
      productId: row.product_id, variantId: row.variant_id,
      delta: -Number(row.net), reason: r.cancelBack, actorId,
    });
  }
}
