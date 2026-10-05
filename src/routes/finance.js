import { Router } from "express";
import { z } from "zod";
import { query, withTransaction, writeAudit } from "../lib/db.js";
import { ApiError, asyncRoute, nextDocNumber, resolveTreasuryCode } from "../lib/helpers.js";
import { authenticate, requirePermission, requireActorType } from "../middleware/auth.js";
import { queueNotification, notifyStaffInApp } from "../lib/notify.js";
import { parseRange, addRange, addDateColRange, andClause, buildLedger } from "../lib/dateRange.js";

export const financeRouter = Router();
financeRouter.use(authenticate);

// ====================================================================
// أدوات مساعدة
// ====================================================================

// حسابات المال بالقروش (أعداد صحيحة) لتفادي أخطاء الفاصلة العائمة
const toCents = (n) => Math.round(Number(n || 0) * 100);
const fromCents = (c) => c / 100;
const fmt = (cents) => (cents / 100).toFixed(2);
export const round2 = (n) => Math.round((Number(n || 0) + Number.EPSILON) * 100) / 100;

// مبلغ موجب بحد أقصى منزلتين عشريتين
const amountSchema = z.number().positive().max(1_000_000_000)
  .refine((n) => Math.abs(n * 100 - Math.round(n * 100)) < 1e-6, "المبلغ يجب ألا يتجاوز منزلتين عشريتين");

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function assertUuid(id) {
  if (!UUID_RE.test(String(id))) throw new ApiError(400, "المعرّف غير صالح");
}

function pageParams(req) {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 200, 1), 1000);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
  return { limit, offset };
}

// هل الموظف عنده أي صلاحية من القائمة؟ (الاستثناء الفردي للموظف يغلب صلاحية الدور)
async function employeeHasAny(employeeId, codes) {
  const { rows } = await query(
    `SELECT 1
       FROM employees e
       JOIN permissions p ON p.code = ANY($2::TEXT[])
      WHERE e.id = $1 AND e.is_active
        AND COALESCE(
              (SELECT o.granted FROM employee_permission_overrides o
                WHERE o.employee_id = e.id AND o.permission_id = p.id),
              EXISTS (SELECT 1 FROM role_permissions rp
                       WHERE rp.role_id = e.role_id AND rp.permission_id = p.id)
            )
      LIMIT 1`,
    [employeeId, codes]
  );
  return rows.length > 0;
}

const FINANCE_READ_PERMS = ["reports.view", "finance.vouchers"];

// قاعدة الوصول للقراءة المالية: القائمة البيضاء حسب نوع الحساب، والرفض هو الافتراضي.
//  - صاحب الحساب نفسه (عميل/مورد/موظف) على بياناته فقط
//  - أو موظف فعّال عنده صلاحية تقارير/مالية
async function assertCanReadFinance(req, { ownerType, ownerId }) {
  const a = req.actor;
  if (a && a.type === ownerType && a.id === ownerId) return;
  if (a && a.type === "employee" && (await employeeHasAny(a.id, FINANCE_READ_PERMS))) return;
  throw new ApiError(403, "لا تملك صلاحية الاطلاع على هذا الكشف");
}

// ---------------- الخزائن ----------------
// رصيد الخزينة محسوب من الجداول الأساسية (مش من v_treasury_balances) بنفس منطقها:
// سندات معتمدة غير off_treasury (قبض +/دفع −) + تحويلات واردة − صادرة − مصروفات.
async function treasuryBalanceCents(client, treasuryId) {
  const { rows: [r] } = await client.query(
    `SELECT
        COALESCE((SELECT SUM(CASE WHEN v.voucher_type = 'receipt' THEN v.amount ELSE -v.amount END)
                    FROM vouchers v
                   WHERE v.treasury_id = $1 AND v.approval_status = 'approved' AND NOT v.off_treasury), 0)
      + COALESCE((SELECT SUM(x.amount) FROM treasury_transfers x WHERE x.to_treasury_id   = $1), 0)
      - COALESCE((SELECT SUM(x.amount) FROM treasury_transfers x WHERE x.from_treasury_id = $1), 0)
      - COALESCE((SELECT SUM(e.amount) FROM expenses e WHERE e.treasury_id = $1), 0)
        AS balance`,
    [treasuryId]
  );
  return toCents(r.balance);
}

// يقفل الخزينة (نفس مفتاح قفل /transfers: "treasury:<code>") ويتأكد أن رصيدها يكفي المبلغ.
// يرجّع صف الخزينة. لازم يُستدعى داخل معاملة.
async function lockTreasuryAndCheck(client, code, amount, what) {
  await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, ["treasury:" + code]);
  const { rows } = await client.query(`SELECT id, code, name FROM treasuries WHERE code = $1`, [code]);
  if (!rows.length) throw new ApiError(400, "الخزينة غير معروفة");
  if (amount != null) {
    const bal = await treasuryBalanceCents(client, rows[0].id);
    if (bal < toCents(amount)) {
      throw new ApiError(
        400,
        `رصيد ${rows[0].name} (${fmt(bal)} د.ل) لا يكفي لتنفيذ ${what} بمبلغ ${fmt(toCents(amount))} د.ل`
      );
    }
  }
  return rows[0];
}

// ---------------- عهدة/محفظة المندوب ----------------
// المعادلة (بدون الاعتماد على أي view):
//   الرصيد = العهدة المستلمة + نقدية COD عند المندوب (غير المسلَّمة) + تسويات سابقة − ما صرفه/رجّعه (paid_by_driver_id)
// "التسويات السابقة" = (إجمالي COD للطلبيات المسلَّمة في التسوية − المبلغ الفعلي المطلوب تسليمه وقتها)،
// أي نقدية COD كان المندوب صرفها من جيبه قبل التسوية وخُصمت من تسليمه. بدونها كان الخصم يُحسب مرتين.
// للتسويات القديمة (المبلغ = الإجمالي) قيمتها صفر، فالنتيجة نفس المعادلة السابقة بالضبط.
const WALLET_FIGURES_SQL = `
  SELECT
    COALESCE((SELECT SUM(amount) FROM vouchers
               WHERE party_type = 'driver' AND party_id = $1 AND voucher_type = 'payment'
                 AND method = 'cash' AND approval_status = 'approved'), 0) AS float_given,
    COALESCE((SELECT SUM(cod_amount) FROM orders
               WHERE driver_id = $1 AND cod_collected AND NOT cod_settled), 0) AS cod_pending,
    COALESCE((SELECT SUM(GREATEST(g.gross - ds.total_amount, 0))
                FROM driver_settlements ds
                JOIN (SELECT settlement_id, SUM(amount) AS gross
                        FROM driver_settlement_orders GROUP BY settlement_id) g ON g.settlement_id = ds.id
               WHERE ds.driver_id = $1), 0) AS settle_adjust,
    COALESCE((SELECT SUM(amount) FROM vouchers
               WHERE paid_by_driver_id = $1 AND approval_status = 'approved'), 0) AS paid_out`;

async function walletFigures(runner, driverId, codPendingOverride = null) {
  const { rows: [r] } = await runner.query(WALLET_FIGURES_SQL, [driverId]);
  const floatC = toCents(r.float_given);
  const codC = codPendingOverride != null ? toCents(codPendingOverride) : toCents(r.cod_pending);
  const adjC = toCents(r.settle_adjust);
  const paidC = toCents(r.paid_out);
  const balanceC = floatC + codC + adjC - paidC;
  return {
    floatC, codC, adjC, paidC, balanceC,
    // المطلوب من المندوب تسليمه للشركة الآن: COD المعلّقة مخصومًا منها ما صرفه من النقدية (لا يتجاوز رصيده)
    handoverC: Math.max(0, Math.min(codC, balanceC)),
    // أقصى مبلغ يجوز "استرجاعه كعهدة" (العهدة المتبقية فقط — مش نقدية COD)
    returnableFloatC: Math.max(0, Math.min(floatC - paidC, balanceC - codC)),
  };
}

const walletJson = (w) => ({
  floatGiven: fromCents(w.floatC),
  codInHand: fromCents(w.codC),
  settledAdjustment: fromCents(w.adjC),
  paidOut: fromCents(w.paidC),
  balance: fromCents(w.balanceC),
  cashInHand: fromCents(w.handoverC),
  returnableFloat: fromCents(w.returnableFloatC),
});

