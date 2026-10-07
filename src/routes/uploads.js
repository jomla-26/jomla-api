import { Router } from "express";
import multer from "multer";
import crypto from "node:crypto";
import sharp from "sharp";
import { createClient } from "@supabase/supabase-js";
import ws from "ws";
import { authenticate, requirePermission, requireAnyPermission } from "../middleware/auth.js";
import { ApiError } from "../lib/helpers.js";
import { query, withTransaction, writeAudit, resubmitForApproval } from "../lib/db.js";

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

// الرفع للموردين وموظفي الإدارة (بصلاحية كتالوج/أقسام/أصول/حسابات) فقط — العملاء والمناديب ما يرفعون ملفات
function runMiddleware(mw, req, res) {
  return new Promise((resolve, reject) => mw(req, res, (e) => (e ? reject(e) : resolve())));
}
async function assertCanUploadImages(req, res) {
  if (req.actor.type === "supplier") return;
  if (req.actor.type !== "employee") throw new ApiError(403, "رفع الصور غير متاح لهذا الحساب");
  await runMiddleware(
    requireAnyPermission("catalog.manage", "banners.manage", "delivery.manage", "accounts.sections", "accounts.approve", "assets.manage"), req, res
  );
}

uploadRouter.post("/image", async (req, res, next) => {
  try { await assertCanUploadImages(req, res); } catch (e) { return next(e); }
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

// رفع صور أصناف دفعة وحدة — كل صورة تتطابق مع صنفها عن طريق اسم الملف (بدون
// الامتداد) اللي لازم يكون نفس "رقم الصنف عند المورد" (supplier_sku) بالضبط
// الحد: 20 ملفًا في الطلب الواحد × 10 ميجا للملف (الذاكرة تُحجز لكل الملفات معًا، فالحد يحمي السيرفر)
const BULK_MAX_FILES = 20;
const bulkUpload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024, files: BULK_MAX_FILES } });

