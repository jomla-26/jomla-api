import "dotenv/config";
import express from "express";
import helmet from "helmet";
import cors from "cors";
import rateLimit from "express-rate-limit";
import { ZodError } from "zod";

import { pool } from "./lib/db.js";
import { ApiError } from "./lib/helpers.js";
import { authenticate } from "./middleware/auth.js";
import { authRouter } from "./routes/auth.js";
import { catalogRouter } from "./routes/catalog.js";
import { orderRouter } from "./routes/orders.js";
import { financeRouter } from "./routes/finance.js";
import { employeeRouter } from "./routes/employees.js";
import { accountsRouter } from "./routes/accounts.js";
import { deliveryRouter } from "./routes/delivery.js";
import { engagementRouter } from "./routes/engagement.js";
import { supportRouter } from "./routes/support.js";
import { assetsRouter } from "./routes/assets.js";
import { uploadRouter } from "./routes/uploads.js";
import { bannerRouter } from "./routes/banners.js";
import { agentRouter } from "./routes/agent.js";
import { cartRouter } from "./routes/carts.js";
import { searchLogRouter } from "./routes/searchlog.js";
import { runBootstrap } from "./lib/bootstrap.js";
import { ensureSchema, logServerError, systemRouter } from "./lib/system.js";
import { dispatchManagerVoucherAlerts, dispatchWhatsappQueue, runCreditDueReminders, maybeSendDailyProfitReport, maybeSendMonthlyProfitReport } from "./lib/notify.js";

const app = express();

app.set("trust proxy", 1);
app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" } }));
// CORS: قائمة بيضاء فقط. لو ALLOWED_ORIGINS مضبوط (مفصولة بفواصل) نستعمله، وإلا نستعمل
// تطبيقات الإنتاج الأربعة + عناوين التطوير المحلي. الطلبات بدون Origin (سيرفس واتساب، curl) ما تتأثر.
const DEFAULT_ORIGINS = [
  "https://jomla-customer-beta.vercel.app",
  "https://jomla-supplier.vercel.app",
  "https://jomla-admin-omega.vercel.app",
  "https://jomla-driver.vercel.app",
  "http://localhost:5173", "http://localhost:5174", "http://localhost:5175", "http://localhost:5176",
  "http://localhost:4173", "http://localhost:3000",
  "http://127.0.0.1:5173", "http://127.0.0.1:3000",
];
const envOrigins = (process.env.ALLOWED_ORIGINS || "").split(",").map((o) => o.trim()).filter(Boolean);
const ALLOWED_ORIGINS = new Set(envOrigins.length ? envOrigins : DEFAULT_ORIGINS);
// نقبل أيضًا أي عنوان تطبيقات جملة على Vercel (jomla-*.vercel.app) حتى لو تغيّر الاسم أو كان نسخة معاينة.
// المصادقة بالتوكن في الهيدر (وليس كوكيز)، فالموقع الغريب ما يقدر يقرأ توكن مستخدم من موقع آخر.
const JOMLA_VERCEL = /^https:\/\/jomla[a-z0-9-]*\.vercel\.app$/i;
// دومين جملة الرسمي: jomla-ly.com وكل النطاقات الفرعية (admin / supplier / driver / www ...).
const JOMLA_DOMAIN = /^https:\/\/([a-z0-9-]+\.)?jomla-ly\.com$/i;
app.use(cors({
  origin: (origin, cb) => cb(null, !origin || ALLOWED_ORIGINS.has(origin) || JOMLA_VERCEL.test(origin) || JOMLA_DOMAIN.test(origin)),
  credentials: true,
}));
app.use(express.json({ limit: "2mb" }) /* الاستيراد الجماعي للأصناف يحتاج هذا الحجم */);
app.use((req, _res, next) => { console.log(`[REQ] ${req.method} ${req.path}`); next(); });
app.use(rateLimit({ windowMs: 60_000, max: 300 }));
app.use("/uploads", express.static(process.env.UPLOAD_DIR || "uploads"));

app.get("/health", async (_req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ ok: true });
  } catch {
    res.status(503).json({ ok: false });
  }
});

app.use("/api/auth", authRouter);
app.use("/api/auth/me", authenticate);
app.use("/api/catalog", catalogRouter);
app.use("/api/orders", orderRouter);
app.use("/api/finance", financeRouter);
app.use("/api/employees", employeeRouter);
app.use("/api/accounts", accountsRouter);
app.use("/api/delivery", deliveryRouter);
app.use("/api/engagement", engagementRouter);
app.use("/api/support", supportRouter);
app.use("/api/assets", assetsRouter);
app.use("/api/uploads", uploadRouter);
app.use("/api/banners", bannerRouter);
app.use("/api/agent", agentRouter);
app.use("/api/carts", cartRouter);
app.use("/api/search-log", searchLogRouter);
app.use("/api/system", systemRouter);

app.use((_req, res) => res.status(404).json({ error: "المسار غير موجود" }));

