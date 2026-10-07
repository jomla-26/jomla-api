import { query } from "./db.js";

function render(template, vars = {}) {
  return template.replace(/\{(\w+)\}/g, (_, key) => vars[key] ?? `{${key}}`);
}

export async function queueNotification(client, {
  templateCode, recipientType, recipientId, orderId = null, sectionId = null, vars = {}, whatsapp = true,
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
     null /* الواتساب ملغي: إشعارات داخل التطبيق فقط */]
  );
}

// إشعار داخل التطبيق فقط (بدون واتساب أبدًا: whatsapp_status = NULL). يُستخدم لتنبيهات
// الإدارة الداخلية اللي قرار المؤسس إنها ما تنبعتش واتساب (مثل فرق تسوية مندوب).
export async function createInAppNotification(client, {
  recipientType, recipientId, title, body, orderId = null,
}) {
  await client.query(
    `INSERT INTO notifications
       (template_code, recipient_type, recipient_id, title, body, order_id, whatsapp_status)
     VALUES (NULL,$1,$2,$3,$4,$5,NULL)`,
    [recipientType, recipientId, title, body, orderId]
  );
}

// يرسل إشعار داخل التطبيق (بدون واتساب) لكل موظف فعّال عنده صلاحية معيّنة
export async function notifyStaffInApp(client, { permissionCode, title, body, orderId = null }) {
  const { rows } = await client.query(
    `SELECT DISTINCT e.id
       FROM employees e
       JOIN role_permissions rp ON rp.role_id = e.role_id
       JOIN permissions p       ON p.id = rp.permission_id AND p.code = $1
      WHERE e.is_active`,
    [permissionCode]
  );
  for (const row of rows) {
    await createInAppNotification(client, {
      recipientType: "employee", recipientId: row.id, title, body, orderId,
    });
  }
  return rows.length;
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
  // لا نكرّر نفس التذكير لنفس الطلبية خلال 20 ساعة (الدالة تشتغل كل 6 ساعات)
  const { rows } = await query(
    `SELECT o.id, o.order_number, o.customer_id, o.deferred_due_date,
            (o.grand_total - o.paid_amount) AS remaining
       FROM orders o
      WHERE o.payment_method = 'deferred'
        AND o.status NOT IN ('cancelled','closed')
        AND o.grand_total > o.paid_amount
        AND o.deferred_due_date BETWEEN CURRENT_DATE AND CURRENT_DATE + 3
        AND NOT EXISTS (
          SELECT 1 FROM notifications n
           WHERE n.template_code = 'credit.due_soon' AND n.order_id = o.id
             AND n.created_at > now() - interval '20 hours'
        )`
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
    signal: AbortSignal.timeout(20_000), // ما نعلّقش الدورة لو سيرفس واتساب ما ردّش
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `فشل الإرسال (${res.status})`);
}

// ---------------------------------------------------------------------------
// طابور واتساب العام (notifications.whatsapp_status)
//   queued -> sending -> sent
//                    \-> queued (إعادة محاولة بتأخير تصاعدي) -> ... -> dead بعد 3 محاولات
// الحجز بـ FOR UPDATE SKIP LOCKED: دورتان/نسختان من السيرفر ما يبعثوش نفس الرسالة مرتين.
// صف عالق في 'sending' أكتر من 10 دقايق (السيرفر وقع أثناء الإرسال) ينعاد حجزه.
// ملاحظة: التسليم "مرة على الأقل" — لو وقع السيرفر بعد الإرسال وقبل التعليم ممكن تتكرر رسالة نادرًا.
// ---------------------------------------------------------------------------
const WA_MAX_ATTEMPTS = 3;
const WA_BACKOFF_MINUTES = [1, 5, 15];