// قطع SQL مشتركة لكشوف كل المندوبين
const FLOAT_AGG = `SELECT party_id AS driver_id, SUM(amount) AS total FROM vouchers
                    WHERE party_type = 'driver' AND voucher_type = 'payment'
                      AND method = 'cash' AND approval_status = 'approved'
                    GROUP BY party_id`;
const PAID_AGG = `SELECT paid_by_driver_id AS driver_id, SUM(amount) AS total FROM vouchers
                   WHERE paid_by_driver_id IS NOT NULL AND approval_status = 'approved'
                   GROUP BY paid_by_driver_id`;
const ADJUST_AGG = `SELECT ds.driver_id, SUM(GREATEST(g.gross - ds.total_amount, 0)) AS total
                      FROM driver_settlements ds
                      JOIN (SELECT settlement_id, SUM(amount) AS gross
                              FROM driver_settlement_orders GROUP BY settlement_id) g ON g.settlement_id = ds.id
                     GROUP BY ds.driver_id`;
const COD_PENDING_AGG = `SELECT driver_id, SUM(cod_amount) AS total FROM orders
                          WHERE cod_collected AND NOT cod_settled GROUP BY driver_id`;

// يقفل صف الموظف (المندوب) لتسلسل أي عمليات متزامنة على عهدته. الترتيب الثابت للأقفال:
// صف الموظف ← قفل الخزينة. (التحويلات تأخذ قفل الخزينة فقط، فلا يحدث تشابك.)
async function lockEmployee(client, id, { activeOnly = false } = {}) {
  const { rows } = await client.query(
    `SELECT id, name, is_active FROM employees WHERE id = $1 ${activeOnly ? "AND is_active" : ""} FOR UPDATE`,
    [id]
  );
  return rows[0] || null;
}

// ====================================================================
// السندات
// ====================================================================

const voucherSchema = z.object({
  voucherType: z.enum(["receipt", "payment"]),
  partyType: z.enum(["customer", "supplier", "driver", "employee", "other"]),
  partyId: z.string().uuid().optional(),
  partyName: z.string().min(2),
  amount: amountSchema,
  method: z.enum(["cash", "transfer", "card"]),
  orderId: z.string().uuid().optional(),
  transferReference: z.string().optional(),
  transferImageUrl: z.string().url().optional(),
  note: z.string().optional(),
  // مفتاح عدم التكرار: نفس المفتاح من نفس الموظف يرجّع نفس السند بدل ما يُنشئ سند ثاني (ضغط مزدوج/إعادة إرسال)
  clientKey: z.string().min(8).max(100).optional(),
});

// المتبقي على طلبية بالقروش (بعد خصم المدفوع وسندات القبض المعلّقة الأخرى)
async function orderRemainingCents(client, order, { excludeVoucherId = null } = {}) {
  const { rows: [p] } = await client.query(
    `SELECT COALESCE(SUM(amount), 0) AS total FROM vouchers
      WHERE order_id = $1 AND voucher_type = 'receipt' AND approval_status = 'pending'
        AND ($2::UUID IS NULL OR id <> $2)`,
    [order.id, excludeVoucherId]
  );
  return toCents(order.grand_total) - toCents(order.paid_amount) - toCents(p.total);
}

const applyReceiptToOrder = (client, orderId, amount) => client.query(
  `UPDATE orders SET
     paid_amount = paid_amount + $2,
     payment_status = CASE WHEN paid_amount + $2 >= grand_total
                           THEN 'paid' ELSE 'partially_paid' END
   WHERE id = $1`,
  [orderId, amount]
);

financeRouter.post("/vouchers", requirePermission("finance.vouchers"), asyncRoute(async (req, res) => {
  const body = voucherSchema.parse(req.body);
  const treasuryCode = resolveTreasuryCode(body.voucherType, body.method);
  const clientKey = body.clientKey ? `${req.actor.id}:${body.clientKey}` : null;

  if (body.orderId && !body.partyId) throw new ApiError(400, "حدّد الطرف (عميل/مورد) عند ربط الإيصال بطلبية");

  let out;
  try {
    out = await withTransaction(async (client) => {
      // عدم التكرار: نقفل المفتاح ثم نبحث، فطلبين متزامنين بنفس المفتاح يتسلسلان
      if (clientKey) {
        await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, ["vkey:" + clientKey]);
        const { rows: existing } = await client.query(`SELECT * FROM vouchers WHERE client_key = $1`, [clientKey]);
        if (existing.length) return { voucher: existing[0], replay: true };
      }

      const approvalStatus = body.method === "transfer" ? "pending" : "approved";

      // سند الدفع المعتمد فورًا يسحب من الخزينة: نقفلها ونتأكد أن رصيدها يكفي.
      // (سند الدفع بالحوالة يبقى معلّقًا ويُفحص رصيد خزينة الحوالات وقت اعتماده.)
      let treasury;
      if (body.voucherType === "payment" && approvalStatus === "approved") {
        treasury = await lockTreasuryAndCheck(client, treasuryCode, body.amount, "سند الدفع");
      } else {
        const { rows: tr } = await client.query(`SELECT id, code, name FROM treasuries WHERE code = $1`, [treasuryCode]);
        if (!tr.length) throw new ApiError(400, "الخزينة غير معروفة");
        treasury = tr[0];
      }

      // ربط السند بطلبية: لازم تخص نفس الطرف، وسند القبض ما يتجاوز المتبقي
      if (body.orderId) {
        if (body.partyType !== "customer" && body.partyType !== "supplier") {
          throw new ApiError(400, "لا يمكن ربط إيصال لهذا النوع من الأطراف بطلبية");
        }
        const { rows: ord } = await client.query(
          `SELECT id, customer_id, status, grand_total, paid_amount FROM orders WHERE id = $1
             ${body.voucherType === "receipt" ? "FOR UPDATE" : ""}`,
          [body.orderId]
        );
        if (!ord.length) throw new ApiError(404, "الطلبية غير موجودة");
        const order = ord[0];

        if (body.partyType === "customer") {
          if (order.customer_id !== body.partyId) throw new ApiError(400, "هذه الطلبية لا تخص العميل المحدّد");
        } else {
          const { rows: own } = await client.query(
            `SELECT 1 FROM order_suppliers WHERE order_id = $1 AND supplier_id = $2`,
            [body.orderId, body.partyId]
          );
          if (!own.length) throw new ApiError(400, "هذه الطلبية لا تخص المورد المحدّد");
        }

        if (body.voucherType === "receipt") {
          if (order.status === "cancelled") throw new ApiError(400, "لا يمكن إصدار إيصال قبض على طلبية ملغاة");
          const remaining = await orderRemainingCents(client, order);
          if (toCents(body.amount) > remaining) {
            throw new ApiError(
              400,
              `المبلغ ${fmt(toCents(body.amount))} د.ل يتجاوز المتبقي على الطلبية (${fmt(Math.max(remaining, 0))} د.ل). ` +
              `للمبالغ الزائدة أصدر إيصالًا غير مرتبط بطلبية`
            );
          }
        }

        // نفس رقم الحوالة ما ينسجّل مرتين على نفس الطلبية (غير المرفوضة)
        if (body.method === "transfer" && body.transferReference) {
          const { rows: dup } = await client.query(
            `SELECT voucher_number FROM vouchers
              WHERE order_id = $1 AND method = 'transfer' AND approval_status <> 'rejected'
                AND lower(btrim(transfer_reference)) = lower(btrim($2))
              LIMIT 1`,
            [body.orderId, body.transferReference]
          );
          if (dup.length) throw new ApiError(409, `رقم الحوالة مسجّل مسبقًا على نفس الطلبية (إيصال ${dup[0].voucher_number})`);
        }
      }

      const number = await nextDocNumber(client, {
        table: "vouchers", column: "voucher_number", prefix: "V", start: 1000,
      });

      const { rows } = await client.query(
        `INSERT INTO vouchers
           (voucher_number, voucher_type, party_type, party_id, party_name,
            amount, method, treasury_id, order_id, transfer_reference,
            transfer_image_url, approval_status, approved_by, approved_at, note, created_by, client_key)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,
                 CASE WHEN $12 = 'approved' THEN $14::UUID END,
                 CASE WHEN $12 = 'approved' THEN now() END,
                 $13,$14,$15)
         RETURNING *`,
        [number, body.voucherType, body.partyType, body.partyId ?? null, body.partyName,
         body.amount, body.method, treasury.id, body.orderId ?? null,
         body.transferReference ?? null, body.transferImageUrl ?? null,
         approvalStatus, body.note ?? null, req.actor.id, clientKey]
      );
      const voucher = rows[0];

      if (body.orderId && body.voucherType === "receipt" && approvalStatus === "approved") {
        await applyReceiptToOrder(client, body.orderId, body.amount);
      }

      if (approvalStatus === "approved" && body.partyId && (body.partyType === "customer" || body.partyType === "supplier")) {
        await queueNotification(client, {
          templateCode: "voucher.recorded", recipientType: body.partyType,
          recipientId: body.partyId, orderId: body.orderId ?? null,
          vars: {
            voucher_number: number, amount: Number(body.amount).toFixed(2),
            voucher_type_label: body.voucherType === "receipt" ? "قبض" : "دفع",
          },
        });
      }

      await writeAudit(client, {
        actorType: "employee", actorId: req.actor.id, actorName: req.actor.name,
        action: "voucher.issued", entityType: "voucher", entityId: voucher.id,
        entityLabel: number, after: voucher, ip: req.ip,
      });
      return { voucher, replay: false };
    });
  } catch (err) {
    // سباق نادر: فهرس عدم التكرار رفض الإدخال
    if (err?.code === "23505" && String(err.constraint || "").includes("client_key") && clientKey) {
      const { rows } = await query(`SELECT * FROM vouchers WHERE client_key = $1`, [clientKey]);
      if (rows.length) return res.status(200).json(rows[0]);
    }
    if (err?.code === "23505" && String(err.constraint || "").includes("transfer_ref")) {
      throw new ApiError(409, "رقم الحوالة مسجّل مسبقًا على نفس الطلبية");
    }
    throw err;
  }

  res.status(out.replay ? 200 : 201).json(out.voucher);
}));

