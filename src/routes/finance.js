import { Router } from "express";
import { z } from "zod";
import { query, withTransaction, writeAudit } from "../lib/db.js";
import { ApiError, asyncRoute, nextDocNumber, resolveTreasuryCode } from "../lib/helpers.js";
import { authenticate, requirePermission } from "../middleware/auth.js";
import { queueNotification } from "../lib/notify.js";

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

    await writeAudit(client, {
      actorType: "employee", actorId: req.actor.id, actorName: req.actor.name,
      action: "voucher.issued", entityType: "voucher", entityId: voucher.id,
      entityLabel: number, after: voucher, ip: req.ip,
    });
    return voucher;
  });

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

    if (v.party_type === "customer" && v.party_id) {
      await queueNotification(client, {
        templateCode: "transfer.decision", recipientType: "customer",
        recipientId: v.party_id, orderId: v.order_id,
        vars: { decision: approve ? "اعتماد" : "رفض", order_number: v.voucher_number },
      });
    }
    return updated;
  });

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
  const result = await withTransaction(async (client) => {
    const { rows: pending } = await client.query(
      `SELECT id, order_number, cod_amount FROM orders
        WHERE driver_id = $1 AND cod_collected AND NOT cod_settled FOR UPDATE`,
      [req.params.id]
    );
    if (!pending.length) throw new ApiError(400, "لا توجد مبالغ معلّقة لهذا المندوب");

    const total = pending.reduce((s, o) => s + Number(o.cod_amount), 0);
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
      [vNumber, req.params.id, drv[0]?.name ?? "مندوب", total, tr[0].id, req.actor.id,
       `تسليم نقدية من مندوب التوصيل`]
    );

    const { rows: [settlement] } = await client.query(
      `INSERT INTO driver_settlements (driver_id, total_amount, voucher_id, settled_by)
       VALUES ($1,$2,$3,$4) RETURNING *`,
      [req.params.id, total, voucher.id, req.actor.id]
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

    return { settlement, voucher, ordersCount: pending.length, total };
  });

  res.json(result);
}));

financeRouter.get("/drivers/cash", requirePermission("reports.view"), asyncRoute(async (_req, res) => {
  const { rows } = await query(`SELECT * FROM v_driver_cash ORDER BY cash_in_hand DESC`);
  res.json(rows);
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
    `SELECT * FROM v_customer_ledger WHERE customer_id = $1 ORDER BY entry_date`,
    [req.params.id]
  );
  let balance = 0;
  res.json(rows.map((r) => {
    balance += Number(r.debit) - Number(r.credit);
    return { ...r, balance };
  }));
}));

financeRouter.get("/ledger/supplier/:id", asyncRoute(async (req, res) => {
  if (req.actor.type === "supplier" && req.actor.id !== req.params.id) {
    throw new ApiError(403, "لا تملك صلاحية الاطلاع على هذا الكشف");
  }
  const { rows } = await query(
    `SELECT * FROM v_supplier_ledger WHERE supplier_id = $1 ORDER BY entry_date`,
    [req.params.id]
  );
  let balance = 0;
  res.json(rows.map((r) => {
    balance += Number(r.credit) - Number(r.debit);
    return { ...r, balance };
  }));
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