export async function dispatchWhatsappQueue() {
  const { rows } = await query(
    `UPDATE notifications SET
            whatsapp_status = 'sending',
            whatsapp_claimed_at = now(),
            whatsapp_attempts = COALESCE(whatsapp_attempts, 0) + 1
      WHERE id IN (
        SELECT id FROM notifications
         WHERE (whatsapp_status = 'queued'
                AND (whatsapp_next_attempt_at IS NULL OR whatsapp_next_attempt_at <= now()))
            OR (whatsapp_status = 'sending' AND whatsapp_claimed_at < now() - interval '10 minutes')
         ORDER BY created_at
         LIMIT 50
         FOR UPDATE SKIP LOCKED
      )
      RETURNING id, body, recipient_type, recipient_id, whatsapp_attempts`
  );

  for (const n of rows) {
    try {
      const table = n.recipient_type === "customer" ? "customers"
                  : n.recipient_type === "supplier" ? "suppliers" : "employees";
      const { rows: p } = await query(`SELECT phone FROM ${table} WHERE id = $1`, [n.recipient_id]);
      if (!p.length || !p[0].phone) {
        // خطأ دائم: مافيش رقم نبعتله، ما فيش فايدة من إعادة المحاولة
        await query(
          `UPDATE notifications SET whatsapp_status = 'dead', whatsapp_error = $2 WHERE id = $1`,
          [n.id, "رقم المستلم غير موجود"]
        );
        continue;
      }

      await sendWhatsapp(p[0].phone, n.body);

      await query(
        `UPDATE notifications SET whatsapp_status = 'sent', whatsapp_sent_at = now(), whatsapp_error = NULL
          WHERE id = $1`,
        [n.id]
      );
    } catch (err) {
      const attempts = Number(n.whatsapp_attempts) || 1;
      if (attempts >= WA_MAX_ATTEMPTS) {
        await query(
          `UPDATE notifications SET whatsapp_status = 'dead', whatsapp_error = $2 WHERE id = $1`,
          [n.id, err.message]
        );
      } else {
        const delay = WA_BACKOFF_MINUTES[Math.min(attempts - 1, WA_BACKOFF_MINUTES.length - 1)];
        await query(
          `UPDATE notifications SET whatsapp_status = 'queued', whatsapp_error = $2,
                  whatsapp_next_attempt_at = now() + ($3 || ' minutes')::interval
            WHERE id = $1`,
          [n.id, err.message, String(delay)]
        );
      }
    }
  }
  return rows.length;
}

// ---------------------------------------------------------------------------
// أرقام الإدارة: من متغيرات البيئة، والأرقام القديمة كقيم افتراضية
//   WHATSAPP_MANAGER_PHONE  (المدير)   — افتراضي 0913363363
//   WHATSAPP_PARTNER_PHONE  (الشريك)   — افتراضي 0910911991
// قرار المؤسس: واتساب للمدير/الشريك مسموح للإيصالات والتقارير اليومية/الشهرية فقط.
// ---------------------------------------------------------------------------
const managerPhone = () => process.env.WHATSAPP_MANAGER_PHONE || "0913363363";
const partnerPhone = () => process.env.WHATSAPP_PARTNER_PHONE || "0910911991";

// الإدارة العليا (المدير العام وشريكه): الموظفون ذوو الجلسة المفتوحة، أو اللي رقمهم هو رقم المدير/الشريك.
// قرار المؤسس (واتساب انحظر): التقارير والإيصالات توصل داخل التطبيق كإشعارات (+ إشعار الجهاز Push) بدل واتساب.
async function managementRecipientIds() {
  const { rows } = await query(
    `SELECT id FROM employees WHERE is_active AND (long_session OR phone = ANY($1::TEXT[]))`,
    [[managerPhone(), partnerPhone()].filter(Boolean)]
  );
  return rows.map((r) => r.id);
}

// يرسل إشعارًا داخل التطبيق لكل الإدارة العليا. السطر الأول من النص = العنوان، والباقي = المحتوى.
// يرجّع عدد المستلمين.
export async function notifyManagementInApp(message) {
  const [title, ...rest] = String(message).split("\n");
  const body = rest.join("\n").trim() || title;
  const ids = await managementRecipientIds();
  for (const id of ids) {
    await createInAppNotification({ query: (...a) => query(...a) }, {
      recipientType: "employee", recipientId: id, title: title.slice(0, 150), body,
    });
  }
  return ids.length;
}

