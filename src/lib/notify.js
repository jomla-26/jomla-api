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

// تقرير أرباح مختصر لليوم الحالي — عمولة جملة المحصّلة ناقص المصروفات، يُبعث للمدير
export async function sendDailyProfitReport() {
  const { rows } = await query(
    `SELECT
        COALESCE((
          SELECT SUM(os.subtotal * os.commission_rate / 100.0)
            FROM order_suppliers os JOIN orders o ON o.id = os.order_id
           WHERE o.status IN ('delivered','closed') AND o.delivered_at::DATE = CURRENT_DATE
        ), 0) AS commission,
        COALESCE((SELECT SUM(amount) FROM expenses WHERE expense_date = CURRENT_DATE), 0) AS expenses`
  );
  const commission = Number(rows[0].commission);
  const expenses = Number(rows[0].expenses);
  const dateLabel = new Date().toLocaleDateString("ar-LY", { day: "numeric", month: "long", year: "numeric" });

  await notifyManager(
    `تقرير أرباح جملة اليومي — ${dateLabel}\n` +
    `عمولة محصّلة: ${commission.toFixed(2)} د.ل\n` +
    `مصروفات: ${expenses.toFixed(2)} د.ل\n` +
    `صافي الربح: ${(commission - expenses).toFixed(2)} د.ل`
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