financeRouter.post("/vouchers/:id/decide", requirePermission("finance.vouchers"), asyncRoute(async (req, res) => {
  assertUuid(req.params.id);
  const { approve, reason } = z.object({
    approve: z.boolean(), reason: z.string().optional(),
  }).parse(req.body);

  const result = await withTransaction(async (client) => {
    const { rows } = await client.query(`SELECT * FROM vouchers WHERE id = $1 FOR UPDATE`, [req.params.id]);
    if (!rows.length) throw new ApiError(404, "الإيصال غير موجود");
    const v = rows[0];
    if (v.approval_status !== "pending") throw new ApiError(400, "تمت معالجة هذا الإيصال مسبقًا");

    // مُنشئ سند الحوالة ما يعتمدها بنفسه (يقدر يرفضها/يلغيها)
    if (approve && v.method === "transfer" && v.created_by && v.created_by === req.actor.id) {
      throw new ApiError(403, "لا يمكنك اعتماد حوالة أنشأتها بنفسك — يعتمدها موظف آخر");
    }

    if (approve && v.voucher_type === "payment" && !v.off_treasury) {
      const { rows: tr } = await client.query(`SELECT code FROM treasuries WHERE id = $1`, [v.treasury_id]);
      await lockTreasuryAndCheck(client, tr[0].code, v.amount, "سند الدفع");
    }

    if (approve && v.order_id && v.voucher_type === "receipt") {
      const { rows: ord } = await client.query(
        `SELECT id, status, grand_total, paid_amount FROM orders WHERE id = $1 FOR UPDATE`, [v.order_id]
      );
      if (ord.length) {
        const remaining = await orderRemainingCents(client, ord[0], { excludeVoucherId: v.id });
        if (toCents(v.amount) > remaining) {
          throw new ApiError(
            400,
            `لا يمكن اعتماد الإيصال: المبلغ ${fmt(toCents(v.amount))} د.ل يتجاوز المتبقي على الطلبية (${fmt(Math.max(remaining, 0))} د.ل). ارفضه أو عدّله`
          );
        }
      }
    }

    const { rows: [updated] } = await client.query(
      `UPDATE vouchers SET approval_status = $2, approved_by = $3, approved_at = now(),
              note = COALESCE($4, note)
       WHERE id = $1 RETURNING *`,
      [v.id, approve ? "approved" : "rejected", req.actor.id, reason ?? null]
    );

    if (approve && v.order_id && v.voucher_type === "receipt") {
      await applyReceiptToOrder(client, v.order_id, v.amount);
    }

    await writeAudit(client, {
      actorType: "employee", actorId: req.actor.id, actorName: req.actor.name,
      action: approve ? "voucher.approved" : "voucher.rejected",
      entityType: "voucher", entityId: v.id, entityLabel: v.voucher_number,
      before: v, after: updated, ip: req.ip,
    });

    if (approve && v.party_id && (v.party_type === "customer" || v.party_type === "supplier")) {
      await queueNotification(client, {
        templateCode: "voucher.recorded", recipientType: v.party_type,
        recipientId: v.party_id, orderId: v.order_id,
        vars: {
          voucher_number: v.voucher_number, amount: Number(v.amount).toFixed(2),
          voucher_type_label: v.voucher_type === "receipt" ? "قبض" : "دفع",
        },
      });
    } else if (!approve && v.party_type === "customer" && v.party_id) {
      await queueNotification(client, {
        templateCode: "transfer.decision", recipientType: "customer",
        recipientId: v.party_id, orderId: v.order_id,
        vars: { decision: "رفض", order_number: v.voucher_number },
      });
    }
    return updated;
  });

  res.json(result);
}));

// قائمة السندات (ترقيم: limit/offset — الافتراضي 200، الأقصى 1000)
financeRouter.get("/vouchers", requirePermission("finance.vouchers"), asyncRoute(async (req, res) => {
  const { treasuryCode, method, search } = req.query;
  const { limit, offset } = pageParams(req);
  const range = parseRange(req.query);
  const params = [treasuryCode || null, method || null, search || null, limit, offset];
  const conds = [];
  addRange("v.created_at", range, params, conds);
  const { rows } = await query(
    `SELECT v.*, t.code AS treasury_code, t.name AS treasury_name
       FROM vouchers v JOIN treasuries t ON t.id = v.treasury_id
      WHERE ($1::TEXT IS NULL OR t.code = $1)
        AND ($2::TEXT IS NULL OR v.method = $2)
        AND ($3::TEXT IS NULL OR v.party_name ILIKE '%'||$3||'%'
             OR v.voucher_number ILIKE '%'||$3||'%')${andClause(conds)}
      ORDER BY v.created_at DESC, v.id
      LIMIT $4 OFFSET $5`,
    params
  );
  res.json(rows);
}));