// (مُبقى للتوافق مع routes/agent.js)
export async function notifyManager(message) {
  try { await notifyManagementInApp(message); }
  catch (err) { console.error("[إشعار المدير]", err.message); }
}

// يرجّع عدد المستلمين اللي وصلهم التقرير فعلًا
async function notifyReportRecipients(message) {
  try { return await notifyManagementInApp(message); }
  catch (err) { console.error("[تقرير]", err.message); return 0; }
}

// ---------------------------------------------------------------------------
// حالة التطبيق المحفوظة (تبقى بعد إعادة التشغيل): جدول app_state(key, value)
// claimOnce: حجز ذرّي لمفتاح — أول من ينجح يرسل، والباقي يتخطّى.
// حجز عالق ('sending:<وقت>') أقدم من 10 دقايق يُستعاد.
// ---------------------------------------------------------------------------
async function claimOnce(key) {
  const now = Date.now();
  const { rows } = await query(
    `INSERT INTO app_state (key, value) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
        WHERE app_state.value LIKE 'sending:%'
          AND NULLIF(split_part(app_state.value, ':', 2), '')::BIGINT < $3
     RETURNING key`,
    [key, `sending:${now}`, now - 10 * 60 * 1000]
  );
  return rows.length > 0;
}
const markSent = (key) =>
  query(`UPDATE app_state SET value = $2 WHERE key = $1`, [key, `sent:${new Date().toISOString()}`]);
const releaseClaim = (key) =>
  query(`DELETE FROM app_state WHERE key = $1 AND value LIKE 'sending:%'`, [key]);

// الوقت الحالي بتوقيت ليبيا (Africa/Tripoli) محسوب في قاعدة البيانات
async function libyaClock() {
  const { rows: [c] } = await query(
    `SELECT to_char(t, 'YYYY-MM-DD') AS today,
            EXTRACT(HOUR FROM t)::int AS hour,
            EXTRACT(MINUTE FROM t)::int AS minute,
            EXTRACT(DAY FROM t)::int AS dom,
            to_char(t::date - 1, 'YYYY-MM-DD') AS yesterday,
            to_char(date_trunc('month', t)::date, 'YYYY-MM-DD') AS month_start,
            to_char((date_trunc('month', t) + interval '1 month - 1 day')::date, 'YYYY-MM-DD') AS month_end,
            to_char((date_trunc('month', t) - interval '1 month')::date, 'YYYY-MM-DD') AS prev_month_start,
            to_char((date_trunc('month', t) - interval '1 day')::date, 'YYYY-MM-DD') AS prev_month_end
       FROM (SELECT now() AT TIME ZONE 'Africa/Tripoli' AS t) x`
  );
  return c;
}

const LY = (col) => `((${col}) AT TIME ZONE 'Africa/Tripoli')::date`;

