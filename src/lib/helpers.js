import bcrypt from "bcrypt";

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

export function generateOtp() {
  return String(Math.floor(1000 + Math.random() * 9000));
}

export const hashOtp = (otp) => bcrypt.hash(otp, 10);
export const verifyOtp = (otp, hash) => bcrypt.compare(otp, hash);

export function normalizePhone(phone) {
  const digits = String(phone || "").replace(/\D/g, "");
  if (digits.startsWith("218")) return "0" + digits.slice(3);
  return digits;
}

export async function resolvePrice(client, { productId, customerId, qty }) {
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
  let fee = 0;

  if (zoneId && vehicleTypeId) {
    const { rows } = await client.query(
      `SELECT fee FROM delivery_rates WHERE zone_id = $1 AND vehicle_type_id = $2`,
      [zoneId, vehicleTypeId]
    );
    if (rows.length) fee = rows[0].fee;
  }
  if (!fee && zoneId) {
    const { rows } = await client.query(`SELECT base_fee FROM delivery_zones WHERE id = $1`, [zoneId]);
    if (rows.length) fee = rows[0].base_fee;
  }

  if (!fee && vehicleTypeId) { const { rows: vt } = await client.query(`SELECT trip_cost FROM vehicle_types WHERE id = $1`, [vehicleTypeId]); if (vt.length) fee = Number(vt[0].trip_cost) || 0; } fee *= Math.max(1, vehiclesCount || 1);

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
    const extra = rows.length ? rows[0].extra_pickup_point_fee : 0;
    fee += extra * (supplierCount - 1);
  }

  return Number(fee.toFixed(2));
}