// ====================================================================
// التحويل بين الخزائن
// ====================================================================
// التحويل مسموح بين كل الخزائن في الاتجاهين (المبيعات / الرئيسية / الحوالات-البنك): سحب من البنك لخزينة
// نقدية أو إيداع نقدية في البنك. الرصيد يُحسب في v_treasury_balances كتحويلات واردة − صادرة لكل خزينة،
// فرصيد الحوالات يتأثر تلقائيًا بالتحويل (داخل/خارج).
const TRANSFER_CODES = ["sales", "main", "hawala"];
financeRouter.post("/transfers", requirePermission("finance.transfers"), asyncRoute(async (req, res) => {
  const body = z.object({
    fromCode: z.enum(TRANSFER_CODES),
    toCode: z.enum(TRANSFER_CODES),
    amount: amountSchema,
    note: z.string().optional(),
  }).parse(req.body);

  if (body.fromCode === body.toCode) throw new ApiError(400, "لا يمكن التحويل لنفس الخزينة");

  const transfer = await withTransaction(async (client) => {
    // قفل الخزينتين بترتيب ثابت (أبجديًا بالكود) لمنع الـ deadlock بين تحويلين متعاكسين متزامنين،
    // بنفس مفتاح القفل المستعمل في كل مسارات الصرف ("treasury:<code>")
    for (const code of [body.fromCode, body.toCode].sort()) {
      await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, ["treasury:" + code]);
    }
    // فحص رصيد الخزينة المحوَّل منها (القفل أخذناه فوق، والاستدعاء هنا إعادة دخول بنفس المعاملة)
    const from = await lockTreasuryAndCheck(client, body.fromCode, body.amount, "التحويل");
    const { rows: toRows } = await client.query(`SELECT id, name FROM treasuries WHERE code = $1`, [body.toCode]);
    if (!toRows.length) throw new ApiError(400, "الخزينة غير معروفة");

    const number = await nextDocNumber(client, {
      table: "treasury_transfers", column: "transfer_number", prefix: "T", start: 1000,
    });
    const { rows } = await client.query(
      `INSERT INTO treasury_transfers
         (transfer_number, from_treasury_id, to_treasury_id, amount, note, created_by)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [number, from.id, toRows[0].id, body.amount, body.note ?? null, req.actor.id]
    );

    await writeAudit(client, {
      actorType: "employee", actorId: req.actor.id, actorName: req.actor.name,
      action: "treasury.transfer", entityType: "treasury_transfer", entityId: rows[0].id,
      entityLabel: number,
      after: { ...rows[0], from_code: body.fromCode, from_name: from.name, to_code: body.toCode, to_name: toRows[0].name },
      ip: req.ip,
    });
    return rows[0];
  });

  res.status(201).json(transfer);
}));

// العرض يبقى من v_treasury_balances (المصدر الذي تعتمده الواجهة). فحوص الرصيد في الصرف تحسب من الجداول
// الأساسية بنفس المنطق — لازم تتأكد إن الاثنين يعطوا نفس الرقم في القاعدة الحقيقية.
financeRouter.get("/treasuries", requirePermission("finance.vouchers"), asyncRoute(async (_req, res) => {
  const { rows } = await query(`SELECT * FROM v_treasury_balances ORDER BY code`);
  res.json(rows);
}));

// ====================================================================
// المندوبون: تسوية النقدية، العهدة، المحفظة
// ====================================================================

financeRouter.post("/drivers/:id/settle", requirePermission("finance.vouchers"), asyncRoute(async (req, res) => {
  assertUuid(req.params.id);
  // declaredAmount = المبلغ اللي عدّته الإدارة فعليًا من يد المندوب (ممكن 0 لو ما سلّم شي).
  // لو ما انبعتش نفترض إنه طابق المحسوب. أي فرق ينحفظ كراية وينبّه الإدارة (داخل التطبيق فقط).
  const body = z.object({
    declaredAmount: z.number().min(0).max(1_000_000_000)
      .refine((n) => Math.abs(n * 100 - Math.round(n * 100)) < 1e-6, "المبلغ يجب ألا يتجاوز منزلتين عشريتين")
      .optional(),
  }).parse(req.body ?? {});

  const result = await withTransaction(async (client) => {
    // قفل صف المندوب أولًا: يمنع تسويتين أو تسوية + استرجاع/دفع متزامنين
    const drv = await lockEmployee(client, req.params.id);
    if (!drv) throw new ApiError(404, "المندوب غير موجود");

    const { rows: pending } = await client.query(
      `SELECT id, order_number, cod_amount FROM orders
        WHERE driver_id = $1 AND cod_collected AND NOT cod_settled FOR UPDATE`,
      [req.params.id]
    );
    if (!pending.length) throw new ApiError(400, "لا توجد مبالغ معلّقة لهذا المندوب");

    const grossC = pending.reduce((s, o) => s + toCents(o.cod_amount), 0);
    // المطلوب فعليًا من المندوب = إجمالي COD مخصومًا منه ما صرفه من نقديته لموردين/استرجاع عهدة
    // (paid_by_driver_id) — بدون هذا الخصم كانت الشركة تحسبه عليه مرتين.
    const w = await walletFigures(client, req.params.id, fromCents(grossC));
    const expectedC = w.handoverC;
    const declaredC = body.declaredAmount != null ? toCents(body.declaredAmount) : expectedC;
    const discrepancyC = declaredC - expectedC;

    let voucher = null;
    if (declaredC > 0) {
      const vNumber = await nextDocNumber(client, {
        table: "vouchers", column: "voucher_number", prefix: "V", start: 1000,
      });
      const { rows: tr } = await client.query(`SELECT id FROM treasuries WHERE code = 'sales'`);
      if (!tr.length) throw new ApiError(400, "الخزينة غير معروفة");

      const noteParts = [`تسليم نقدية من مندوب التوصيل`];
      if (expectedC < grossC) {
        noteParts.push(`إجمالي المحصّل ${fmt(grossC)} د.ل منه ${fmt(grossC - expectedC)} د.ل صرفها المندوب من نقديته`);
      }
      if (discrepancyC !== 0) {
        noteParts.push(`فرق ${discrepancyC > 0 ? "زيادة" : "نقص"} قدره ${fmt(Math.abs(discrepancyC))} د.ل عن المحسوب (${fmt(expectedC)} د.ل)`);
      }
      const { rows: [v] } = await client.query(
        `INSERT INTO vouchers
           (voucher_number, voucher_type, party_type, party_id, party_name,
            amount, method, treasury_id, approval_status, approved_by, approved_at, note, created_by)
         VALUES ($1,'receipt','driver',$2,$3,$4,'cash',$5,'approved',$6,now(),$7,$6)
         RETURNING *`,
        [vNumber, req.params.id, drv.name ?? "مندوب", fromCents(declaredC), tr[0].id, req.actor.id,
         noteParts.join(" — ")]
      );
      voucher = v;
    }

    const { rows: [settlement] } = await client.query(
      `INSERT INTO driver_settlements (driver_id, total_amount, declared_amount, discrepancy, voucher_id, settled_by)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [req.params.id, fromCents(expectedC), fromCents(declaredC), fromCents(discrepancyC), voucher?.id ?? null, req.actor.id]
    );

    for (const o of pending) {
      await client.query(
        `INSERT INTO driver_settlement_orders (settlement_id, order_id, amount) VALUES ($1,$2,$3)`,
        [settlement.id, o.id, o.cod_amount]
      );
    }
    await client.query(
      `UPDATE orders SET cod_settled = TRUE
        WHERE id = ANY($1::uuid[])`,
      [pending.map((o) => o.id)]
    );

    await writeAudit(client, {
      actorType: "employee", actorId: req.actor.id, actorName: req.actor.name,
      action: "driver.settled", entityType: "driver_settlement", entityId: settlement.id,
      entityLabel: drv.name, after: settlement, ip: req.ip,
    });

    // الفرق (نقص أو زيادة) ينبّه الإدارة داخل التطبيق فقط — بدون واتساب (قرار المؤسس)
    if (discrepancyC !== 0) {
      await notifyStaffInApp(client, {
        permissionCode: "reports.view",
        title: "فرق في تسوية مندوب",
        body: `تسوية المندوب ${drv.name}: المحسوب ${fmt(expectedC)} د.ل، المُسلَّم ${fmt(declaredC)} د.ل — ` +
              `${discrepancyC > 0 ? "زيادة" : "نقص"} ${fmt(Math.abs(discrepancyC))} د.ل`,
      });
    }

    return {
      settlement, voucher, ordersCount: pending.length,
      total: fromCents(expectedC),            // المطلوب فعليًا من المندوب (بعد خصم ما صرفه)
      grossCod: fromCents(grossC),            // إجمالي COD المعلّق
      declaredAmount: fromCents(declaredC),
      discrepancy: fromCents(discrepancyC),
    };
  });

  res.json(result);
}));

// تحصيلات كل المندوبين + أرصدة عهدهم (للإدارة). محسوبة من الجداول الأساسية (بدون v_driver_cash)
// وبنفس أسماء الأعمدة القديمة. handover_expected = المطلوب فعليًا من المندوب تسليمه الآن.
financeRouter.get("/drivers/cash", requirePermission("reports.view"), asyncRoute(async (_req, res) => {
  const { rows } = await query(
    `SELECT x.*,
            (x.float_given + x.cash_in_hand + x.settle_adjust - x.paid_out) AS wallet_balance,
            GREATEST(LEAST(x.cash_in_hand, x.float_given + x.cash_in_hand + x.settle_adjust - x.paid_out), 0)
              AS handover_expected
       FROM (
         SELECT e.id AS driver_id, e.name,
                COUNT(o.id)::int AS orders_assigned,
                (COUNT(o.id) FILTER (WHERE o.status IN ('delivered','closed')))::int AS orders_delivered,
                COALESCE(SUM(o.cod_amount) FILTER (WHERE o.cod_collected), 0)::numeric(14,2) AS cash_collected,
                COALESCE(SUM(o.cod_amount) FILTER (WHERE o.cod_collected AND o.cod_settled), 0)::numeric(14,2) AS cash_settled,
                COALESCE(SUM(o.cod_amount) FILTER (WHERE o.cod_collected AND NOT o.cod_settled), 0)::numeric(14,2) AS cash_in_hand,
                COALESCE(MAX(f.total), 0) AS float_given,
                COALESCE(MAX(p.total), 0) AS paid_out,
                COALESCE(MAX(a.total), 0) AS settle_adjust
           FROM employees e
           JOIN orders o ON o.driver_id = e.id
           LEFT JOIN (${FLOAT_AGG}) f ON f.driver_id = e.id
           LEFT JOIN (${PAID_AGG})  p ON p.driver_id = e.id
           LEFT JOIN (${ADJUST_AGG}) a ON a.driver_id = e.id
          GROUP BY e.id, e.name
       ) x
      ORDER BY wallet_balance DESC`
  );
  res.json(rows);
}));