// أرقام التقرير لفترة [from, to] (تواريخ بتوقيت ليبيا):
//  - التحصيل = سندات القبض المعتمدة للعملاء (وفيها سندات COD النقدية اللي ينشئها orders.js وقت
//    التسليم برقم off_treasury) — فما نجمعش orders.cod_amount فوقها (كان تكرار). نضيف فقط
//    COD لطلبيات مسلّمة ما عندهاش سند قبض نقدي معتمد (بيانات قديمة) عشان ما ينقص التحصيل.
//  - ديون العملاء: نفس منطق كشف الحساب: سند دفع = مدين، سند قبض = دائن، مرتجع (credit_note/cash) = دائن.
//  - العمولة: من الأجزاء غير الملغاة فقط.
async function fetchReportFigures(from, to) {
  const { rows } = await query(
    `SELECT
        COALESCE((
          SELECT COUNT(*) FROM orders o
           WHERE o.status NOT IN ('draft','under_review','cancelled','postponed')
             AND ${LY("o.created_at")} BETWEEN $1::date AND $2::date
        ), 0) AS invoices_count,
        COALESCE((
          SELECT SUM(o.grand_total) FROM orders o
           WHERE o.status NOT IN ('draft','under_review','cancelled','postponed')
             AND ${LY("o.created_at")} BETWEEN $1::date AND $2::date
        ), 0) AS sales_total,
        COALESCE((
          SELECT SUM(o.cod_amount) FROM orders o
           WHERE o.cod_collected
             AND ${LY("o.delivered_at")} BETWEEN $1::date AND $2::date
             AND NOT EXISTS (
               SELECT 1 FROM vouchers v
                WHERE v.order_id = o.id AND v.party_type = 'customer' AND v.voucher_type = 'receipt'
                  AND v.method = 'cash' AND v.off_treasury AND v.approval_status = 'approved')
        ), 0) AS collected_cod_unvouchered,
        COALESCE((
          SELECT SUM(v.amount) FROM vouchers v
           WHERE v.party_type = 'customer' AND v.voucher_type = 'receipt'
             AND v.approval_status = 'approved'
             AND ${LY("v.created_at")} BETWEEN $1::date AND $2::date
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
             AND v.approval_status = 'approved'
             AND ${LY("v.created_at")} BETWEEN $1::date AND $2::date
        ), 0) AS hawala_in,
        COALESCE((
          SELECT SUM(v.amount) FROM vouchers v JOIN treasuries t ON t.id = v.treasury_id
           WHERE t.code = 'hawala' AND v.voucher_type = 'payment'
             AND v.approval_status = 'approved'
             AND ${LY("v.created_at")} BETWEEN $1::date AND $2::date
        ), 0) AS hawala_out,
        COALESCE((
          SELECT SUM(os.subtotal * os.commission_rate / 100.0)
            FROM order_suppliers os JOIN orders o ON o.id = os.order_id
           WHERE o.status IN ('delivered','closed') AND os.status <> 'cancelled'
             AND ${LY("o.delivered_at")} BETWEEN $1::date AND $2::date
        ), 0) AS commission,
        COALESCE((
          SELECT SUM(amount) FROM expenses WHERE expense_date BETWEEN $1::date AND $2::date
        ), 0) AS expenses`,
    [from, to]
  );
  const r = rows[0];
  return {
    invoicesCount: Number(r.invoices_count),
    salesTotal: Number(r.sales_total),
    collected: Number(r.collected_receipts) + Number(r.collected_cod_unvouchered),
    totalCustomerDebt: Number(r.total_customer_debt),
    totalSupplierDebt: Number(r.total_supplier_debt),
    hawalaIn: Number(r.hawala_in),
    hawalaOut: Number(r.hawala_out),
    commission: Number(r.commission),
    expenses: Number(r.expenses),
  };
}

const arDate = (isoDate, opts) =>
  new Date(`${isoDate}T12:00:00Z`).toLocaleDateString("ar-LY", { ...opts, timeZone: "UTC" });

// تقرير أرباح شامل ليوم محدد (افتراضيًا اليوم بتوقيت ليبيا): المبيعات والفواتير، التحصيل،
// الديون المستحقة (تراكمي)، حركة خزينة الحوالات، المصروفات، وصافي الربح.
// يُبعث للمدير وللشريك سوية. يرجّع عدد الأرقام اللي وصلتها الرسالة.
export async function sendDailyProfitReport(forDate = null) {
  const day = forDate || (await libyaClock()).today;
  const f = await fetchReportFigures(day, day);
  const dateLabel = arDate(day, { day: "numeric", month: "long", year: "numeric" });

  return notifyReportRecipients(
    `تقرير جملة الشامل — ${dateLabel}\n\n` +
    `الفواتير:\n` +
    `عدد الفواتير اليوم: ${f.invoicesCount}\n` +
    `إجمالي المبيعات اليوم: ${f.salesTotal.toFixed(2)} د.ل\n\n` +
    `التحصيل:\n` +
    `تحصيل اليوم من العملاء: ${f.collected.toFixed(2)} د.ل\n\n` +
    `الديون:\n` +
    `مستحق لنا على العملاء: ${f.totalCustomerDebt.toFixed(2)} د.ل\n` +
    `مستحق علينا للموردين: ${f.totalSupplierDebt.toFixed(2)} د.ل\n\n` +
    `الحوالات اليوم:\n` +
    `واردة: ${f.hawalaIn.toFixed(2)} د.ل\n` +
    `صادرة: ${f.hawalaOut.toFixed(2)} د.ل\n\n` +
    `المصروفات اليوم: ${f.expenses.toFixed(2)} د.ل\n\n` +
    `الأرباح:\n` +
    `عمولة محصّلة اليوم: ${f.commission.toFixed(2)} د.ل\n` +
    `صافي الربح اليوم: ${(f.commission - f.expenses).toFixed(2)} د.ل`
  );
}

