import { Router } from "express";
import { z } from "zod";
import { query, withTransaction, writeAudit } from "../lib/db.js";
import { ApiError, asyncRoute, nextDocNumber, resolveTreasuryCode } from "../lib/helpers.js";
import { authenticate, requirePermission, requireActorType } from "../middleware/auth.js";
import { queueNotification, notifyManager } from "../lib/notify.js";

export const financeRouter = Router();
financeRouter.use(authenticate);

const voucherSchema = z.object({
  voucherType: z.enum(["receipt", "payment"]),
  partyType: z.enum(["customer", "supplier", "driver", "employee", "other"]),
  partyId: z.string().uuid().optional(),
  partyName: z.string().min(2),
  amount: z.number().positive(),
  method: z.enum(["cash", "transfer", "card"]),
  orderId: z.string().uuid().optional(),
  transferReference: z.string().optional(),
  transferImageUrl: z.string().url().optional(),
  note: z.string().optional(),
});

financeRouter.post("/vouchers", requirePermission("finance.vouchers"), asyncRoute(async (req, res) => {
  const body = voucherSchema.parse(req.body);
  const treasuryCode = resolveTreasuryCode(body.voucherType, body.method);

  const voucher = await withTransaction(async (client) => {
    const { rows: tr } = await client.query(`SELECT id FROM treasuries WHERE code = $1`, [treasuryCode]);
    if (!tr.length) throw new ApiError(400, "الخزينة غير معروفة");

    const number = await nextDocNumber(client, {
      table: "vouchers", column: "voucher_number", prefix: "V", start: 1000,
    });

    const approvalStatus = body.method === "transfer" ? "pending" : "approved";

    const { rows } = await client.query(
      `INSERT INTO vouchers
         (voucher_number, voucher_type, party_type, party_id, party_name,
          amount, method, treasury_id, order_id, transfer_reference,
          transfer_image_url, approval_status, approved_by, approved_at, note, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,
               CASE WHEN $12 = 'approved' THEN $14::UUID END,
               CASE WHEN $12 = 'approved' THEN now() END,
               $13,$14)
       RETURNING *`,
      [number, body.voucherType, body.partyType, body.partyId ?? null, body.partyName,
       body.amount, body.method, tr[0].id, body.orderId ?? null,
       body.transferReference ?? null, body.transferImageUrl ?? null,
       approvalStatus, body.note ?? null, req.actor.id]
    );
    const voucher = rows[0];

    if (body.orderId && body.voucherType === "receipt" && approvalStatus === "approved") {
      await client.query(
        `UPDATE orders SET
           paid_amount = paid_amount + $2,
           payment_status = CASE WHEN paid_amount + $2 >= grand_total
                                 THEN 'paid' ELSE 'partially_paid' END
         WHERE id = $1`,
        [body.orderId, body.amount]
      );
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
    return voucher;
  });

  if (voucher.approval_status === "approved") {
    notifyManager(
      `إيصال ${voucher.voucher_type === "receipt" ? "قبض" : "دفع"} جديد\n` +
      `رقم: ${voucher.voucher_number}\nباسم: ${voucher.party_name}\nبقيمة: ${Number(voucher.amount).toFixed(2)} د.ل`
    ).catch(() => {});
  }

  res.status(201).json(voucher);
}));

financeRouter.post("/vouchers/:id/decide", requirePermission("finance.vouchers"), asyncRoute(async (req, res) => {
  const { approve, reason } = z.object({
    approve: z.boolean(), reason: z.string().optional(),
  }).parse(req.body);

  const result = await withTransaction(async (client) => {
    const { rows } = await client.query(`SELECT * FROM vouchers WHERE id = $1 FOR UPDATE`, [req.params.id]);
    if (!rows.length) throw new ApiError(404, "الإيصال غير موجود");
    const v = rows[0];
    if (v.approval_status !== "pending") throw new ApiError(400, "تمت معالجة هذا الإيصال مسبقًا");

    const { rows: [updated] } = await client.query(
      `UPDATE vouchers SET approval_status = $2, approved_by = $3, approved_at = now(),
              note = COALESCE($4, note)
       WHERE id = $1 RETURNING *`,
      [v.id, approve ? "approved" : "rejected", req.actor.id, reason ?? null]
    );

    if (approve && v.order_id && v.voucher_type === "receipt") {
      await client.query(
        `UPDATE orders SET
           paid_amount = paid_amount + $2,
           payment_status = CASE WHEN paid_amount + $2 >= grand_total
                                 THEN 'paid' ELSE 'partially_paid' END
         WHERE id = $1`,
        [v.order_id, v.amount]
      );
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

  if (approve) {
    notifyManager(
      `إيصال ${result.voucher_type === "receipt" ? "قبض" : "دفع"} معتمد\n` +
      `رقم: ${result.voucher_number}\nباسم: ${result.party_name}\nبقيمة: ${Number(result.amount).toFixed(2)} د.ل`
    ).catch(() => {});
  }

  res.json(result);
}));

financeRouter.get("/vouchers", requirePermission("finance.vouchers"), asyncRoute(async (req, res) => {
  const { treasuryCode, method, search } = req.query;
  const { rows } = await query(
    `SELECT v.*, t.code AS treasury_code, t.name AS treasury_name
       FROM vouchers v JOIN treasuries t ON t.id = v.treasury_id
      WHERE ($1::TEXT IS NULL OR t.code = $1)
        AND ($2::TEXT IS NULL OR v.method = $2)
        AND ($3::TEXT IS NULL OR v.party_name ILIKE '%'||$3||'%'
             OR v.voucher_number ILIKE '%'||$3||'%')
      ORDER BY v.created_at DESC LIMIT 500`,
    [treasuryCode || null, method || null, search || null]
  );
  res.json(rows);
}));

financeRouter.post("/transfers", requirePermission("finance.transfers"), asyncRoute(async (req, res) => {
  const body = z.object({
    fromCode: z.enum(["sales", "main"]),
    toCode: z.enum(["sales", "main"]),
    amount: z.number().positive(),
    note: z.string().optional(),
  }).parse(req.body);

  if (body.fromCode === body.toCode) throw new ApiError(400, "لا يمكن التحويل لنفس الخزينة");

  const transfer = await withTransaction(async (client) => {
    const { rows: tr } = await client.query(
      `SELECT code, id FROM treasuries WHERE code = ANY($1)`, [[body.fromCode, body.toCode]]
    );
    const map = Object.fromEntries(tr.map((t) => [t.code, t.id]));

    const { rows: bal } = await client.query(
      `SELECT balance FROM v_treasury_balances WHERE code = $1`, [body.fromCode]
    );
    if (bal.length && Number(bal[0].balance) < body.amount) {
      throw new ApiError(400, "الرصيد غير كافٍ في الخزينة المحوَّل منها");
    }

    const number = await nextDocNumber(client, {
      table: "treasury_transfers", column: "transfer_number", prefix: "T", start: 1000,
    });
    const { rows } = await client.query(
      `INSERT INTO treasury_transfers
         (transfer_number, from_treasury_id, to_treasury_id, amount, note, created_by)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [number, map[body.fromCode], map[body.toCode], body.amount, body.note ?? null, req.actor.id]
    );

    await writeAudit(client, {
      actorType: "employee", actorId: req.actor.id, actorName: req.actor.name,
      action: "treasury.transfer", entityType: "treasury_transfer", entityId: rows[0].id,
      entityLabel: number, after: rows[0], ip: req.ip,
    });
    return rows[0];
  });

  res.status(201).json(transfer);
}));

financeRouter.get("/treasuries", requirePermission("finance.vouchers"), asyncRoute(async (_req, res) => {
  const { rows } = await query(`SELECT * FROM v_treasury_balances ORDER BY code`);
  res.json(rows);
}));

financeRouter.post("/drivers/:id/settle", requirePermission("finance.vouchers"), asyncRoute(async (req, res) => {
  // declaredAmount = المبلغ اللي عدّته الإدارة فعليًا من يد المندوب. لو ما انبعتش،
  // نفترض إنه طابق المحسوب (توافق مع أي استدعاء قديم). أي فرق ينحفظ فورًا كراية،
  // مش يضيع.
  const body = z.object({
    declaredAmount: z.number().positive().optional(),
  }).parse(req.body ?? {});

  const result = await withTransaction(async (client) => {
    const { rows: pending } = await client.query(
      `SELECT id, order_number, cod_amount FROM orders
        WHERE driver_id = $1 AND cod_collected AND NOT cod_settled FOR UPDATE`,
      [req.params.id]
    );
    if (!pending.length) throw new ApiError(400, "لا توجد مبالغ معلّقة لهذا المندوب");

    const total = pending.reduce((s, o) => s + Number(o.cod_amount), 0);
    const declaredAmount = body.declaredAmount ?? total;
    const discrepancy = Number((declaredAmount - total).toFixed(2));
    const { rows: drv } = await client.query(`SELECT name FROM employees WHERE id = $1`, [req.params.id]);

    const vNumber = await nextDocNumber(client, {
      table: "vouchers", column: "voucher_number", prefix: "V", start: 1000,
    });
    const { rows: tr } = await client.query(`SELECT id FROM treasuries WHERE code = 'sales'`);

    const { rows: [voucher] } = await client.query(
      `INSERT INTO vouchers
         (voucher_number, voucher_type, party_type, party_id, party_name,
          amount, method, treasury_id, approval_status, approved_by, approved_at, note, created_by)
       VALUES ($1,'receipt','driver',$2,$3,$4,'cash',$5,'approved',$6,now(),$7,$6)
       RETURNING *`,
      [vNumber, req.params.id, drv[0]?.name ?? "مندوب", declaredAmount, tr[0].id, req.actor.id,
       discrepancy !== 0
         ? `تسليم نقدية من مندوب التوصيل — فرق ${discrepancy > 0 ? "زيادة" : "نقص"} قدره ${Math.abs(discrepancy).toFixed(2)} د.ل عن المحسوب (${total.toFixed(2)} د.ل)`
         : `تسليم نقدية من مندوب التوصيل`]
    );

    const { rows: [settlement] } = await client.query(
      `INSERT INTO driver_settlements (driver_id, total_amount, declared_amount, discrepancy, voucher_id, settled_by)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [req.params.id, total, declaredAmount, discrepancy, voucher.id, req.actor.id]
    );

    for (const o of pending) {
      await client.query(
        `INSERT INTO driver_settlement_orders (settlement_id, order_id, amount) VALUES ($1,$2,$3)`,
        [settlement.id, o.id, o.cod_amount]
      );
    }
    await client.query(
      `UPDATE orders SET cod_settled = TRUE
        WHERE driver_id = $1 AND cod_collected AND NOT cod_settled`,
      [req.params.id]
    );

    await writeAudit(client, {
      actorType: "employee", actorId: req.actor.id, actorName: req.actor.name,
      action: "driver.settled", entityType: "driver_settlement", entityId: settlement.id,
      entityLabel: drv[0]?.name, after: settlement, ip: req.ip,
    });

    return { settlement, voucher, ordersCount: pending.length, total, declaredAmount, discrepancy };
  });

  res.json(result);
}));

financeRouter.get("/drivers/cash", requirePermission("reports.view"), asyncRoute(async (_req, res) => {
  // نضيف هنا رصيد العهدة الكامل (float_given + cash_in_hand - paid_out) لكل
  // مندوب، بنفس آلية computeDriverWalletBalance بالضبط، بس بجولة واحدة لكل
  // المندوبين مع بعض بدل ما نسأل عن كل مندوب لحاله — عشان لوحة "تحصيلات
  // المندوبين" تقدر تعرض رصيد العهدة مباشرة من غير ما تفتح محفظة كل مندوب
  // واحد واحد.
  const { rows } = await query(
    `SELECT dc.*,
            COALESCE(f.total, 0)                                      AS float_given,
            COALESCE(p.total, 0)                                      AS paid_out,
            COALESCE(f.total, 0) + dc.cash_in_hand - COALESCE(p.total, 0) AS wallet_balance
       FROM v_driver_cash dc
       LEFT JOIN (
         SELECT party_id, SUM(amount) AS total FROM vouchers
          WHERE party_type = 'driver' AND voucher_type = 'payment'
            AND method = 'cash' AND approval_status = 'approved'
          GROUP BY party_id
       ) f ON f.party_id = dc.driver_id
       LEFT JOIN (
         SELECT paid_by_driver_id, SUM(amount) AS total FROM vouchers
          WHERE paid_by_driver_id IS NOT NULL AND approval_status = 'approved'
          GROUP BY paid_by_driver_id
       ) p ON p.paid_by_driver_id = dc.driver_id
      ORDER BY wallet_balance DESC`
  );
  res.json(rows);
}));

// رصيد العهدة لكل الموظفين (مش المندوبين بس) — نفس جدول "vouchers" اللي
// يسجّل العهد يشتغل لأي موظف نشط، مش مربوط بدور "مندوب" تحديدًا في الباك
// اند (شوف POST /drivers/:id/float — ما فيهوش شرط role === 'driver')، بس
// v_driver_cash نفسها مبنية على orders.driver_id فقط فما تجيبش موظف عادي
// ماعندوش طلبيات. هذا المسار يرجّع رصيد العهدة لكل موظف نشط بغض النظر عن دوره،
// عشان يتعرض جنب كل موظف في صفحة "الموظفون والرواتب".
financeRouter.get("/employees/wallets", requirePermission("reports.view"), asyncRoute(async (_req, res) => {
  const { rows } = await query(
    `SELECT e.id AS employee_id,
            COALESCE(f.total, 0)                                        AS float_given,
            COALESCE(c.total, 0)                                        AS cod_in_hand,
            COALESCE(p.total, 0)                                        AS paid_out,
            COALESCE(f.total, 0) + COALESCE(c.total, 0) - COALESCE(p.total, 0) AS balance
       FROM employees e
       LEFT JOIN (
         SELECT party_id, SUM(amount) AS total FROM vouchers
          WHERE party_type = 'driver' AND voucher_type = 'payment'
            AND method = 'cash' AND approval_status = 'approved'
          GROUP BY party_id
       ) f ON f.party_id = e.id
       LEFT JOIN (
         SELECT driver_id, SUM(cod_amount) AS total FROM orders
          WHERE cod_collected AND NOT cod_settled
          GROUP BY driver_id
       ) c ON c.driver_id = e.id
       LEFT JOIN (
         SELECT paid_by_driver_id, SUM(amount) AS total FROM vouchers
          WHERE paid_by_driver_id IS NOT NULL AND approval_status = 'approved'
          GROUP BY paid_by_driver_id
       ) p ON p.paid_by_driver_id = e.id
      WHERE e.is_active`
  );
  res.json(rows);
}));

// ====== عهدة/محفظة المندوب ======
// الإدارة تسلّم المندوب مبلغ نقدي (عهدة) يستخدمه لاحقًا في الدفع للموردين نيابة عن الشركة
financeRouter.post("/drivers/:id/float", requirePermission("finance.vouchers"), asyncRoute(async (req, res) => {
  const body = z.object({
    amount: z.number().positive(),
    note: z.string().optional(),
  }).parse(req.body);

  const result = await withTransaction(async (client) => {
    const { rows: drv } = await client.query(
      `SELECT name FROM employees WHERE id = $1 AND is_active`, [req.params.id]
    );
    if (!drv.length) throw new ApiError(404, "المندوب غير موجود");

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
          amount, method, treasury_id, approval_status, approved_by, approved_at, note, created_by)
       VALUES ($1,'payment','driver',$2,$3,$4,'cash',$5,'approved',$6,now(),$7,$6)
       RETURNING *`,
      [vNumber, req.params.id, drv[0].name, body.amount, tr[0].id,
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

// رصيد عهدة/محفظة المندوب الحالي: (العهدة اللي سلّمته الإدارة) + (كاش حصّله من العملاء ولسا ما سلّمهش)
// ناقص (اللي صرفه هو نفسه لموردين من عهدته)
async function computeDriverWalletBalance(driverId) {
  const { rows: floatRows } = await query(
    `SELECT COALESCE(SUM(amount),0) AS total FROM vouchers
      WHERE party_type = 'driver' AND party_id = $1 AND voucher_type = 'payment'
        AND method = 'cash' AND approval_status = 'approved'`,
    [driverId]
  );
  const { rows: codRows } = await query(
    `SELECT COALESCE(SUM(cod_amount),0) AS total FROM orders
      WHERE driver_id = $1 AND cod_collected AND NOT cod_settled`,
    [driverId]
  );
  const { rows: paidOutRows } = await query(
    `SELECT COALESCE(SUM(amount),0) AS total FROM vouchers
      WHERE paid_by_driver_id = $1 AND approval_status = 'approved'`,
    [driverId]
  );
  const floatGiven = Number(floatRows[0].total);
  const codInHand = Number(codRows[0].total);
  const paidOut = Number(paidOutRows[0].total);
  return { floatGiven, codInHand, paidOut, balance: floatGiven + codInHand - paidOut };
}

financeRouter.get("/drivers/:id/wallet", asyncRoute(async (req, res) => {
  if (req.actor.role === "driver" && req.actor.id !== req.params.id) {
    throw new ApiError(403, "لا تملك صلاحية الاطلاع على محفظة مندوب آخر");
  }
  const result = await computeDriverWalletBalance(req.params.id);
  res.json(result);
}));

// حركات محفظة المندوب بالتفصيل (زي كشف حساب)
financeRouter.get("/drivers/:id/wallet/transactions", asyncRoute(async (req, res) => {
  if (req.actor.role === "driver" && req.actor.id !== req.params.id) {
    throw new ApiError(403, "لا تملك صلاحية الاطلاع على محفظة مندوب آخر");
  }
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
       SELECT v2.created_at AS entry_date, 'تسليم نقدية للإدارة' AS label,
              v2.voucher_number, 0 AS in_amount, ds.total_amount AS out_amount
         FROM driver_settlements ds JOIN vouchers v2 ON v2.id = ds.voucher_id
        WHERE ds.driver_id = $1
     ) x ORDER BY entry_date`,
    [req.params.id]
  );
  let balance = 0;
  const withBalance = rows.map((r) => {
    balance += Number(r.in_amount) - Number(r.out_amount);
    return { ...r, balance };
  });
  res.json(withBalance);
}));

// المندوب يدفع لمورد نقدًا من عهدته الشخصية (يصرف من رصيده هو، مو من خزينة الشركة مباشرة)
financeRouter.post("/drivers/:id/pay-supplier", requireActorType("employee"), asyncRoute(async (req, res) => {
  if (req.actor.role !== "driver") throw new ApiError(403, "هذا الإجراء مخصص لمندوبي التوصيل");
  if (req.actor.id !== req.params.id) throw new ApiError(403, "لا تقدر تصرف من عهدة مندوب ثاني");

  const body = z.object({
    supplierId: z.string().uuid(),
    amount: z.number().positive(),
    note: z.string().optional(),
  }).parse(req.body);

  const result = await withTransaction(async (client) => {
    const { rows: floatRows } = await client.query(
      `SELECT COALESCE(SUM(amount),0) AS total FROM vouchers
        WHERE party_type = 'driver' AND party_id = $1 AND voucher_type = 'payment'
          AND method = 'cash' AND approval_status = 'approved'`,
      [req.actor.id]
    );
    const { rows: codRows } = await client.query(
      `SELECT COALESCE(SUM(cod_amount),0) AS total FROM orders
        WHERE driver_id = $1 AND cod_collected AND NOT cod_settled`,
      [req.actor.id]
    );
    const { rows: paidOutRows } = await client.query(
      `SELECT COALESCE(SUM(amount),0) AS total FROM vouchers
        WHERE paid_by_driver_id = $1 AND approval_status = 'approved'`,
      [req.actor.id]
    );
    const balance = Number(floatRows[0].total) + Number(codRows[0].total) - Number(paidOutRows[0].total);
    if (body.amount > balance) {
      throw new ApiError(400, `رصيد عهدتك ${balance.toFixed(2)} د.ل، ما يكفيش لدفع ${body.amount.toFixed(2)} د.ل`);
    }

    const { rows: sup } = await client.query(`SELECT business_name FROM suppliers WHERE id = $1`, [body.supplierId]);
    if (!sup.length) throw new ApiError(404, "المورد غير موجود");

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
          amount, method, treasury_id, approval_status, approved_by, approved_at, note, created_by, paid_by_driver_id)
       VALUES ($1,'payment','supplier',$2,$3,$4,'cash',$5,'approved',$6,now(),$7,$6,$8)
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

// استرجاع عهدة — الأدمن يستلم من المندوب جزء أو كل رصيد عهدته نقدًا ويرجّعها
// لخزينة الشركة. عكس "إعطاء عهدة" بالضبط: نفس رصيد المندوب (floatGiven +
// codInHand - paidOut) ينخفض هنا عن طريق paid_by_driver_id، بنفس آلية دفع
// المندوب لمورد من عهدته، بس هنا المستفيد خزينة الشركة مش مورد.
financeRouter.post("/drivers/:id/return-float", requirePermission("finance.vouchers"), asyncRoute(async (req, res) => {
  const body = z.object({
    amount: z.number().positive(),
    note: z.string().optional(),
  }).parse(req.body);

  const result = await withTransaction(async (client) => {
    const { rows: drv } = await client.query(
      `SELECT name FROM employees WHERE id = $1 FOR UPDATE`, [req.params.id]
    );
    if (!drv.length) throw new ApiError(404, "المندوب غير موجود");

    const { rows: floatRows } = await client.query(
      `SELECT COALESCE(SUM(amount),0) AS total FROM vouchers
        WHERE party_type = 'driver' AND party_id = $1 AND voucher_type = 'payment'
          AND method = 'cash' AND approval_status = 'approved'`,
      [req.params.id]
    );
    const { rows: codRows } = await client.query(
      `SELECT COALESCE(SUM(cod_amount),0) AS total FROM orders
        WHERE driver_id = $1 AND cod_collected AND NOT cod_settled`,
      [req.params.id]
    );
    const { rows: paidOutRows } = await client.query(
      `SELECT COALESCE(SUM(amount),0) AS total FROM vouchers
        WHERE paid_by_driver_id = $1 AND approval_status = 'approved'`,
      [req.params.id]
    );
    const balance = Number(floatRows[0].total) + Number(codRows[0].total) - Number(paidOutRows[0].total);
    if (body.amount > balance) {
      throw new ApiError(400, `رصيد عهدة ${drv[0].name} ${balance.toFixed(2)} د.ل، ما يكفيش لاسترجاع ${body.amount.toFixed(2)} د.ل`);
    }

    const vNumber = await nextDocNumber(client, {
      table: "vouchers", column: "voucher_number", prefix: "V", start: 1000,
    });
    const { rows: tr } = await client.query(`SELECT id FROM treasuries WHERE code = 'sales'`);

    const { rows: [voucher] } = await client.query(
      `INSERT INTO vouchers
         (voucher_number, voucher_type, party_type, party_id, party_name,
          amount, method, treasury_id, approval_status, approved_by, approved_at, note, created_by, paid_by_driver_id)
       VALUES ($1,'receipt','driver',$2,$3,$4,'cash',$5,'approved',$6,now(),$7,$6,$8)
       RETURNING *`,
      [vNumber, req.params.id, drv[0].name, body.amount, tr[0].id,
       req.actor.id, body.note || `استرجاع عهدة من المندوب ${drv[0].name}`, req.params.id]
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

financeRouter.post("/salaries", requirePermission("finance.salaries"), asyncRoute(async (req, res) => {
  const body = z.object({
    employeeId: z.string().uuid(),
    periodMonth: z.string().regex(/^\d{4}-\d{2}$/),
    amount: z.number().positive(),
    method: z.enum(["cash", "transfer"]),
    note: z.string().optional(),
  }).parse(req.body);

  const payment = await withTransaction(async (client) => {
    const { rows: emp } = await client.query(
      `SELECT name, monthly_salary FROM employees WHERE id = $1 AND is_active`,
      [body.employeeId]
    );
    if (!emp.length) throw new ApiError(404, "الموظف غير موجود");

    const monthDate = `${body.periodMonth}-01`;
    const { rows: paid } = await client.query(
      `SELECT COALESCE(SUM(amount),0) AS total FROM salary_payments
        WHERE employee_id = $1 AND period_month = $2::DATE`,
      [body.employeeId, monthDate]
    );
    if (Number(paid[0].total) + body.amount > Number(emp[0].monthly_salary)) {
      throw new ApiError(400, "المبلغ يتجاوز راتب الموظف المستحق عن هذا الشهر");
    }

    const vNumber = await nextDocNumber(client, {
      table: "vouchers", column: "voucher_number", prefix: "V", start: 1000,
    });
    const { rows: tr } = await client.query(
      `SELECT id FROM treasuries WHERE code = $1`, [resolveTreasuryCode("payment", body.method)]
    );

    const { rows: [voucher] } = await client.query(
      `INSERT INTO vouchers
         (voucher_number, voucher_type, party_type, party_id, party_name,
          amount, method, treasury_id, approval_status, approved_by, approved_at, note, created_by)
       VALUES ($1,'payment','employee',$2,$3,$4,$5,$6,'approved',$7,now(),$8,$7)
       RETURNING *`,
      [vNumber, body.employeeId, emp[0].name, body.amount, body.method, tr[0].id,
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

financeRouter.get("/ledger/customer/:id", asyncRoute(async (req, res) => {
  if (req.actor.type === "customer" && req.actor.id !== req.params.id) {
    throw new ApiError(403, "لا تملك صلاحية الاطلاع على هذا الكشف");
  }
  const { rows } = await query(
    `SELECT * FROM ( SELECT o.customer_id, o.created_at AS entry_date, 'فاتورة ' || o.order_number AS label, o.order_number AS reference, NULL::text AS voucher_number, o.grand_total AS debit, 0 AS credit FROM orders o WHERE o.customer_id = $1 AND o.status NOT IN ('draft','under_review','cancelled','postponed') UNION ALL SELECT v.party_id AS customer_id, v.created_at AS entry_date, CASE WHEN v.voucher_type = 'payment' THEN 'إشعار دائن (استرجاع)' ELSE 'إيصال قبض' END AS label, COALESCE(o2.order_number, '') AS reference, v.voucher_number, 0 AS debit, v.amount AS credit FROM vouchers v LEFT JOIN orders o2 ON o2.id = v.order_id WHERE v.party_type = 'customer' AND v.party_id = $1 AND v.approval_status = 'approved' AND v.voucher_type IN ('receipt','payment') UNION ALL SELECT r.customer_id, r.created_at AS entry_date, 'إشعار دائن - إرجاع ' || r.return_number AS label, o3.order_number AS reference, r.return_number AS voucher_number, 0 AS debit, r.refund_amount AS credit FROM returns r JOIN orders o3 ON o3.id = r.order_id WHERE r.customer_id = $1 AND r.status = 'refunded' AND r.refund_method = 'credit_note' AND r.refund_amount > 0 ) x ORDER BY entry_date`,
    [req.params.id]
  );
  let balance = 0;
  res.json(rows.map((r) => {
    balance += Number(r.debit) - Number(r.credit);
    return { ...r, balance };
  }));
}));

// رصيد كل عميل مجمّعًا من كشف حسابه الكامل (وليس من إجمالي الطلبيات فقط) —
// يشمل سندات القبض غير المرتبطة بطلبية، فيعكس الرصيد الفعلي: مدين (يدين للشركة)
// أو دائن (الشركة مدينة له) لو دفع أكثر من المطلوب
// ملاحظة: كان هذا التقرير يجيب الأرصدة من v_customer_ledger مباشرة، وهي لا
// تشمل الدفع النقدي عند الاستلام (لا عند المورد ولا مع المندوب) — فكانت تختلف
// عن كشف حساب العميل التفصيلي (اللي فيه هذي الحركات). توا نفس المصدر بالضبط.
financeRouter.get("/balances/customers", requirePermission("reports.view"), asyncRoute(async (_req, res) => {
  const { rows } = await query(
    `SELECT c.id, c.business_name AS name, c.phone,
            COALESCE(SUM(x.debit),0)::numeric  AS total_debit,
            COALESCE(SUM(x.credit),0)::numeric AS total_credit
       FROM customers c
       LEFT JOIN (
         SELECT o.customer_id, o.grand_total AS debit, 0 AS credit
           FROM orders o
          WHERE o.status NOT IN ('draft','under_review','cancelled','postponed')
         UNION ALL
         SELECT v.party_id AS customer_id, 0 AS debit, v.amount AS credit
           FROM vouchers v
          WHERE v.party_type = 'customer' AND v.approval_status = 'approved'
            AND v.voucher_type IN ('receipt','payment')
         UNION ALL
         SELECT r.customer_id, 0 AS debit, r.refund_amount AS credit
           FROM returns r
          WHERE r.status = 'refunded' AND r.refund_method = 'credit_note' AND r.refund_amount > 0
       ) x ON x.customer_id = c.id
      GROUP BY c.id, c.business_name, c.phone`
  );
  res.json(rows.map((r) => ({
    id: r.id, name: r.name, phone: r.phone,
    balance: Number(r.total_debit) - Number(r.total_credit),
  })));
}));

// نفس الفكرة للموردين — بالاتجاه المعاكس (دائن = الشركة مدينة للمورد، الوضع الطبيعي)
// وتشمل الآن أيضًا نقدًا-عند-الاستلام (زي كشف حساب المورد التفصيلي بالضبط)
financeRouter.get("/balances/suppliers", requirePermission("reports.view"), asyncRoute(async (_req, res) => {
  const { rows } = await query(
    `SELECT s.id, s.business_name AS name, s.phone,
            COALESCE(SUM(x.debit),0)::numeric  AS total_debit,
            COALESCE(SUM(x.credit),0)::numeric AS total_credit
       FROM suppliers s
       LEFT JOIN (
         SELECT supplier_id, debit, credit FROM v_supplier_ledger
       ) x ON x.supplier_id = s.id
      GROUP BY s.id, s.business_name, s.phone`
  );
  res.json(rows.map((r) => ({
    id: r.id, name: r.name, phone: r.phone,
    balance: Number(r.total_credit) - Number(r.total_debit),
  })));
}));

financeRouter.get("/ledger/supplier/:id", asyncRoute(async (req, res) => {
  if (req.actor.type === "supplier" && req.actor.id !== req.params.id) {
    throw new ApiError(403, "لا تملك صلاحية الاطلاع على هذا الكشف");
  }
  const { rows } = await query(
    `SELECT supplier_id, entry_date, label, reference, voucher_number, debit, credit FROM v_supplier_ledger WHERE supplier_id = $1 ORDER BY entry_date`,
    [req.params.id]
  );
  let balance = 0;
  res.json(rows.map((r) => {
    balance += Number(r.credit) - Number(r.debit);
    return { ...r, balance };
  }));
}));

// جلب بيانات إيصال قبض/صرف واحد يخص المورد أو العميل نفسه — تُستخدم لبناء صفحة
// طباعة PDF من جانب تطبيق المورد أو تطبيق العميل
financeRouter.get("/vouchers/me/:id", requireActorType("supplier", "customer"), asyncRoute(async (req, res) => {
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
  const { rows } = await query(
    `SELECT * FROM vouchers
      WHERE party_type = $1 AND party_id = $2 AND approval_status = 'approved'
      ORDER BY created_at DESC LIMIT 200`,
    [req.actor.type, req.actor.id]
  );
  res.json(rows);
}));

const EXPENSE_CATEGORIES = {
  rent: "إيجار", utilities: "كهرباء وماء", fuel: "وقود",
  maintenance: "صيانة", supplies: "مستلزمات", salaries_related: "متعلق بالرواتب", other: "أخرى",
};

const expenseSchema = z.object({
  category: z.enum(Object.keys(EXPENSE_CATEGORIES)),
  description: z.string().min(2),
  beneficiary: z.string().optional(),
  amount: z.number().positive(),
  method: z.enum(["cash", "transfer"]),
  expenseDate: z.string().optional(),
});

financeRouter.post("/expenses", requirePermission("finance.expenses"), asyncRoute(async (req, res) => {
  const body = expenseSchema.parse(req.body);
  const treasuryCode = resolveTreasuryCode("payment", body.method);

  const expense = await withTransaction(async (client) => {
    const { rows: tr } = await client.query(`SELECT id FROM treasuries WHERE code = $1`, [treasuryCode]);
    if (!tr.length) throw new ApiError(400, "الخزينة غير معروفة");

    const number = await nextDocNumber(client, {
      table: "expenses", column: "expense_number", prefix: "EXP", start: 1000,
    });

    const { rows } = await client.query(
      `INSERT INTO expenses
         (expense_number, category, description, beneficiary, amount, method,
          treasury_id, expense_date, recorded_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,COALESCE($8::DATE, CURRENT_DATE),$9)
       RETURNING *`,
      [number, body.category, body.description, body.beneficiary ?? null, body.amount,
       body.method, tr[0].id, body.expenseDate ?? null, req.actor.id]
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
  const { category, search, from, to } = req.query;
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

financeRouter.get("/expenses/summary", requirePermission("finance.expenses"), asyncRoute(async (_req, res) => {
  const { rows } = await query(
    `SELECT category, COUNT(*)::INT AS count, SUM(amount) AS total
       FROM expenses GROUP BY category ORDER BY total DESC`
  );
  res.json(rows.map((r) => ({ ...r, categoryLabel: EXPENSE_CATEGORIES[r.category] })));
}));

// كشف أرباح جملة: عمولة الموردين المحصّلة (من الطلبيات المسلَّمة/المقفولة) ناقص
// المصروفات المسجّلة، خلال فترة محدَّدة. يدعم تجميع الفترة (يومي/شهري/سنوي) لعرض بياني
financeRouter.get("/profit-report", requirePermission("finance.expenses"), asyncRoute(async (req, res) => {
  const { from, to, groupBy } = z.object({
    from: z.string().optional(),
    to: z.string().optional(),
    groupBy: z.enum(["day", "month", "year"]).default("day"),
  }).parse(req.query);

  const totals = await query(
    `SELECT
        COALESCE((
          SELECT SUM(os.subtotal * os.commission_rate / 100.0)
            FROM order_suppliers os JOIN orders o ON o.id = os.order_id
           WHERE o.status IN ('delivered','closed')
             AND ($1::DATE IS NULL OR o.delivered_at::DATE >= $1)
             AND ($2::DATE IS NULL OR o.delivered_at::DATE <= $2)
        ), 0) AS total_commission,
        COALESCE((
          SELECT SUM(amount) FROM expenses e
           WHERE ($1::DATE IS NULL OR e.expense_date >= $1)
             AND ($2::DATE IS NULL OR e.expense_date <= $2)
        ), 0) AS total_expenses`,
    [from || null, to || null]
  );

  const series = await query(
    `SELECT bucket, SUM(commission) AS commission, SUM(expenses) AS expenses
       FROM (
         SELECT date_trunc($3, o.delivered_at)::DATE AS bucket,
                os.subtotal * os.commission_rate / 100.0 AS commission, 0 AS expenses
           FROM order_suppliers os JOIN orders o ON o.id = os.order_id
          WHERE o.status IN ('delivered','closed')
            AND ($1::DATE IS NULL OR o.delivered_at::DATE >= $1)
            AND ($2::DATE IS NULL OR o.delivered_at::DATE <= $2)
         UNION ALL
         SELECT date_trunc($3, e.expense_date)::DATE AS bucket, 0 AS commission, e.amount AS expenses
           FROM expenses e
          WHERE ($1::DATE IS NULL OR e.expense_date >= $1)
            AND ($2::DATE IS NULL OR e.expense_date <= $2)
       ) x
      GROUP BY bucket
      ORDER BY bucket`,
    [from || null, to || null, groupBy]
  );

  const totalCommission = Number(totals.rows[0].total_commission);
  const totalExpenses = Number(totals.rows[0].total_expenses);

  res.json({
    totalCommission,
    totalExpenses,
    netProfit: totalCommission - totalExpenses,
    series: series.rows.map((r) => ({
      bucket: r.bucket,
      commission: Number(r.commission),
      expenses: Number(r.expenses),
      netProfit: Number(r.commission) - Number(r.expenses),
    })),
  });
}));
