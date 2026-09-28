import { query } from "./db.js";

function render(template, vars = {}) {
  return template.replace(/\{(\w+)\}/g, (_, key) => vars[key] ?? `{${key}}`);
}

export async function queueNotification(client, {
  templateCode, recipientType, recipientId, orderId = null, sectionId = null, vars = {},
}) {
  const { rows } = await client.query(
    `SELECT title, body_template, send_whatsapp FROM notification_templates WHERE code = $1`,
    [templateCode]
  );
  if (!rows.length) return;
  const tpl = rows[0];

  await client.query(
    `INSERT INTO notifications
       (template_code, recipient_type, recipient_id, title, body,
        order_id, section_id, whatsapp_status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [templateCode, recipientType, recipientId, tpl.title,
     render(tpl.body_template, vars), orderId, sectionId,
     tpl.send_whatsapp ? "queued" : null]
  );
}

export async function notifySectionArrival(client, { sectionId, sectionName }) {
  const { rows } = await client.query(
    `SELECT customer_id FROM customer_sections cs
       JOIN customers c ON c.id = cs.customer_id
      WHERE cs.section_id = $1 AND cs.enabled AND c.status = 'approved'`,
    [sectionId]
  );

  for (const r of rows) {
    await queueNotification(client, {
      templateCode: "stock.new_arrival",
      recipientType: "customer",
      recipientId: r.customer_id,
      sectionId,
      vars: { section: sectionName },
    });
  }
  return rows.length;
}

// إشعار "رجوع التوفر" — يُستخدم بس لما صنف كانت كميته صفر ورجعت موجبة، وبس
// للعملاء اللي عندهم هذا الصنف بالذات في المفضلة (مش لكل عملاء القسم)
export async function notifyFavoriteRestock(client, { productId, productName }) {
  const { rows } = await client.query(
    `SELECT cf.customer_id FROM customer_favorites cf
       JOIN customers c ON c.id = cf.customer_id
      WHERE cf.product_id = $1 AND c.status = 'approved'`,
    [productId]
  );

  for (const r of rows) {
    await queueNotification(client, {
      templateCode: "product.restocked",
      recipientType: "customer",
      recipientId: r.customer_id,
      vars: { product_name: productName },
    });
  }
  return rows.length;
}

export async function runCreditDueReminders() {
  const { rows } = await query(
    `SELECT o.id, o.order_number, o.customer_id, o.deferred_due_date,
            (o.grand_total - o.paid_amount) AS remaining
       FROM orders o
      WHERE o.payment_method = 'deferred'
        AND o.status NOT IN ('cancelled','closed')
        AND o.grand_total > o.paid_amount
        AND o.deferred_due_date BETWEEN CURRENT_DATE AND CURRENT_DATE + 3`
  );

  const client = await (await import("./db.js")).pool.connect();
  try {
    for (const o of rows) {
      await queueNotification(client, {
        templateCode: "credit.due_soon",
        recipientType: "customer",
        recipientId: o.customer_id,
        orderId: o.id,
        vars: { amount: `${o.remaining} د.ل`, due_date: o.deferred_due_date },
      });
    }
  } finally {
    client.release();
  }
  return rows.length;
}

// ينظّف رقم الهاتف الليبي لنفس الصيغة اللي يفهمها سيرفس واتساب (مطابق للمنطق في auth.js)
function normalizePhoneForWhatsapp(rawPhone) {
  let p = String(rawPhone).replace(/\D/g, "");
  if (p.startsWith("00")) p = p.slice(2);
  if (p.startsWith("0")) p = "218" + p.slice(1);
  if (!p.startsWith("218")) p = "218" + p;
  return p;
}

async function sendWhatsapp(phone, message) {
  if (!process.env.WHATSAPP_SERVICE_URL || !process.env.WHATSAPP_SECRET_KEY) {
    throw new Error("متغيرات سيرفس واتساب غير مضبوطة");
  }
  const res = await fetch(`${process.env.WHATSAPP_SERVICE_URL}/send`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-secret-key": process.env.WHATSAPP_SECRET_KEY },
    body: JSON.stringify({ phone: normalizePhoneForWhatsapp(phone), message }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `فشل الإرسال (${res.status})`);
}

export async function dispatchWhatsappQueue() {
  const { rows } = await query(
    `SELECT n.id, n.body, n.recipient_type, n.recipient_id
       FROM notifications n
      WHERE n.whatsapp_status = 'queued'
      ORDER BY n.created_at
      LIMIT 50`
  );

  for (const n of rows) {
    try {
      const table = n.recipient_type === "customer" ? "customers"
                  : n.recipient_type === "supplier" ? "suppliers" : "employees";
      const { rows: p } = await query(`SELECT phone FROM ${table} WHERE id = $1`, [n.recipient_id]);
      if (!p.length) throw new Error("رقم المستلم غير موجود");

      await sendWhatsapp(p[0].phone, n.body);

      await query(
        `UPDATE notifications SET whatsapp_status = 'sent', whatsapp_sent_at = now() WHERE id = $1`,
        [n.id]
      );
    } catch (err) {
      await query(
        `UPDATE notifications SET whatsapp_status = 'failed', whatsapp_error = $2 WHERE id = $1`,
        [n.id, err.message]
      );
    }
  }
  return rows.length;
}

// رسالة مباشرة لرقم المدير المسؤول (WHATSAPP_MANAGER_PHONE) — مالهاش علاقة بجدول
// الإشعارات، تُستخدم لإشعارات الإدارة الداخلية (إيصالات، تقرير يومي)
export async function notifyManager(message) {
  if (!process.env.WHATSAPP_MANAGER_PHONE) return;
  try {
    await sendWhatsapp(process.env.WHATSAPP_MANAGER_PHONE, message);
  } catch (err) {
    console.error("[إشعار المدير]", err.message);
  }
}

// أرقام مستلمي التقرير اليومي: المدير (من متغير البيئة) + الشريك (رقمه ثابت بالطلب)،
// نتفادى التكرار لو صار نفس الرقم في الاثنين
const DAILY_REPORT_PHONES = [...new Set([
  process.env.WHATSAPP_MANAGER_PHONE,
  "0910911991", // شريك الشركة
].filter(Boolean))];

async function notifyReportRecipients(message) {
  for (const phone of DAILY_REPORT_PHONES) {
    try {
      await sendWhatsapp(phone, message);
    } catch (err) {
      console.error("[تقرير يومي]", phone, err.message);
    }
  }
}

// تقرير أرباح شامل لليوم الحالي: المبيعات والفواتير، التحصيل من العملاء، الديون
// المستحقة على العملاء (تراكمي)، حركة خزينة الحوالات، المصروفات، وصافي الربح.
// يُبعث للمدير وللشريك سوية.
export async function sendDailyProfitReport() {
  const { rows } = await query(
    `SELECT
        COALESCE((
          SELECT COUNT(*) FROM orders o
           WHERE o.status NOT IN ('draft','under_review','cancelled','postponed')
             AND o.created_at::DATE = CURRENT_DATE
        ), 0) AS invoices_count,
        COALESCE((
          SELECT SUM(o.grand_total) FROM orders o
           WHERE o.status NOT IN ('draft','under_review','cancelled','postponed')
             AND o.created_at::DATE = CURRENT_DATE
        ), 0) AS sales_total,
        COALESCE((
          SELECT SUM(o.cod_amount) FROM orders o
           WHERE o.cod_collected AND o.delivered_at::DATE = CURRENT_DATE
        ), 0) AS collected_cod,
        COALESCE((
          SELECT SUM(v.amount) FROM vouchers v
           WHERE v.party_type = 'customer' AND v.voucher_type = 'receipt'
             AND v.approval_status = 'approved' AND v.created_at::DATE = CURRENT_DATE
        ), 0) AS collected_receipts,
        COALESCE((
          SELECT SUM(bal.balance) FROM (
            SELECT c.id,
                   COALESCE(SUM(x.debit),0) - COALESCE(SUM(x.credit),0) AS balance
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
             GROUP BY c.id
          ) bal WHERE bal.balance > 0
        ), 0) AS total_customer_debt,
        COALESCE((
          SELECT SUM(bal.balance) FROM (
            SELECT supplier_id, SUM(credit) - SUM(debit) AS balance
              FROM v_supplier_ledger
             GROUP BY supplier_id
          ) bal WHERE bal.balance > 0
        ), 0) AS total_supplier_debt,
        COALESCE((
          SELECT SUM(v.amount) FROM vouchers v JOIN treasuries t ON t.id = v.treasury_id
           WHERE t.code = 'hawala' AND v.voucher_type = 'receipt'
             AND v.approval_status = 'approved' AND v.created_at::DATE = CURRENT_DATE
        ), 0) AS hawala_in,
        COALESCE((
          SELECT SUM(v.amount) FROM vouchers v JOIN treasuries t ON t.id = v.treasury_id
           WHERE t.code = 'hawala' AND v.voucher_type = 'payment'
             AND v.approval_status = 'approved' AND v.created_at::DATE = CURRENT_DATE
        ), 0) AS hawala_out,
        COALESCE((
          SELECT SUM(os.subtotal * os.commission_rate / 100.0)
            FROM order_suppliers os JOIN orders o ON o.id = os.order_id
           WHERE o.status IN ('delivered','closed') AND o.delivered_at::DATE = CURRENT_DATE
        ), 0) AS commission,
        COALESCE((SELECT SUM(amount) FROM expenses WHERE expense_date = CURRENT_DATE), 0) AS expenses`
  );

  const r = rows[0];
  const invoicesCount = Number(r.invoices_count);
  const salesTotal = Number(r.sales_total);
  const collectedToday = Number(r.collected_cod) + Number(r.collected_receipts);
  const totalCustomerDebt = Number(r.total_customer_debt);
  const totalSupplierDebt = Number(r.total_supplier_debt);
  const hawalaIn = Number(r.hawala_in);
  const hawalaOut = Number(r.hawala_out);
  const commission = Number(r.commission);
  const expenses = Number(r.expenses);
  const dateLabel = new Date().toLocaleDateString("ar-LY", { day: "numeric", month: "long", year: "numeric" });

  await notifyReportRecipients(
    `تقرير جملة الشامل — ${dateLabel}\n\n` +
    `الفواتير:\n` +
    `عدد الفواتير اليوم: ${invoicesCount}\n` +
    `إجمالي المبيعات اليوم: ${salesTotal.toFixed(2)} د.ل\n\n` +
    `التحصيل:\n` +
    `تحصيل اليوم من العملاء: ${collectedToday.toFixed(2)} د.ل\n\n` +
    `الديون:\n` +
    `مستحق لنا على العملاء: ${totalCustomerDebt.toFixed(2)} د.ل\n` +
    `مستحق علينا للموردين: ${totalSupplierDebt.toFixed(2)} د.ل\n\n` +
    `الحوالات اليوم:\n` +
    `واردة: ${hawalaIn.toFixed(2)} د.ل\n` +
    `صادرة: ${hawalaOut.toFixed(2)} د.ل\n\n` +
    `المصروفات اليوم: ${expenses.toFixed(2)} د.ل\n\n` +
    `الأرباح:\n` +
    `عمولة محصّلة اليوم: ${commission.toFixed(2)} د.ل\n` +
    `صافي الربح اليوم: ${(commission - expenses).toFixed(2)} د.ل`
  );
}

// يشغّل تقرير اليوم مرة واحدة فقط قريب من نهاية اليوم بتوقيت ليبيا (UTC+2)
let lastDailyReportSentOn = null;
export async function maybeSendDailyProfitReport() {
  const now = new Date();
  const libyaHour = (now.getUTCHours() + 2) % 24;
  const todayKey = now.toISOString().slice(0, 10);
  if (libyaHour === 23 && now.getUTCMinutes() >= 50 && lastDailyReportSentOn !== todayKey) {
    lastDailyReportSentOn = todayKey;
    await sendDailyProfitReport();
  }
}

// تقرير أرباح شامل لكامل الشهر الحالي (من أول يوم فيه لتاريخ اليوم) — نفس بنود
// التقرير اليومي بالضبط بس مجمّعة على الشهر، يُبعث للمدير وللشريك سوية
export async function sendMonthlyProfitReport() {
  const now = new Date();
  const libyaNow = new Date(now.getTime() + 2 * 60 * 60 * 1000);
  const year = libyaNow.getUTCFullYear();
  const month = libyaNow.getUTCMonth(); // 0-indexed
  const from = `${year}-${String(month + 1).padStart(2, "0")}-01`;
  const to = new Date(Date.UTC(year, month + 1, 0)).toISOString().slice(0, 10);

  const { rows } = await query(
    `SELECT
        COALESCE((
          SELECT COUNT(*) FROM orders o
           WHERE o.status NOT IN ('draft','under_review','cancelled','postponed')
             AND o.created_at::DATE BETWEEN $1 AND $2
        ), 0) AS invoices_count,
        COALESCE((
          SELECT SUM(o.grand_total) FROM orders o
           WHERE o.status NOT IN ('draft','under_review','cancelled','postponed')
             AND o.created_at::DATE BETWEEN $1 AND $2
        ), 0) AS sales_total,
        COALESCE((
          SELECT SUM(o.cod_amount) FROM orders o
           WHERE o.cod_collected AND o.delivered_at::DATE BETWEEN $1 AND $2
        ), 0) AS collected_cod,
        COALESCE((
          SELECT SUM(v.amount) FROM vouchers v
           WHERE v.party_type = 'customer' AND v.voucher_type = 'receipt'
             AND v.approval_status = 'approved' AND v.created_at::DATE BETWEEN $1 AND $2
        ), 0) AS collected_receipts,
        COALESCE((
          SELECT SUM(bal.balance) FROM (
            SELECT c.id,
                   COALESCE(SUM(x.debit),0) - COALESCE(SUM(x.credit),0) AS balance
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
             GROUP BY c.id
          ) bal WHERE bal.balance > 0
        ), 0) AS total_customer_debt,
        COALESCE((
          SELECT SUM(bal.balance) FROM (
            SELECT supplier_id, SUM(credit) - SUM(debit) AS balance
              FROM v_supplier_ledger
             GROUP BY supplier_id
          ) bal WHERE bal.balance > 0
        ), 0) AS total_supplier_debt,
        COALESCE((
          SELECT SUM(v.amount) FROM vouchers v JOIN treasuries t ON t.id = v.treasury_id
           WHERE t.code = 'hawala' AND v.voucher_type = 'receipt'
             AND v.approval_status = 'approved' AND v.created_at::DATE BETWEEN $1 AND $2
        ), 0) AS hawala_in,
        COALESCE((
          SELECT SUM(v.amount) FROM vouchers v JOIN treasuries t ON t.id = v.treasury_id
           WHERE t.code = 'hawala' AND v.voucher_type = 'payment'
             AND v.approval_status = 'approved' AND v.created_at::DATE BETWEEN $1 AND $2
        ), 0) AS hawala_out,
        COALESCE((
          SELECT SUM(os.subtotal * os.commission_rate / 100.0)
            FROM order_suppliers os JOIN orders o ON o.id = os.order_id
           WHERE o.status IN ('delivered','closed') AND o.delivered_at::DATE BETWEEN $1 AND $2
        ), 0) AS commission,
        COALESCE((
          SELECT SUM(amount) FROM expenses WHERE expense_date BETWEEN $1 AND $2
        ), 0) AS expenses`,
    [from, to]
  );

  const r = rows[0];
  const invoicesCount = Number(r.invoices_count);
  const salesTotal = Number(r.sales_total);
  const collectedMonth = Number(r.collected_cod) + Number(r.collected_receipts);
  const totalCustomerDebt = Number(r.total_customer_debt);
  const totalSupplierDebt = Number(r.total_supplier_debt);
  const hawalaIn = Number(r.hawala_in);
  const hawalaOut = Number(r.hawala_out);
  const commission = Number(r.commission);
  const expenses = Number(r.expenses);
  const monthLabel = libyaNow.toLocaleDateString("ar-LY", { month: "long", year: "numeric" });

  await notifyReportRecipients(
    `تقرير جملة الشهري — ${monthLabel}\n\n` +
    `الفواتير:\n` +
    `عدد الفواتير خلال الشهر: ${invoicesCount}\n` +
    `إجمالي المبيعات خلال الشهر: ${salesTotal.toFixed(2)} د.ل\n\n` +
    `التحصيل:\n` +
    `تحصيل الشهر من العملاء: ${collectedMonth.toFixed(2)} د.ل\n\n` +
    `الديون (لتاريخه):\n` +
    `مستحق لنا على العملاء: ${totalCustomerDebt.toFixed(2)} د.ل\n` +
    `مستحق علينا للموردين: ${totalSupplierDebt.toFixed(2)} د.ل\n\n` +
    `الحوالات خلال الشهر:\n` +
    `واردة: ${hawalaIn.toFixed(2)} د.ل\n` +
    `صادرة: ${hawalaOut.toFixed(2)} د.ل\n\n` +
    `المصروفات خلال الشهر: ${expenses.toFixed(2)} د.ل\n\n` +
    `الأرباح:\n` +
    `عمولة محصّلة خلال الشهر: ${commission.toFixed(2)} د.ل\n` +
    `صافي الربح خلال الشهر: ${(commission - expenses).toFixed(2)} د.ل`
  );
}

// يشغّل التقرير الشهري مرة وحدة بس في آخر يوم بالشهر (بتوقيت ليبيا)، شوية بعد
// وقت التقرير اليومي عشان توصل كرسالتين منفصلتين مرتبتين
let lastMonthlyReportSentOn = null;
export async function maybeSendMonthlyProfitReport() {
  const now = new Date();
  const libyaHour = (now.getUTCHours() + 2) % 24;
  const libyaNow = new Date(now.getTime() + 2 * 60 * 60 * 1000);
  const libyaTomorrow = new Date(libyaNow.getTime() + 24 * 60 * 60 * 1000);
  const isLastDayOfMonth = libyaTomorrow.getUTCMonth() !== libyaNow.getUTCMonth();
  const monthKey = `${libyaNow.getUTCFullYear()}-${libyaNow.getUTCMonth()}`;

  if (isLastDayOfMonth && libyaHour === 23 && now.getUTCMinutes() >= 55 && lastMonthlyReportSentOn !== monthKey) {
    lastMonthlyReportSentOn = monthKey;
    await sendMonthlyProfitReport();
  }
}

// إشعار كل الموظفين الفعّالين اللي عندهم صلاحية معيّنة (مثلاً مراجعة الطلبيات، اعتماد الحسابات) —
// يُستخدم لتنبيه لوحة الإدارة بأحداث جديدة (طلبية جديدة، تسجيل حساب جديد) بدل ما تفضل فارغة
export async function notifyStaffWithPermission(client, {
  permissionCode, templateCode, orderId = null, sectionId = null, vars = {},
}) {
  const { rows } = await client.query(
    `SELECT DISTINCT e.id
       FROM employees e
       JOIN role_permissions rp ON rp.role_id = e.role_id
       JOIN permissions p       ON p.id = rp.permission_id AND p.code = $1
      WHERE e.is_active`,
    [permissionCode]
  );
  for (const row of rows) {
    await queueNotification(client, {
      templateCode, recipientType: "employee", recipientId: row.id,
      orderId, sectionId, vars,
    });
  }
}
