import { Router } from "express";
import multer from "multer";
import crypto from "node:crypto";
import sharp from "sharp";
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
  // نسمح بملف أصلي لحد 15 ميجا (صور كاميرا الجوال الحديثة، خصوصًا آيفون، تطلع كبيرة)
  // وبعدين نضغطها احنا لحجم أصغر بكثير قبل التخزين النهائي
  limits: { fileSize: 15 * 1024 * 1024 },
});

uploadRouter.post("/image", (req, res, next) => {
  upload.single("image")(req, res, async (err) => {
    if (err instanceof multer.MulterError) {
      const message =
        err.code === "LIMIT_FILE_SIZE"
          ? "حجم الصورة كبير جدًا — الحد الأقصى 15 ميجابايت"
          : "تعذّر رفع الملف";
      return next(new ApiError(400, message));
    }
    if (err) return next(err);
    if (!req.file) return next(new ApiError(400, "لم يتم إرفاق صورة"));

    // نمرّر أي صيغة صورة يقدر Sharp يفكّها (JPG, PNG, WEBP, GIF, BMP, TIFF, وكمان
    // HEIC/HEIF اللي تطلعها كاميرا الآيفون افتراضيًا) ونحوّلها كلها لصيغة JPEG
    // موحّدة، ونصغّر أي صورة أعرض من 1920px — هذا يحل مشكلة "نوع غير مدعوم" اللي
    // كانت تطلع مع صور الآيفون، ويقلل حجم التخزين والتحميل بكثير
    let outputBuffer;
    try {
      outputBuffer = await sharp(req.file.buffer)
        .rotate()
        .resize({ width: 1920, height: 1920, fit: "inside", withoutEnlargement: true })
        .jpeg({ quality: 85 })
        .toBuffer();
    } catch (e) {
      console.error("[UPLOAD] فشل تحويل الصورة:", e);
      return next(new ApiError(400, "تعذّر التعرّف على نوع الصورة — جرّب صورة jpg أو png أو webp"));
    }

    try {
      const filename = `${crypto.randomUUID()}.jpg`;
      const { error } = await supabase.storage.from(BUCKET).upload(filename, outputBuffer, {
        contentType: "image/jpeg",
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