// رصيد العهدة لكل الموظفين (مش المندوبين بس) — نفس جدول "vouchers" اللي يسجّل العهد يشتغل
// لأي موظف نشط (POST /drivers/:id/float ما فيهوش شرط role === 'driver')، عشان يتعرض جنب كل موظف
// في صفحة "الموظفون والرواتب".
financeRouter.get("/employees/wallets", requirePermission("reports.view"), asyncRoute(async (_req, res) => {
  const { rows } = await query(
    `SELECT e.id AS employee_id,
            COALESCE(f.total, 0)                                        AS float_given,
            COALESCE(c.total, 0)                                        AS cod_in_hand,
            COALESCE(p.total, 0)                                        AS paid_out,
            COALESCE(a.total, 0)                                        AS settle_adjust,
            COALESCE(f.total, 0) + COALESCE(c.total, 0) + COALESCE(a.total, 0) - COALESCE(p.total, 0) AS balance
       FROM employees e
       LEFT JOIN (${FLOAT_AGG}) f ON f.driver_id = e.id
       LEFT JOIN (${COD_PENDING_AGG}) c ON c.driver_id = e.id
       LEFT JOIN (${PAID_AGG}) p ON p.driver_id = e.id
       LEFT JOIN (${ADJUST_AGG}) a ON a.driver_id = e.id
      WHERE e.is_active`
  );
  res.json(rows);
}));

// نقدية المندوب نفسه (لتطبيق المندوب): بياناته هو فقط — يخرج من هوية التوكن، لا من الرابط.
// لازم يكون قبل أي مسار فيه :id.
financeRouter.get("/drivers/me/cash", requireActorType("employee"), asyncRoute(async (req, res) => {
  if (req.actor.role !== "driver") throw new ApiError(403, "هذه البيانات مخصصة لمندوبي التوصيل");
  const { rows: e } = await query(`SELECT is_active FROM employees WHERE id = $1`, [req.actor.id]);
  if (!e.length || !e[0].is_active) throw new ApiError(403, "حسابك غير فعّال");
  const w = await walletFigures({ query }, req.actor.id);
  const { rows: [c] } = await query(
    `SELECT COUNT(*)::int AS n FROM orders WHERE driver_id = $1 AND cod_collected AND NOT cod_settled`,
    [req.actor.id]
  );
  res.json({ ...walletJson(w), pendingOrdersCount: c.n });
}));

// ====== عهدة/محفظة المندوب ======
// الإدارة تسلّم المندوب مبلغ نقدي (عهدة) يستخدمه لاحقًا في الدفع للموردين نيابة عن الشركة.
// العهدة تُصرف من الخزينة الرئيسية ("main") وتُرجَّع لنفس الخزينة (انظر return-float).
financeRouter.post("/drivers/:id/float", requirePermission("finance.vouchers"), asyncRoute(async (req, res) => {
  assertUuid(req.params.id);
  const body = z.object({
    amount: amountSchema,
    note: z.string().optional(),
  }).parse(req.body);

  const result = await withTransaction(async (client) => {
    const drv = await lockEmployee(client, req.params.id, { activeOnly: true });
    if (!drv) throw new ApiError(404, "المندوب غير موجود أو غير فعّال");

    const treasury = await lockTreasuryAndCheck(
      client, resolveTreasuryCode("payment", "cash"), body.amount, "تسليم العهدة"
    );

    const vNumber = await nextDocNumber(client, {
      table: "vouchers", column: "voucher_number", prefix: "V", start: 1000,
    });

    const { rows: [voucher] } = await client.query(
      `INSERT INTO vouchers
         (voucher_number, voucher_type, party_type, party_id, party_name,
          amount, method, treasury_id, approval_status, approved_by, approved_at, note, created_by)
       VALUES ($1,'payment','driver',$2,$3,$4,'cash',$5,'approved',$6,now(),$7,$6)
       RETURNING *`,
      [vNumber, req.params.id, drv.name, body.amount, treasury.id,
       req.actor.id, body.note || `عهدة نقدية للمندوب`]
    );

    await writeAudit(client, {
      actorType: "employee", actorId: req.actor.id, actorName: req.actor.name,
      action: "driver.float_issued", entityType: "voucher", entityId: voucher.id,
      entityLabel: voucher.voucher_number, after: voucher, ip: req.ip,
    });

    return voucher;
  });

  res.status(201).json(result);
}));

// رصيد عهدة/محفظة المندوب: (العهدة اللي سلّمته الإدارة) + (كاش حصّله من العملاء ولسا ما سلّمهش)
// ناقص (اللي صرفه هو نفسه لموردين من عهدته أو رجّعه كعهدة)
financeRouter.get("/drivers/:id/wallet", asyncRoute(async (req, res) => {
  assertUuid(req.params.id);
  await assertCanReadFinance(req, { ownerType: "employee", ownerId: req.params.id });
  const w = await walletFigures({ query }, req.params.id);
  res.json(walletJson(w));
}));

// حركات محفظة المندوب بالتفصيل (زي كشف حساب)
financeRouter.get("/drivers/:id/wallet/transactions", asyncRoute(async (req, res) => {
  assertUuid(req.params.id);
  await assertCanReadFinance(req, { ownerType: "employee", ownerId: req.params.id });
  const range = parseRange(req.query);
  const { rows } = await query(
    `SELECT * FROM (
       SELECT v.created_at AS entry_date, 'عهدة نقدية مستلمة من الإدارة' AS label,
              v.voucher_number, v.amount AS in_amount, 0 AS out_amount
         FROM vouchers v
        WHERE v.party_type = 'driver' AND v.party_id = $1 AND v.voucher_type = 'payment'
          AND v.method = 'cash' AND v.approval_status = 'approved'
       UNION ALL
       SELECT o.delivered_at AS entry_date, 'تحصيل نقدي عند التسليم - ' || o.order_number AS label,
              NULL::text AS voucher_number, o.cod_amount AS in_amount, 0 AS out_amount
         FROM orders o
        WHERE o.driver_id = $1 AND o.cod_collected = TRUE
       UNION ALL
       SELECT v.created_at AS entry_date, 'دفع لمورد: ' || v.party_name AS label,
              v.voucher_number, 0 AS in_amount, v.amount AS out_amount
         FROM vouchers v
        WHERE v.paid_by_driver_id = $1 AND v.approval_status = 'approved'
          AND v.voucher_type = 'payment'
       UNION ALL
       SELECT v.created_at AS entry_date, 'استرجاع عهدة للإدارة' AS label,
              v.voucher_number, 0 AS in_amount, v.amount AS out_amount
         FROM vouchers v
        WHERE v.paid_by_driver_id = $1 AND v.approval_status = 'approved'
          AND v.voucher_type = 'receipt'
       UNION ALL
       SELECT ds.settled_at AS entry_date, 'تسليم نقدية للإدارة' AS label,
              v2.voucher_number, 0 AS in_amount, ds.total_amount AS out_amount
         FROM driver_settlements ds LEFT JOIN vouchers v2 ON v2.id = ds.voucher_id
        WHERE ds.driver_id = $1 AND ds.total_amount > 0
     ) x ORDER BY entry_date`,
    [req.params.id]
  );
  // الصفوف كلها تُجلب (كما كان) ثم تُقص بالفترة، والصف الافتتاحي يحمل رصيد ما قبل from
  res.json(buildLedger(rows, range, "in-out"));
}));

