import pg from "pg";

pg.types.setTypeParser(1700, (v) => (v === null ? null : parseFloat(v)));

export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: Number(process.env.DB_POOL_MAX) || 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

// بدون هذا المستمع، أي خطأ على اتصال خامل (قطع مفاجئ من قاعدة البيانات) يوقف السيرفر كله
pool.on("error", (err) => {
  console.error("Unexpected idle DB client error:", err?.message);
});

export function query(text, params) {
  return pool.query(text, params);
}

export async function withTransaction(fn) {
  const client = await pool.connect();
  // لو فشل ROLLBACK (انقطع الاتصال مثلًا) الاتصال يعتبر تالف: نخفي خطأ الـROLLBACK
  // ونرمي الخطأ الأصلي للمستدعي، ونتلف الاتصال (destroy) بدل ما نرجّعه للمجمّع
  let broken = false;
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackErr) {
      broken = true;
      console.error("ROLLBACK failed:", rollbackErr?.message);
    }
    throw err;
  } finally {
    client.release(broken ? true : undefined);
  }
}

export async function writeAudit(client, {
  actorType, actorId, actorName, action,
  entityType, entityId, entityLabel,
  before = null, after = null, ip = null,
}) {
  await client.query(
    `INSERT INTO audit_log
       (actor_type, actor_id, actor_name, action, entity_type, entity_id,
        entity_label, before_data, after_data, ip_address)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [actorType, actorId, actorName, action, entityType, entityId,
     entityLabel, before, after, ip]
  );
}

// أي تعديل من المورد على ما يراه العميل (اسم/صورة/نوع — السعر لا) يُرجع الصنف المعتمد (أو المرفوض) لانتظار الموافقة.
// يكتب صف تدقيق مستقل (product.resubmitted) بحالة الموافقة قبل ← بعد ومن تسبّب فيها، ليظهر في سجل الصنف
// كـ «عاد إلى بانتظار الموافقة». يرجّع true لو تغيّرت الحالة فعلًا (الصنف المعلّق أصلًا لا يتغيّر).
export async function resubmitForApproval(client, productId, { actor, ip = null, reason = null } = {}) {
  const { rows: [p] } = await client.query(
    `SELECT id, name, approval_status, approval_note, approved_by, approved_at
       FROM products WHERE id = $1 FOR UPDATE`, [productId]
  );
  if (!p || !["approved", "rejected"].includes(p.approval_status)) return false;
  await client.query(
    `UPDATE products SET approval_status = 'pending', approval_note = NULL, approved_by = NULL, approved_at = NULL
      WHERE id = $1`, [productId]
  );
  await writeAudit(client, {
    actorType: actor?.type ?? null, actorId: actor?.id ?? null, actorName: actor?.name ?? null,
    action: "product.resubmitted", entityType: "product", entityId: productId, entityLabel: p.name,
    before: { approval_status: p.approval_status, approval_note: p.approval_note },
    after: { approval_status: "pending", approval_note: null, reason },
    ip,
  });
  return true;
}