// التقرير اليومي: نافذة 23:30–23:59 بتوقيت ليبيا لنفس اليوم، + تعويض بين 00:00 و04:00 لتقرير
// أمس لو ما انبعتش (السيرفر كان واقف). علامة الإرسال محفوظة في app_state فتبقى بعد إعادة التشغيل
// ولا تتكرر، ولا تعتمد على تكّة واحدة بعينها.
export async function maybeSendDailyProfitReport() {
  const c = await libyaClock();
  let target = null;
  if (c.hour === 23 && c.minute >= 30) target = c.today;
  else if (c.hour < 4) target = c.yesterday;
  if (!target) return;

  const key = `report:daily:${target}`;
  if (!(await claimOnce(key))) return;
  try {
    const sent = await sendDailyProfitReport(target);
    if (sent > 0) await markSent(key); else await releaseClaim(key); // واتساب مقطوع: نعيد المحاولة بالتكّة الجاية
  } catch (err) {
    await releaseClaim(key).catch(() => {});
    throw err;
  }
}

// تقرير شهري: نفس بنود اليومي مجمّعة على شهر كامل (افتراضيًا الشهر الحالي لتاريخ اليوم).
// الاستدعاء بدون وسائط يحافظ على السلوك القديم.
export async function sendMonthlyProfitReport(range = null) {
  const c = range ? null : await libyaClock();
  const from = range?.from ?? c.month_start;
  const to = range?.to ?? c.month_end;
  const f = await fetchReportFigures(from, to);
  const monthLabel = arDate(from, { month: "long", year: "numeric" });

  return notifyReportRecipients(
    `تقرير جملة الشهري — ${monthLabel}\n\n` +
    `الفواتير:\n` +
    `عدد الفواتير خلال الشهر: ${f.invoicesCount}\n` +
    `إجمالي المبيعات خلال الشهر: ${f.salesTotal.toFixed(2)} د.ل\n\n` +
    `التحصيل:\n` +
    `تحصيل الشهر من العملاء: ${f.collected.toFixed(2)} د.ل\n\n` +
    `الديون (لتاريخه):\n` +
    `مستحق لنا على العملاء: ${f.totalCustomerDebt.toFixed(2)} د.ل\n` +
    `مستحق علينا للموردين: ${f.totalSupplierDebt.toFixed(2)} د.ل\n\n` +
    `الحوالات خلال الشهر:\n` +
    `واردة: ${f.hawalaIn.toFixed(2)} د.ل\n` +
    `صادرة: ${f.hawalaOut.toFixed(2)} د.ل\n\n` +
    `المصروفات خلال الشهر: ${f.expenses.toFixed(2)} د.ل\n\n` +
    `الأرباح:\n` +
    `عمولة محصّلة خلال الشهر: ${f.commission.toFixed(2)} د.ل\n` +
    `صافي الربح خلال الشهر: ${(f.commission - f.expenses).toFixed(2)} د.ل`
  );
}