// المندوب يدفع لمورد نقدًا من عهدته الشخصية (يصرف من رصيده هو، مو من خزينة الشركة مباشرة)
financeRouter.post("/drivers/:id/pay-supplier", requireActorType("employee"), asyncRoute(async (req, res) => {
  assertUuid(req.params.id);
  if (req.actor.role !== "driver") throw new ApiError(403, "هذا الإجراء مخصص لمندوبي التوصيل");
  if (req.actor.id !== req.params.id) throw new ApiError(403, "لا تقدر تصرف من عهدة مندوب ثاني");

  const body = z.object({
    supplierId: z.string().uuid(),
    amount: amountSchema,
    note: z.string().optional(),
  }).parse(req.body);

  const result = await withTransaction(async (client) => {
    // قفل صف المندوب: طلبين متزامنين ما يصرفوا نفس الرصيد مرتين. ومندوب غير فعّال ما يصرف.
    const drv = await lockEmployee(client, req.actor.id, { activeOnly: true });
    if (!drv) throw new ApiError(403, "حسابك غير فعّال، لا يمكن تسجيل دفعات");

    const w = await walletFigures(client, req.actor.id);
    if (toCents(body.amount) > w.balanceC) {
      throw new ApiError(400, `رصيد عهدتك ${fmt(w.balanceC)} د.ل، ما يكفيش لدفع ${fmt(toCents(body.amount))} د.ل`);
    }

    const { rows: sup } = await client.query(`SELECT business_name FROM suppliers WHERE id = $1`, [body.supplierId]);
    if (!sup.length) throw new ApiError(404, "المورد غير موجود");

    // دفع نقدي من جيب المندوب (off_treasury) — ما يمس رصيد أي خزينة، فما يحتاج فحص خزينة
    const { rows: tr } = await client.query(
      `SELECT id FROM treasuries WHERE code = $1`, [resolveTreasuryCode("payment", "cash")]
    );
    if (!tr.length) throw new ApiError(400, "الخزينة غير معروفة");

    const vNumber = await nextDocNumber(client, {
      table: "vouchers", column: "voucher_number", prefix: "V", start: 1000,
    });

    const { rows: [voucher] } = await client.query(
      `INSERT INTO vouchers
         (voucher_number, voucher_type, party_type, party_id, party_name,
          amount, method, treasury_id, approval_status, approved_by, approved_at, note, created_by, paid_by_driver_id, off_treasury)
       VALUES ($1,'payment','supplier',$2,$3,$4,'cash',$5,'approved',$6,now(),$7,$6,$8,true)
       RETURNING *`,
      [vNumber, body.supplierId, sup[0].business_name, body.amount, tr[0].id,
       req.actor.id, body.note || `دفعها المندوب ${req.actor.name} من عهدته`, req.actor.id]
    );

    await writeAudit(client, {
      actorType: "employee", actorId: req.actor.id, actorName: req.actor.name,
      action: "driver.paid_supplier_from_wallet", entityType: "voucher", entityId: voucher.id,
      entityLabel: voucher.voucher_number, after: voucher, ip: req.ip,
    });

    return voucher;
  });

  res.status(201).json(result);
}));

// استرجاع عهدة — الأدمن يستلم من المندوب جزء أو كل "عهدته" نقدًا ويرجّعها لخزينة الشركة الرئيسية
// (نفس الخزينة اللي خرجت منها العهدة: main — كانت سابقًا تدخل sales، فتختلّ الخزينتين).
// السقف = العهدة المتبقية فقط (عهدة − ما صرفه). نقدية COD اللي حصّلها من العملاء ما تُسترجع هنا
// بل تُسلَّم عبر "تسليم النقدية" — كان السماح بها يسجّلها مرتين (استرجاع + تسوية).
financeRouter.post("/drivers/:id/return-float", requirePermission("finance.vouchers"), asyncRoute(async (req, res) => {
  assertUuid(req.params.id);
  const body = z.object({
    amount: amountSchema,
    note: z.string().optional(),
  }).parse(req.body);

  const result = await withTransaction(async (client) => {
    const drv = await lockEmployee(client, req.params.id);
    if (!drv) throw new ApiError(404, "المندوب غير موجود");

    const w = await walletFigures(client, req.params.id);
    if (toCents(body.amount) > w.returnableFloatC) {
      throw new ApiError(
        400,
        `الحد الأقصى لاسترجاع العهدة من ${drv.name} هو ${fmt(w.returnableFloatC)} د.ل (العهدة المتبقية فقط). ` +
        `النقدية المحصّلة من العملاء تُسلَّم عبر "تسليم النقدية"`
      );
    }

    // استلام نقدي إلى الخزينة الرئيسية — قفلها أولًا (نفس ترتيب بقية المسارات: خزينة ← رقم السند)
    // لتسلسل الحركات (بدون فحص رصيد لأنه إيداع)
    const treasury = await lockTreasuryAndCheck(client, resolveTreasuryCode("payment", "cash"), null, "");
    const vNumber = await nextDocNumber(client, {
      table: "vouchers", column: "voucher_number", prefix: "V", start: 1000,
    });

    const { rows: [voucher] } = await client.query(
      `INSERT INTO vouchers
         (voucher_number, voucher_type, party_type, party_id, party_name,
          amount, method, treasury_id, approval_status, approved_by, approved_at, note, created_by, paid_by_driver_id)
       VALUES ($1,'receipt','driver',$2,$3,$4,'cash',$5,'approved',$6,now(),$7,$6,$8)
       RETURNING *`,
      [vNumber, req.params.id, drv.name, body.amount, treasury.id,
       req.actor.id, body.note || `استرجاع عهدة من المندوب ${drv.name}`, req.params.id]
    );

    await writeAudit(client, {
      actorType: "employee", actorId: req.actor.id, actorName: req.actor.name,
      action: "driver.float_returned", entityType: "voucher", entityId: voucher.id,
      entityLabel: voucher.voucher_number, after: voucher, ip: req.ip,
    });

    return voucher;
  });

  res.status(201).json(result);
}));

// ====================================================================
// الرواتب
// ====================================================================
financeRouter.post("/salaries", requirePermission("finance.salaries"), asyncRoute(async (req, res) => {
  const body = z.object({
    employeeId: z.string().uuid(),
    periodMonth: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
    amount: amountSchema,
    method: z.enum(["cash", "transfer"]),
    note: z.string().optional(),
  }).parse(req.body);

  const payment = await withTransaction(async (client) => {
    // قفل صف الموظف: دفعتين متزامنتين لنفس الراتب ما يتجاوزوا المستحق
    const { rows: emp } = await client.query(
      `SELECT name, monthly_salary FROM employees WHERE id = $1 AND is_active FOR UPDATE`,
      [body.employeeId]
    );
    if (!emp.length) throw new ApiError(404, "الموظف غير موجود");

    const monthDate = `${body.periodMonth}-01`;
    const { rows: paid } = await client.query(
      `SELECT COALESCE(SUM(amount),0) AS total FROM salary_payments
        WHERE employee_id = $1 AND period_month = $2::DATE`,
      [body.employeeId, monthDate]
    );
    const dueC = toCents(emp[0].monthly_salary);
    const paidC = toCents(paid[0].total);
    if (paidC + toCents(body.amount) > dueC) {
      throw new ApiError(
        400,
        `المبلغ يتجاوز راتب الموظف المستحق عن هذا الشهر (المتبقي ${fmt(Math.max(dueC - paidC, 0))} د.ل)`
      );
    }

    const treasury = await lockTreasuryAndCheck(
      client, resolveTreasuryCode("payment", body.method), body.amount, "صرف الراتب"
    );

    const vNumber = await nextDocNumber(client, {
      table: "vouchers", column: "voucher_number", prefix: "V", start: 1000,
    });

    const { rows: [voucher] } = await client.query(
      `INSERT INTO vouchers
         (voucher_number, voucher_type, party_type, party_id, party_name,
          amount, method, treasury_id, approval_status, approved_by, approved_at, note, created_by)
       VALUES ($1,'payment','employee',$2,$3,$4,$5,$6,'approved',$7,now(),$8,$7)
       RETURNING *`,
      [vNumber, body.employeeId, emp[0].name, body.amount, body.method, treasury.id,
       req.actor.id, `راتب ${body.periodMonth}`]
    );

    const sNumber = await nextDocNumber(client, {
      table: "salary_payments", column: "payment_number", prefix: "SAL", start: 1000,
    });
    const { rows } = await client.query(
      `INSERT INTO salary_payments
         (payment_number, employee_id, period_month, amount, method, voucher_id, note, paid_by)
       VALUES ($1,$2,$3::DATE,$4,$5,$6,$7,$8) RETURNING *`,
      [sNumber, body.employeeId, monthDate, body.amount, body.method,
       voucher.id, body.note ?? null, req.actor.id]
    );

    await writeAudit(client, {
      actorType: "employee", actorId: req.actor.id, actorName: req.actor.name,
      action: "salary.paid", entityType: "salary_payment", entityId: rows[0].id,
      entityLabel: `${emp[0].name} — ${body.periodMonth}`, after: rows[0], ip: req.ip,
    });
    return rows[0];
  });

  res.status(201).json(payment);
}));

