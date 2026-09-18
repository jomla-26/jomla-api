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

export async function calcDeliveryFee(client, { zoneId, vehicleTypeId, vehiclesCount, supplierCount }) {
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

  fee *= Math.max(1, vehiclesCount || 1);

  if (supplierCount > 1) {
    const { rows } = await client.query(`SELECT extra_pickup_point_fee FROM delivery_settings WHERE id = 1`);
    const extra = rows.length ? rows[0].extra_pickup_point_fee : 0;
    fee += extra * (supplierCount - 1);
  }

  return Number(fee.toFixed(2));
}
