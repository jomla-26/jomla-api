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

      if (process.env.NODE_ENV !== "production") {
        console.log(`[WhatsApp] ${p[0].phone}: ${n.body}`);
      }

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