// ====================================================================
// كشوف الحساب والأرصدة
// ====================================================================

financeRouter.get("/ledger/customer/:id", asyncRoute(async (req, res) => {
  assertUuid(req.params.id);
  await assertCanReadFinance(req, { ownerType: "customer", ownerId: req.params.id });
  const range = parseRange(req.query);
  const { rows } = await query(
    `SELECT * FROM ( SELECT o.customer_id, o.created_at AS entry_date, 'فاتورة ' || o.order_number AS label, o.order_number AS reference, NULL::text AS voucher_number, o.grand_total AS debit, 0 AS credit FROM orders o WHERE o.customer_id = $1 AND o.status NOT IN ('draft','under_review','cancelled','postponed') UNION ALL SELECT v.party_id AS customer_id, v.created_at AS entry_date, CASE WHEN v.voucher_type = 'payment' THEN 'صرف نقدي للعميل (استرجاع)' ELSE 'إيصال قبض' END AS label, COALESCE(o2.order_number, '') AS reference, v.voucher_number, CASE WHEN v.voucher_type = 'payment' THEN v.amount ELSE 0 END AS debit, CASE WHEN v.voucher_type = 'payment' THEN 0 ELSE v.amount END AS credit FROM vouchers v LEFT JOIN orders o2 ON o2.id = v.order_id WHERE v.party_type = 'customer' AND v.party_id = $1 AND v.approval_status = 'approved' AND v.voucher_type IN ('receipt','payment') UNION ALL SELECT r.customer_id, r.created_at AS entry_date, 'إشعار دائن - إرجاع ' || r.return_number AS label, o3.order_number AS reference, r.return_number AS voucher_number, 0 AS debit, r.refund_amount AS credit FROM returns r JOIN orders o3 ON o3.id = r.order_id WHERE r.customer_id = $1 AND r.status = 'refunded' AND r.refund_method IN ('credit_note','cash') AND r.refund_amount > 0 ) x ORDER BY entry_date`,
    [req.params.id]
  );
  res.json(buildLedger(rows, range, "debit-credit", { customer_id: req.params.id }));
}));

// رصيد كل عميل مجمّعًا من كشف حسابه الكامل (وليس من إجمالي الطلبيات فقط) —
// يشمل سندات القبض غير المرتبطة بطلبية، فيعكس الرصيد الفعلي: مدين (يدين للشركة)
// أو دائن (الشركة مدينة له) لو دفع أكثر من المطلوب. نفس مصدر كشف الحساب التفصيلي.
// ترقيم: limit/offset (الافتراضي 200، الأقصى 1000) مرتّبة بالاسم.
financeRouter.get("/balances/customers", requirePermission("reports.view"), asyncRoute(async (req, res) => {
  const { limit, offset } = pageParams(req);
  const { rows } = await query(
    `SELECT c.id, c.business_name AS name, c.phone,
            COALESCE(SUM(x.debit),0)::numeric  AS total_debit,
            COALESCE(SUM(x.credit),0)::numeric AS total_credit
       FROM (SELECT id, business_name, phone FROM customers
              ORDER BY business_name, id LIMIT $1 OFFSET $2) c
       LEFT JOIN (
         SELECT o.customer_id, o.grand_total AS debit, 0 AS credit
           FROM orders o
          WHERE o.status NOT IN ('draft','under_review','cancelled','postponed')
         UNION ALL
         SELECT v.party_id AS customer_id,
                CASE WHEN v.voucher_type = 'payment' THEN v.amount ELSE 0 END AS debit,
                CASE WHEN v.voucher_type = 'payment' THEN 0 ELSE v.amount END AS credit
           FROM vouchers v
          WHERE v.party_type = 'customer' AND v.approval_status = 'approved'
            AND v.voucher_type IN ('receipt','payment')
         UNION ALL
         SELECT r.customer_id, 0 AS debit, r.refund_amount AS credit
           FROM returns r
          WHERE r.status = 'refunded' AND r.refund_method IN ('credit_note','cash') AND r.refund_amount > 0
       ) x ON x.customer_id = c.id
      GROUP BY c.id, c.business_name, c.phone
      ORDER BY c.business_name, c.id`,
    [limit, offset]
  );
  res.json(rows.map((r) => ({
    id: r.id, name: r.name, phone: r.phone,
    balance: fromCents(toCents(r.total_debit) - toCents(r.total_credit)),
  })));
}));

// نفس الفكرة للموردين — بالاتجاه المعاكس (دائن = الشركة مدينة للمورد، الوضع الطبيعي).
// (يعتمد على v_supplier_ledger — راجع تعريفها الحقيقي في القاعدة)
financeRouter.get("/balances/suppliers", requirePermission("reports.view"), asyncRoute(async (req, res) => {
  const { limit, offset } = pageParams(req);
  const { rows } = await query(
    `SELECT s.id, s.business_name AS name, s.phone,
            COALESCE(SUM(x.debit),0)::numeric  AS total_debit,
            COALESCE(SUM(x.credit),0)::numeric AS total_credit
       FROM (SELECT id, business_name, phone FROM suppliers
              ORDER BY business_name, id LIMIT $1 OFFSET $2) s
       LEFT JOIN (
         SELECT supplier_id, debit, credit FROM v_supplier_ledger
       ) x ON x.supplier_id = s.id
      GROUP BY s.id, s.business_name, s.phone
      ORDER BY s.business_name, s.id`,
    [limit, offset]
  );
  res.json(rows.map((r) => ({
    id: r.id, name: r.name, phone: r.phone,
    balance: fromCents(toCents(r.total_credit) - toCents(r.total_debit)),
  })));
}));

financeRouter.get("/ledger/supplier/:id", asyncRoute(async (req, res) => {
  assertUuid(req.params.id);
  await assertCanReadFinance(req, { ownerType: "supplier", ownerId: req.params.id });
  const range = parseRange(req.query);
  const { rows } = await query(
    `SELECT supplier_id, entry_date, label, reference, voucher_number, debit, credit FROM v_supplier_ledger WHERE supplier_id = $1 ORDER BY entry_date`,
    [req.params.id]
  );
  res.json(buildLedger(rows, range, "credit-debit", { supplier_id: req.params.id }));
}));

// جلب بيانات إيصال قبض/صرف واحد يخص المورد أو العميل نفسه — تُستخدم لبناء صفحة
// طباعة PDF من جانب تطبيق المورد أو تطبيق العميل
financeRouter.get("/vouchers/me/:id", requireActorType("supplier", "customer"), asyncRoute(async (req, res) => {
  assertUuid(req.params.id);
  const { rows } = await query(
    `SELECT * FROM vouchers WHERE id = $1 AND party_type = $2 AND party_id = $3`,
    [req.params.id, req.actor.type, req.actor.id]
  );
  if (!rows.length) throw new ApiError(404, "الإيصال غير موجود");
  res.json(rows[0]);
}));

// قائمة سندات القبض/الصرف المعتمدة الخاصة بالمورد أو العميل نفسه — تُستخدم لعرض
// شاشة "سنداتي" بتطبيق المورد أو تطبيق العميل
financeRouter.get("/vouchers/mine", requireActorType("supplier", "customer"), asyncRoute(async (req, res) => {
  const { limit, offset } = pageParams(req);
  const range = parseRange(req.query);
  const params = [req.actor.type, req.actor.id, limit, offset];
  const conds = [];
  addRange("created_at", range, params, conds);
  const { rows } = await query(
    `SELECT * FROM vouchers
      WHERE party_type = $1 AND party_id = $2 AND approval_status = 'approved'${andClause(conds)}
      ORDER BY created_at DESC, id LIMIT $3 OFFSET $4`,
    params
  );
  res.json(rows);
}));

// ====================================================================
// المصروفات
// ====================================================================

const EXPENSE_CATEGORIES = {
  rent: "إيجار", utilities: "كهرباء وماء", fuel: "وقود",
  maintenance: "صيانة", supplies: "مستلزمات", salaries_related: "متعلق بالرواتب", other: "أخرى",
};