uploadRouter.post("/product-images/bulk", async (req, res, next) => {
  // التحقق من هوية/صلاحية الرافع قبل استقبال أي ملف
  if (req.actor.type !== "supplier") {
    try {
      if (req.actor.type !== "employee") throw new ApiError(403, "رفع الصور غير متاح لهذا الحساب");
      await runMiddleware(requirePermission("catalog.manage"), req, res);
    } catch (e) { return next(e); }
  }
  bulkUpload.array("images", BULK_MAX_FILES)(req, res, async (err) => {
    if (err instanceof multer.MulterError) {
      const message =
        err.code === "LIMIT_FILE_SIZE"
          ? "إحدى الصور كبيرة جدًا — الحد الأقصى 10 ميجابايت للصورة"
          : ["LIMIT_FILE_COUNT", "LIMIT_UNEXPECTED_FILE"].includes(err.code)
            ? `الحد الأقصى ${BULK_MAX_FILES} صورة في المرة الواحدة — ارفعها على دفعات`
            : "تعذّر رفع الملفات";
      return next(new ApiError(400, message));
    }
    if (err) return next(err);
    if (!req.files?.length) return next(new ApiError(400, "لم يتم إرفاق أي صور"));

    try {
    let supplierId;
    if (req.actor.type === "supplier") {
      supplierId = req.actor.id;
    } else {
      supplierId = req.body.supplierId;
      if (!supplierId) return next(new ApiError(400, "يجب تحديد المورد"));
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(supplierId)) return next(new ApiError(400, "معرّف المورد غير صالح"));
    }

    const matched = [];
    const unmatched = [];

    for (const file of req.files) {
      const code = file.originalname.replace(/\.[^.]+$/, "").trim();
      if (!code) { unmatched.push({ file: file.originalname, reason: "اسم ملف غير صالح" }); continue; }

      // الكود قد يكون كود صنف أو كود نوع (لون/مقاس)
      let { rows } = await query(
        `SELECT id, name FROM products
          WHERE supplier_id = $1 AND lower(supplier_sku) = lower($2)
          ORDER BY added_at, id LIMIT 1`,
        [supplierId, code]
      );
      let variantId = null;
      if (!rows.length) {
        const { rows: vr } = await query(
          `SELECT v.id AS variant_id, p.id, p.name || ' - ' || v.label AS name
             FROM product_variants v JOIN products p ON p.id = v.product_id
            WHERE p.supplier_id = $1 AND lower(v.sku) = lower($2)
            ORDER BY v.created_at, v.id LIMIT 1`,
          [supplierId, code]
        );
        if (vr.length) { rows = vr; variantId = vr[0].variant_id; }
      }
      if (!rows.length) {
        unmatched.push({ file: file.originalname, reason: "لا يوجد صنف بهذا الكود" });
        continue;
      }

      let outputBuffer;
      try {
        outputBuffer = await sharp(file.buffer)
          .rotate()
          .resize({ width: 1920, height: 1920, fit: "inside", withoutEnlargement: true })
          .jpeg({ quality: 85 })
          .toBuffer();
      } catch {
        unmatched.push({ file: file.originalname, reason: "تعذّر التعرّف على نوع الصورة" });
        continue;
      }

      try {
        const filename = `${crypto.randomUUID()}.jpg`;
        const { error } = await supabase.storage.from(BUCKET).upload(filename, outputBuffer, {
          contentType: "image/jpeg", upsert: false,
        });
        if (error) throw error;
        const { data } = supabase.storage.from(BUCKET).getPublicUrl(filename);

        // كل تغيير صورة داخل معاملة واحدة مع صف تدقيق (الصورة قبل ← بعد + من رفعها)،
        // وصورة جديدة من المورد على صنف معتمد/مرفوض = تعديل يراه العميل → يرجع للمراجعة (نفس قاعدة تعديل الصنف)
        await withTransaction(async (client) => {
          const actorInfo = { actorType: req.actor.type, actorId: req.actor.id, actorName: req.actor.name, ip: req.ip };
          const { rows: [pBefore] } = await client.query(`SELECT * FROM products WHERE id = $1 FOR UPDATE`, [rows[0].id]);
          if (variantId) {
            const { rows: [vBefore] } = await client.query(`SELECT * FROM product_variants WHERE id = $1 FOR UPDATE`, [variantId]);
            const { rows: [vAfter] } = await client.query(
              `UPDATE product_variants SET image_url = $2 WHERE id = $1 RETURNING *`, [variantId, data.publicUrl]);
            await writeAudit(client, {
              ...actorInfo, action: "product_variant.updated", entityType: "product_variant", entityId: variantId,
              entityLabel: rows[0].name, before: vBefore, after: vAfter,
            });
            if (!pBefore.image_url) {
              const { rows: [pAfter] } = await client.query(`UPDATE products SET image_url = $2 WHERE id = $1 RETURNING *`, [pBefore.id, data.publicUrl]);
              await writeAudit(client, {
                ...actorInfo, action: "product.updated", entityType: "product", entityId: pBefore.id,
                entityLabel: pBefore.name, before: pBefore, after: pAfter,
              });
            }
          } else {
            const { rows: [pAfter] } = await client.query(`UPDATE products SET image_url = $2 WHERE id = $1 RETURNING *`, [pBefore.id, data.publicUrl]);
            await writeAudit(client, {
              ...actorInfo, action: "product.updated", entityType: "product", entityId: pBefore.id,
              entityLabel: pBefore.name, before: pBefore, after: pAfter,
            });
          }
          if (req.actor.type === "supplier") {
            await resubmitForApproval(client, pBefore.id, {
              actor: req.actor, ip: req.ip,
              reason: variantId ? `رفع صور جماعي — تغيير صورة النوع (${rows[0].name})` : "رفع صور جماعي — تغيير صورة الصنف",
            });
          }
        });
        matched.push({ file: file.originalname, productId: rows[0].id, productName: rows[0].name, url: data.publicUrl });
      } catch (e) {
        console.error("[BULK_UPLOAD]", e);
        unmatched.push({ file: file.originalname, reason: "تعذّر رفع الصورة" });
      }
    }

    res.json({ matched, unmatched });
    } catch (e) {
      next(e);
    }
  });
});
