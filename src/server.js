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
import { assetsRouter } from "./routes/assets.js";
import { uploadRouter } from "./routes/uploads.js";
import { bannerRouter } from "./routes/banners.js";
import { dispatchWhatsappQueue, runCreditDueReminders, maybeSendDailyProfitReport } from "./lib/notify.js";

const app = express();

app.set("trust proxy", 1);
app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" } }));
app.use(cors({ origin: process.env.ALLOWED_ORIGINS?.split(",") ?? true, credentials: true }));
app.use(express.json({ limit: "2mb" }));
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
app.use("/api/assets", assetsRouter);
app.use("/api/uploads", uploadRouter);
app.use("/api/banners", bannerRouter);

app.use((_req, res) => res.status(404).json({ error: "المسار غير موجود" }));

app.use((err, _req, res, _next) => {
  if (err instanceof ZodError) {
    return res.status(400).json({
      error: "بيانات غير صالحة",
      details: err.errors.map((e) => ({ field: e.path.join("."), message: e.message })),
    });
  }
  if (err instanceof ApiError) {
    return res.status(err.status).json({ error: err.message, code: err.code });
  }
  if (err?.code === "23505") {
    return res.status(409).json({ error: "هذا السجل موجود مسبقًا" });
  }
  if (err?.code === "23503") {
    return res.status(400).json({ error: "مرجع غير صالح في البيانات المرسلة" });
  }

  console.error("[ERROR]", err);
  res.status(500).json({ error: "حدث خطأ غير متوقع، يرجى المحاولة لاحقًا" });
});

const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => {
  console.log(`منظومة جملة — الواجهة البرمجية تعمل على المنفذ ${PORT}`);
});

const whatsappTimer = setInterval(() => {
  dispatchWhatsappQueue().catch((e) => console.error("[WhatsApp]", e.message));
}, 30_000);

const remindersTimer = setInterval(() => {
  runCreditDueReminders().catch((e) => console.error("[Reminders]", e.message));
}, 6 * 60 * 60 * 1000);

// يفحص كل 5 دقايق لو حان وقت تقرير الأرباح اليومي (~23:50 بتوقيت ليبيا)، ويبعته مرة واحدة بس
const dailyReportTimer = setInterval(() => {
  maybeSendDailyProfitReport().catch((e) => console.error("[DailyReport]", e.message));
}, 5 * 60 * 1000);

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    clearInterval(whatsappTimer);
    clearInterval(remindersTimer);
    clearInterval(dailyReportTimer);
    server.close(() => pool.end().then(() => process.exit(0)));
  });
}

export default app;