const expenseSchema = z.object({
  category: z.enum(Object.keys(EXPENSE_CATEGORIES)),
  description: z.string().min(2),
  beneficiary: z.string().optional(),
  amount: amountSchema,
  method: z.enum(["cash", "transfer"]),
  expenseDate: z.string().regex(/^\d{4}-\d{2}-\d{2}/).transform((v) => v.slice(0, 10)).optional(),
});

financeRouter.post("/expenses", requirePermission("finance.expenses"), asyncRoute(async (req, res) => {
  const body = expenseSchema.parse(req.body);
  const treasuryCode = resolveTreasuryCode("payment", body.method);

  const expense = await withTransaction(async (client) => {
    // قفل الخزينة + فحص الرصيد قبل تسجيل المصروف
    const treasury = await lockTreasuryAndCheck(client, treasuryCode, body.amount, "المصروف");

    const number = await nextDocNumber(client, {
      table: "expenses", column: "expense_number", prefix: "EXP", start: 1000,
    });

    const { rows } = await client.query(
      `INSERT INTO expenses
         (expense_number, category, description, beneficiary, amount, method,
          treasury_id, expense_date, recorded_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,COALESCE($8::DATE, (now() AT TIME ZONE 'Africa/Tripoli')::DATE),$9)
       RETURNING *`,
      [number, body.category, body.description, body.beneficiary ?? null, body.amount,
       body.method, treasury.id, body.expenseDate ?? null, req.actor.id]
    );
    const created = rows[0];

    await writeAudit(client, {
      actorType: "employee", actorId: req.actor.id, actorName: req.actor.name,
      action: "expense.recorded", entityType: "expense", entityId: created.id,
      entityLabel: `${EXPENSE_CATEGORIES[body.category]} — ${body.description}`, after: created, ip: req.ip,
    });
    return created;
  });

  res.status(201).json(expense);
}));

financeRouter.get("/expenses", requirePermission("finance.expenses"), asyncRoute(async (req, res) => {
  const { category, search } = req.query;
  const { from, to } = parseRange(req.query);
  const { rows } = await query(
    `SELECT e.*, t.code AS treasury_code, t.name AS treasury_name
       FROM expenses e JOIN treasuries t ON t.id = e.treasury_id
      WHERE ($1::TEXT IS NULL OR e.category = $1)
        AND ($2::TEXT IS NULL OR e.description ILIKE '%'||$2||'%'
             OR e.beneficiary ILIKE '%'||$2||'%' OR e.expense_number ILIKE '%'||$2||'%')
        AND ($3::DATE IS NULL OR e.expense_date >= $3)
        AND ($4::DATE IS NULL OR e.expense_date <= $4)
      ORDER BY e.expense_date DESC, e.created_at DESC`,
    [category || null, search || null, from || null, to || null]
  );
  res.json(rows);
}));

financeRouter.get("/expenses/summary", requirePermission("finance.expenses"), asyncRoute(async (req, res) => {
  const range = parseRange(req.query);
  const params = [];
  const conds = [];
  addDateColRange("expense_date", range, params, conds);
  const { rows } = await query(
    `SELECT category, COUNT(*)::INT AS count, SUM(amount) AS total
       FROM expenses${conds.length ? " WHERE " + conds.join(" AND ") : ""}
      GROUP BY category ORDER BY total DESC`,
    params
  );
  res.json(rows.map((r) => ({ ...r, categoryLabel: EXPENSE_CATEGORIES[r.category] })));
}));

// ====================================================================
// كشف أرباح جملة
// ====================================================================
// عمولة الموردين المحصّلة (من الأجزاء غير الملغاة في الطلبيات المسلَّمة/المقفولة) ناقص المصروفات
// المسجّلة، خلال فترة محدَّدة. تواريخ التسليم تُحتسب بتوقيت ليبيا. رسوم التوصيل تظهر كبند دخل
// منفصل (totalDeliveryFees) ولا تدخل في netProfit للحفاظ على المعنى القديم؛ netProfitWithDelivery
// يشملها (تكلفة المندوب/المركبة غير مسجّلة كمصروف تلقائيًا — الحكم للإدارة).
const dateParam = z.string().regex(/^\d{4}-\d{2}-\d{2}/).transform((s) => s.slice(0, 10));

financeRouter.get("/profit-report", requirePermission("finance.expenses"), asyncRoute(async (req, res) => {
  const { from, to, groupBy } = z.object({
    from: dateParam.optional(),
    to: dateParam.optional(),
    groupBy: z.enum(["day", "month", "year"]).default("day"),
  }).parse(req.query);

  const DELIVERED_LY = `((o.delivered_at) AT TIME ZONE 'Africa/Tripoli')::date`;

  const totals = await query(
    `SELECT
        COALESCE((
          SELECT SUM(os.subtotal * os.commission_rate / 100.0)
            FROM order_suppliers os JOIN orders o ON o.id = os.order_id
           WHERE o.status IN ('delivered','closed') AND os.status <> 'cancelled'
             AND ($1::DATE IS NULL OR ${DELIVERED_LY} >= $1)
             AND ($2::DATE IS NULL OR ${DELIVERED_LY} <= $2)
        ), 0) AS total_commission,
        COALESCE((
          SELECT SUM(o.delivery_fee) FROM orders o
           WHERE o.status IN ('delivered','closed') AND o.fulfillment = 'delivery'
             AND ($1::DATE IS NULL OR ${DELIVERED_LY} >= $1)
             AND ($2::DATE IS NULL OR ${DELIVERED_LY} <= $2)
        ), 0) AS total_delivery_fees,
        COALESCE((
          SELECT SUM(amount) FROM expenses e
           WHERE ($1::DATE IS NULL OR e.expense_date >= $1)
             AND ($2::DATE IS NULL OR e.expense_date <= $2)
        ), 0) AS total_expenses`,
    [from || null, to || null]
  );

  const series = await query(
    `SELECT bucket, SUM(commission) AS commission, SUM(delivery_fees) AS delivery_fees, SUM(expenses) AS expenses
       FROM (
         SELECT date_trunc($3::text, ((o.delivered_at) AT TIME ZONE 'Africa/Tripoli'))::DATE AS bucket,
                os.subtotal * os.commission_rate / 100.0 AS commission, 0 AS delivery_fees, 0 AS expenses
           FROM order_suppliers os JOIN orders o ON o.id = os.order_id
          WHERE o.status IN ('delivered','closed') AND os.status <> 'cancelled'
            AND ($1::DATE IS NULL OR ${DELIVERED_LY} >= $1)
            AND ($2::DATE IS NULL OR ${DELIVERED_LY} <= $2)
         UNION ALL
         SELECT date_trunc($3::text, ((o.delivered_at) AT TIME ZONE 'Africa/Tripoli'))::DATE AS bucket,
                0 AS commission, o.delivery_fee AS delivery_fees, 0 AS expenses
           FROM orders o
          WHERE o.status IN ('delivered','closed') AND o.fulfillment = 'delivery'
            AND ($1::DATE IS NULL OR ${DELIVERED_LY} >= $1)
            AND ($2::DATE IS NULL OR ${DELIVERED_LY} <= $2)
         UNION ALL
         SELECT date_trunc($3::text, e.expense_date::timestamp)::DATE AS bucket,
                0 AS commission, 0 AS delivery_fees, e.amount AS expenses
           FROM expenses e
          WHERE ($1::DATE IS NULL OR e.expense_date >= $1)
            AND ($2::DATE IS NULL OR e.expense_date <= $2)
       ) x
      GROUP BY bucket
      ORDER BY bucket`,
    [from || null, to || null, groupBy]
  );

  const totalCommission = round2(totals.rows[0].total_commission);
  const totalDeliveryFees = round2(totals.rows[0].total_delivery_fees);
  const totalExpenses = round2(totals.rows[0].total_expenses);

  res.json({
    totalCommission,
    totalDeliveryFees,
    totalExpenses,
    netProfit: round2(totalCommission - totalExpenses),
    netProfitWithDelivery: round2(totalCommission + totalDeliveryFees - totalExpenses),
    series: series.rows.map((r) => ({
      bucket: r.bucket,
      commission: round2(r.commission),
      deliveryFees: round2(r.delivery_fees),
      expenses: round2(r.expenses),
      netProfit: round2(Number(r.commission) - Number(r.expenses)),
      netProfitWithDelivery: round2(Number(r.commission) + Number(r.delivery_fees) - Number(r.expenses)),
    })),
  });
}));
