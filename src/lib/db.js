import pg from "pg";

pg.types.setTypeParser(1700, (v) => (v === null ? null : parseFloat(v)));

export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

export function query(text, params) {
  return pool.query(text, params);
}

export async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
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
