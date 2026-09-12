import { Router } from "express";
import multer from "multer";
import path from "node:path";
import crypto from "node:crypto";
import fs from "node:fs";
import { authenticate } from "../middleware/auth.js";
import { ApiError } from "../lib/helpers.js";

export const uploadRouter = Router();
uploadRouter.use(authenticate);

const UPLOAD_DIR = process.env.UPLOAD_DIR || "uploads";
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const ALLOWED_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname) || ".jpg";
    cb(null, `${crypto.randomUUID()}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (!ALLOWED_TYPES.has(file.mimetype)) return cb(new ApiError(400, "نوع الملف غير مدعوم — jpg أو png أو webp فقط"));
    cb(null, true);
  },
});

uploadRouter.post("/image", (req, res, next) => {
  upload.single("image")(req, res, (err) => {
    if (err instanceof multer.MulterError) return next(new ApiError(400, "تعذّر رفع الملف — تحقق من الحجم والنوع"));
    if (err) return next(err);
    if (!req.file) return next(new ApiError(400, "لم يتم إرفاق صورة"));

    res.status(201).json({ url: `/uploads/${req.file.filename}` });
  });
});