app.use((err, _req, res, _next) => {
  // أخطاء قاعدة البيانات "المترجمة" لرسالة عامة: نسجّل السبب الحقيقي في اللوغ عشان نقدر نشخّصها
  if (["22P02", "22007", "22003", "23514", "23503", "23505"].includes(err?.code)) {
    console.error(`[DB-ERROR] ${_req.method} ${_req.path} code=${err.code} table=${err.table || "-"} column=${err.column || "-"} constraint=${err.constraint || "-"} msg=${err.message} detail=${err.detail || "-"}`);
  }
  if (err instanceof ZodError) {
    return res.status(400).json({
      error: "بيانات غير صالحة",
      details: err.errors.map((e) => ({ field: e.path.join("."), message: e.message })),
    });
  }
  if (err instanceof ApiError) {
    return res.status(err.status).json({ error: err.message, code: err.code });
  }
  if (/timeout exceeded when trying to connect|Connection terminated/i.test(String(err?.message || ""))) {
    console.error("[DB-BUSY]", req.method, req.path, err?.message);
    logServerError({ req, err, status: 503 });
    return res.status(503).json({ error: "السيرفر مشغول حاليًا، أعد المحاولة بعد لحظات" });
  }
  if (err?.code === "23505") {
    return res.status(409).json({ error: "هذا السجل موجود مسبقًا" });
  }
  if (["22P02", "22007", "22003", "23514"].includes(err?.code)) {
    return res.status(400).json({ error: "قيمة غير صالحة في البيانات المرسلة" });
  }
  if (["40P01", "40001"].includes(err?.code)) {
    return res.status(409).json({ error: "العملية تعارضت مع عملية أخرى، أعد المحاولة" });
  }
  if (err?.code === "23503") {
    return res.status(400).json({ error: "مرجع غير صالح في البيانات المرسلة" });
  }

  console.error("[ERROR]", err);
  logServerError({ req, err, status: 500 });
  // في وضع التجربة فقط (TEST_SKIP_OTP=1) نرجّع سبب الخطأ التقني لتسهيل الفحص — يختفي تلقائيًا بحذف متغيرات التجربة قبل الإطلاق
  const detail = process.env.TEST_SKIP_OTP === "1" ? { detail: String(err?.message || err).slice(0, 300) } : {};
  res.status(500).json({ error: "حدث خطأ غير متوقع، يرجى المحاولة لاحقًا", ...detail });
});

const PORT = process.env.PORT || 3000;
// المدير العام يملك كل الصلاحيات دائمًا، حتى الجديدة اللي تنضاف لاحقًا
pool.query(
  `INSERT INTO role_permissions (role_id, permission_id)
   SELECT r.id, p.id FROM roles r CROSS JOIN permissions p WHERE r.code = 'general_manager'
   ON CONFLICT DO NOTHING`
).catch((e) => console.error("[startup] general_manager permission sync failed:", e.message));

ensureSchema().catch((e) => console.error("[schema]", e?.message || e));

const server = app.listen(PORT, () => {
  console.log(`منظومة جملة — الواجهة البرمجية تعمل على المنفذ ${PORT}`);
});

// تهيئة البيانات الأولية (أقسام/بانرات/تنظيف أصناف تجريبية): غير حاجبة ولا توقّع السيرفر أبدًا
setTimeout(() => {
  try {
    runBootstrap().catch((e) => console.error("[bootstrap]", e?.message || e));
  } catch (e) {
    console.error("[bootstrap]", e?.message || e);
  }
}, 3000);

const whatsappTimer = setInterval(() => {
  dispatchWhatsappQueue().catch((e) => console.error("[WhatsApp]", e.message));
}, 30_000);

const voucherAlertTimer = setInterval(() => {
  dispatchManagerVoucherAlerts().catch((e) => console.error("[VoucherAlerts]", e.message));
}, 30_000);

const remindersTimer = setInterval(() => {
  runCreditDueReminders().catch((e) => console.error("[Reminders]", e.message));
}, 6 * 60 * 60 * 1000);

// يفحص كل 5 دقايق لو حان وقت تقرير الأرباح اليومي (~23:50 بتوقيت ليبيا)، ويبعته مرة واحدة بس
const dailyReportTimer = setInterval(() => {
  maybeSendDailyProfitReport().catch((e) => console.error("[DailyReport]", e.message));
}, 5 * 60 * 1000);

// نفس الفكرة للتقرير الشهري: يفحص كل 5 دقايق، وما يبعث إلا في آخر يوم بالشهر
// (~23:55 بتوقيت ليبيا)، مرة واحدة بس
const monthlyReportTimer = setInterval(() => {
  maybeSendMonthlyProfitReport().catch((e) => console.error("[MonthlyReport]", e.message));
}, 5 * 60 * 1000);

// ما نخليش خطأ غير متوقع يوقّع السيرفر كله — نسجّله ونكمل
process.on("unhandledRejection", (err) => { console.error("[unhandledRejection]", err); logServerError({ err, status: 500 }); });
process.on("uncaughtException", (err) => { console.error("[uncaughtException]", err); logServerError({ err, status: 500 }); });
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    clearInterval(whatsappTimer);
    clearInterval(voucherAlertTimer);
    clearInterval(remindersTimer);
    clearInterval(dailyReportTimer);
    clearInterval(monthlyReportTimer);
    server.close(() => pool.end().then(() => process.exit(0)));
  });
}

export default app;