// التقرير الشهري: آخر يوم بالشهر (بتوقيت ليبيا) من 23:40، + تعويض في أول 3 أيام من الشهر
// الجديد للشهر السابق لو ما انبعتش. علامة الإرسال في app_state (مفتاح لكل شهر).
export async function maybeSendMonthlyProfitReport() {
  const c = await libyaClock();
  let target = null;
  if (c.today === c.month_end && c.hour === 23 && c.minute >= 40) {
    target = { from: c.month_start, to: c.month_end };
  } else if (c.dom <= 3) {
    target = { from: c.prev_month_start, to: c.prev_month_end };
  }
  if (!target) return;

  const key = `report:monthly:${target.from}`;
  if (!(await claimOnce(key))) return;
  try {
    const sent = await sendMonthlyProfitReport(target);
    if (sent > 0) await markSent(key); else await releaseClaim(key);
  } catch (err) {
    await releaseClaim(key).catch(() => {});
    throw err;
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

// ---------------------------------------------------------------------------
// تنبيهات السندات الجديدة المعتمدة (قبض/دفع) مهما كان مصدرها — للمدير وللشريك.
// كل مستلم له علامته: manager_notified / partner_notified، فلو فشل إرسال الشريك وحده
// يعاد له بس (ما يتكررش للمدير). الحجز بـ FOR UPDATE SKIP LOCKED عبر voucher_alert_claimed_at:
// نسختين من السيرفر ما يعالجوش نفس السند، والسند اللي فشل يعاد بعد دقيقتين.
// ---------------------------------------------------------------------------
export async function dispatchManagerVoucherAlerts() {
  const { rows: claimed } = await query(
    `UPDATE vouchers SET voucher_alert_claimed_at = now()
      WHERE id IN (
        SELECT id FROM vouchers
         WHERE approval_status = 'approved'
           AND NOT (manager_notified AND partner_notified)
           AND created_at > now() - interval '2 days'
           AND (voucher_alert_claimed_at IS NULL OR voucher_alert_claimed_at < now() - interval '2 minutes')
         ORDER BY created_at
         LIMIT 20
         FOR UPDATE SKIP LOCKED
      )
      RETURNING id`
  );
  if (!claimed.length) return 0;

  const { rows } = await query(
    `SELECT v.id, v.voucher_number, v.voucher_type, v.party_type, v.party_name, v.amount, v.method,
            v.off_treasury, v.note, v.manager_notified, v.partner_notified,
            t.name AS treasury_name, o.order_number
       FROM vouchers v
       JOIN treasuries t ON t.id = v.treasury_id
       LEFT JOIN orders o ON o.id = v.order_id
      WHERE v.id = ANY($1::uuid[])
      ORDER BY v.created_at`,
    [claimed.map((c) => c.id)]
  );

  const partyLabel = { customer: "عميل", supplier: "مورد", driver: "مندوب", employee: "موظف", other: "طرف آخر" };
  const methodLabel = { cash: "نقدًا", transfer: "حوالة", card: "بطاقة" };
  for (const v of rows) {
    const isReceipt = v.voucher_type === "receipt";
    const msg =
      `${isReceipt ? "📥 إيصال قبض" : "📤 إيصال دفع"} ${v.voucher_number}\n` +
      `${partyLabel[v.party_type] || ""}: ${v.party_name}\n` +
      `المبلغ: ${Number(v.amount).toFixed(2)} د.ل (${methodLabel[v.method] || v.method})\n` +
      (v.order_number ? `الطلبية: ${v.order_number}\n` : "") +
      (v.off_treasury ? "الحركة: نقدًا خارج الخزينة (مباشرة مع المندوب/المورد)" : `الخزينة: ${v.treasury_name}`) +
      (v.note ? `\nملاحظة: ${v.note}` : "");
    try {
      // إشعار داخل التطبيق (+Push) للمدير وشريكه؛ مرة واحدة لكل سند
      const n = await notifyManagementInApp(msg);
      if (n > 0) await query(`UPDATE vouchers SET manager_notified = TRUE, partner_notified = TRUE WHERE id = $1`, [v.id]);
    } catch (err) { console.error("[إيصال]", v.voucher_number, err.message); }
  }
  return rows.length;
}
