import { Router } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { query } from "../lib/db.js";
import { asyncRoute } from "../lib/helpers.js";
import { authenticate, requireActorType, requirePermission } from "../middleware/auth.js";
import { ensureCartsAndSearchTables } from "../lib/bootstrap.js";

export const searchLogRouter = Router();
searchLogRouter.use(authenticate);

// توحيد النص العربي (همزات، ى/ي، ة/ه، تشكيل، مسافات) + حروف صغيرة
function norm(s) {
  return String(s ?? "")
    .toLowerCase()
    .replace(/[ً-ْـ]/g, "")
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/\s+/g, " ")
    .trim();
}

const ensure = () => ensureCartsAndSearchTables().catch((e) => console.error("[searchlog] ensure:", e?.message));

// حد خفيف لكل عميل: 30 تسجيل بالدقيقة، وعند التجاوز نرد ok بدون خطأ (لا نفشّل العميل أبدًا)
const logLimiter = rateLimit({
  windowMs: 60_000,
  max: 30,
  standardHeaders: false,
  legacyHeaders: false,
  keyGenerator: (req) => `sl:${req.actor?.id ?? "anon"}`,
  validate: false,
  handler: (_req, res) => res.json({ ok: true }),
});

searchLogRouter.post("/", requireActorType("customer"), logLimiter, async (req, res) => {
  try {
    const body = z.object({
      query: z.string(),
      resultsCount: z.number().int().min(0).max(1_000_000),
    }).parse(req.body);
    const raw = body.query.trim().replace(/\s+/g, " ");
    if (raw.length < 2 || raw.length > 100) return res.json({ ok: true });
    const normalized = norm(raw);
    if (normalized.length < 2) return res.json({ ok: true });
    await ensure();
    await query(
      `INSERT INTO search_logs (customer_id, query, normalized, results_count)
       SELECT $1::uuid, $2::text, $3::text, $4::int
        WHERE NOT EXISTS (
          SELECT 1 FROM search_logs
           WHERE customer_id = $1::uuid AND normalized = $3::text
             AND created_at > now() - interval '10 minutes')`,
      [req.actor.id, raw, normalized, body.resultsCount]
    );
  } catch (e) {
    console.error("[searchlog] POST:", e?.message || e);
  }
  res.json({ ok: true });
});

const adminQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(365).catch(30),
  onlyEmpty: z.enum(["0", "1"]).catch("0"),
  q: z.string().max(100).catch(""),
});

searchLogRouter.get("/admin", requirePermission("catalog.manage"), asyncRoute(async (req, res) => {
  const { days, onlyEmpty, q } = adminQuerySchema.parse({
    days: req.query.days ?? 30, onlyEmpty: req.query.onlyEmpty ?? "0", q: req.query.q ?? "",
  });
  await ensure();
  const qNorm = norm(q);
  const params = [days];
  let qFilter = "";
  if (qNorm) {
    // escape لـ LIKE
    params.push(`%${qNorm.replace(/[\\%_]/g, "\\$&")}%`);
    qFilter = `AND normalized LIKE $${params.length}`;
  }
  const baseCte = `
    WITH base AS (
      SELECT customer_id, query, normalized, results_count, created_at
        FROM search_logs
       WHERE created_at >= now() - ($1::int * interval '1 day') ${qFilter}
    ),
    latest AS (
      SELECT DISTINCT ON (normalized) normalized, query AS sample, results_count AS last_results
        FROM base ORDER BY normalized, created_at DESC
    ),
    agg AS (
      SELECT normalized,
             COUNT(*)::int AS searches,
             COUNT(DISTINCT customer_id)::int AS customers,
             COUNT(*) FILTER (WHERE results_count = 0)::int AS zero_results,
             MIN(created_at) AS first_at,
             MAX(created_at) AS last_at
        FROM base GROUP BY normalized
    ),
    joined AS (
      SELECT a.normalized, l.sample, a.searches, a.customers, a.zero_results,
             l.last_results, a.first_at, a.last_at
        FROM agg a JOIN latest l ON l.normalized = a.normalized
    )`;
  const empty = onlyEmpty === "1" ? "WHERE last_results = 0" : "";
  const { rows } = await query(
    `${baseCte}
     SELECT normalized, sample, searches, customers, zero_results AS "zeroResults",
            last_results AS "lastResults", first_at AS "firstAt", last_at AS "lastAt"
       FROM joined ${empty}
      ORDER BY searches DESC, last_at DESC
      LIMIT 300`,
    params
  );
  const { rows: [t] } = await query(
    `${baseCte}
     SELECT COALESCE(SUM(searches), 0)::int AS searches,
            COUNT(*)::int AS "distinctQueries",
            COUNT(*) FILTER (WHERE last_results = 0)::int AS "zeroResultQueries"
       FROM joined`,
    params
  );
  res.json({ rows, totals: t });
}));
