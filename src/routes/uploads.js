import { Router } from "express";
import multer from "multer";
import crypto from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import ws from "ws";
import { authenticate } from "../middleware/auth.js";
import { ApiError } from "../lib/helpers.js";

export const uploadRouter = Router();
uploadRouter.use(authenticate);

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error("SUPABASE_URL أو SUPABASE_SERVICE_ROLE_KEY غير معرّفين في متغيرات البيئة");
}
// نستخدم مفتاح service role (صلاحيات كاملة) لأن الرفع يتم من السيرفر نفسه بعد
// التحقق من هوية المستخدم عبر authenticate — الرابط المرتجع للملف بعدها عام (public)
// نستخدم مكتبة "ws" بس عشان مكتبة supabase-js تتفادى الانهيار — Node.js 20 ما فيهوش
// دعم WebSocket مدمج (جا بس من Node 22)، ومكتبة supabase-js بتحاول تفعّل ميزة
// "Realtime" تلقائيًا حتى إنه إحنا ما نستخدمهاش أبدًا، هنا بس نستخدم Storage
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  realtime: { transport: ws },
});
const BUCKET = process.env.SUPABASE_UPLOADS_BUCKET || "uploads";

// بدل تخزين الملفات على قرص Railway (مؤقت — ينمسح مع أي إعادة نشر/تشغيل)، نستقبل
// الملف بالذاكرة بس ونرفعه فورًا لتخزين Supabase الدائم
const storage = multer.memoryStorage();

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
});

// التحقق من نوع الملف عبر "البصمة" الحقيقية للبايتات الأولى، مش النوع المُعلَن
// من المتصفح (mimetype) — ده سهل تزويره بتغيير اسم/امتداد الملف بس. بدون هذا
// التحقق، حد يقدر يرفع ملف تنفيذي أو HTML ضار متنكّر في شكل "صورة"
function detectImageType(buffer) {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { mime: "image/jpeg", ext: "jpg" };
  }
  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47 &&
    buffer[4] === 0x0d && buffer[5] === 0x0a && buffer[6] === 0x1a && buffer[7] === 0x0a
  ) {
    return { mime: "image/png", ext: "png" };
  }
  if (
    buffer.length >= 12 &&
    buffer.toString("ascii", 0, 4) === "RIFF" &&
    buffer.toString("ascii", 8, 12) === "WEBP"
  ) {
    return { mime: "image/webp", ext: "webp" };
  }
  return null;
}

uploadRouter.post("/image", (req, res, next) => {
  upload.single("image")(req, res, async (err) => {
    if (err instanceof multer.MulterError) return next(new ApiError(400, "تعذّر رفع الملف — تحقق من الحجم والنوع"));
    if (err) return next(err);
    if (!req.file) return next(new ApiError(400, "لم يتم إرفاق صورة"));

    const detected = detectImageType(req.file.buffer);
    if (!detected) {
      return next(new ApiError(400, "نوع الملف غير مدعوم — jpg أو png أو webp فقط"));
    }

    try {
      const filename = `${crypto.randomUUID()}.${detected.ext}`;
      const { error } = await supabase.storage.from(BUCKET).upload(filename, req.file.buffer, {
        contentType: detected.mime,
        upsert: false,
      });
      if (error) throw error;

      const { data } = supabase.storage.from(BUCKET).getPublicUrl(filename);
      res.status(201).json({ url: data.publicUrl });
    } catch (e) {
      console.error("[UPLOAD]", e);
      next(new ApiError(500, "تعذّر رفع الصورة، يرجى المحاولة لاحقًا"));
    }
  });
});
