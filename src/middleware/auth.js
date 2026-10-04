import jwt from "jsonwebtoken";
import { query } from "../lib/db.js";
import { ApiError } from "../lib/helpers.js";

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) throw new Error("JWT_SECRET غير معرّف في متغيرات البيئة");

export function signToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: "12h" });
}

/* ---------------------------------------------------------------------------
   التحقق من حالة الحساب من قاعدة البيانات (مع كاش ~30 ثانية)
   التوكن وحده ما يكفيش: لو الحساب اتوقف أو الموظف اتعطّل أو اتغيّر دوره، لازم يسري
   التغيير خلال ثواني مش بعد انتهاء التوكن (12 ساعة).
--------------------------------------------------------------------------- */
const AUTH_CACHE_TTL_MS = 30_000;
const AUTH_CACHE_MAX = 5000;
const authCache = new Map(); // "type:id" -> { at, state }

const MSG_SUSPENDED = "تم إيقاف هذا الحساب، يرجى التواصل مع الدعم الفني";
const MSG_PENDING = "حسابك غير مفعّل حاليًا (بانتظار اعتماد الإدارة)، يرجى التواصل مع الدعم الفني";
const MSG_GONE = "هذا الحساب غير متاح، يرجى التواصل مع الدعم الفني";

/** يمسح كاش حساب معيّن — يُستدعى عند إيقاف/تعطيل/تعديل الحساب ليسري التغيير فورًا */
export function invalidateAuthCache(actorType, id) {
  if (actorType && id) authCache.delete(`${actorType}:${id}`);
}

async function loadActorState(type, id) {
  if (type === "employee") {
    const { rows } = await query(
      `SELECT e.name, e.is_active, r.code AS role
         FROM employees e JOIN roles r ON r.id = e.role_id WHERE e.id = $1`,
      [id]
    );
    if (!rows.length) return { ok: false, status: 401, message: MSG_GONE };
    if (!rows[0].is_active) return { ok: false, status: 403, message: MSG_SUSPENDED, code: "ACCOUNT_BLOCKED" };
    return { ok: true, name: rows[0].name, role: rows[0].role };
  }
  if (type === "customer" || type === "supplier") {
    const table = type === "customer" ? "customers" : "suppliers";
    const { rows } = await query(`SELECT business_name AS name, status FROM ${table} WHERE id = $1`, [id]);
    if (!rows.length) return { ok: false, status: 401, message: MSG_GONE };
    const st = rows[0].status;
    if (st === "approved") return { ok: true, name: rows[0].name, role: null };
    if (st === "pending") return { ok: false, status: 403, message: MSG_PENDING, code: "ACCOUNT_BLOCKED" };
    if (st === "deleted") return { ok: false, status: 401, message: MSG_GONE };
    return { ok: false, status: 403, message: MSG_SUSPENDED, code: "ACCOUNT_BLOCKED" }; // suspended / rejected
  }
  return { ok: false, status: 401, message: "الجلسة منتهية، يرجى تسجيل الدخول من جديد" };
}

export async function authenticate(req, _res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return next(new ApiError(401, "يلزم تسجيل الدخول"));

  let decoded;
  try {
    decoded = jwt.verify(token, JWT_SECRET);
  } catch {
    return next(new ApiError(401, "الجلسة منتهية، يرجى تسجيل الدخول من جديد"));
  }

  try {
    const key = `${decoded.type}:${decoded.sub}`;
    let hit = authCache.get(key);
    if (!hit || Date.now() - hit.at > AUTH_CACHE_TTL_MS) {
      hit = { at: Date.now(), state: await loadActorState(decoded.type, decoded.sub) };
      if (authCache.size > AUTH_CACHE_MAX) {
        for (const [k, v] of authCache) if (Date.now() - v.at > AUTH_CACHE_TTL_MS) authCache.delete(k);
        if (authCache.size > AUTH_CACHE_MAX) authCache.clear();
      }
      authCache.set(key, hit);
    }
    const st = hit.state;
    if (!st.ok) return next(new ApiError(st.status, st.message, st.code ?? null));

    req.actor = {
      type: decoded.type,
      id: decoded.sub,
      name: st.name || decoded.name,
      role: st.role, // الدور الحالي من قاعدة البيانات (مو اللي بالتوكن)
    };
    next();
  } catch (err) {
    next(err);
  }
}

export const requireActorType = (...types) => (req, _res, next) => {
  if (!req.actor || !types.includes(req.actor.type)) {
    return next(new ApiError(403, "لا تملك صلاحية الوصول لهذه الشاشة"));
  }
  next();
};

/* ---------------------------------------------------------------------------
   منطق الصلاحيات الموحّد: صلاحية الدور + الاستثناءات الفردية (granted=false تسحب)
   وموظف نشط فقط.
--------------------------------------------------------------------------- */
const EFFECTIVE_PERM_SQL = `
  COALESCE(
    (SELECT o.granted FROM employee_permission_overrides o
       WHERE o.employee_id = e.id AND o.permission_id = p.id),
    EXISTS (SELECT 1 FROM role_permissions rp WHERE rp.role_id = e.role_id AND rp.permission_id = p.id)
  )`;

/** هل الموظف (النشط) يملك أي صلاحية من القائمة فعليًا؟ */
export async function employeeHasAnyPermission(employeeId, codes) {
  const { rows } = await query(
    `SELECT 1
       FROM employees e
       CROSS JOIN permissions p
      WHERE e.id = $1 AND e.is_active AND p.code = ANY($2::TEXT[])
        AND ${EFFECTIVE_PERM_SQL}
      LIMIT 1`,
    [employeeId, codes]
  );
  return rows.length > 0;
}

export const employeeHasPermission = (employeeId, code) => employeeHasAnyPermission(employeeId, [code]);

/** مجموعة الصلاحيات الفعلية لموظف (دوره + الاستثناءات) كـ Set من الأكواد */
export async function getEffectivePermissionCodes(employeeId) {
  const { rows } = await query(
    `SELECT p.code
       FROM employees e
       CROSS JOIN permissions p
      WHERE e.id = $1 AND ${EFFECTIVE_PERM_SQL}`,
    [employeeId]
  );
  return new Set(rows.map((r) => r.code));
}

export const requirePermission = (permissionCode) => async (req, _res, next) => {
  try {
    if (!req.actor) throw new ApiError(401, "يلزم تسجيل الدخول");
    if (req.actor.type !== "employee") throw new ApiError(403, "هذا الإجراء مخصص لموظفي الشركة");
    if (!(await employeeHasPermission(req.actor.id, permissionCode))) {
      throw new ApiError(403, "لا تملك صلاحية تنفيذ هذا الإجراء");
    }
    next();
  } catch (err) {
    next(err);
  }
};

export const requireAnyPermission = (...permissionCodes) => async (req, _res, next) => {
  try {
    if (!req.actor) throw new ApiError(401, "يلزم تسجيل الدخول");
    if (req.actor.type !== "employee") throw new ApiError(403, "هذا الإجراء مخصص لموظفي الشركة");
    if (!(await employeeHasAnyPermission(req.actor.id, permissionCodes))) {
      throw new ApiError(403, "لا تملك صلاحية تنفيذ هذا الإجراء");
    }
    next();
  } catch (err) {
    next(err);
  }
};

/** يشيل حقول الـ OTP (وأي سر) من أي صف قبل إرجاعه للواجهة أو حفظه بسجل التدقيق */
export function stripSecrets(row) {
  if (!row || typeof row !== "object") return row;
  const out = {};
  for (const [k, v] of Object.entries(row)) {
    if (k === "otp_hash" || k.startsWith("otp_")) continue;
    out[k] = v;
  }
  return out;
}

// لو القسم المطلوب قسم فرعي (له parent_id)، التفعيل يتحقق منه على مستوى القسم الرئيسي
// (تفعيل القسم الرئيسي للعميل يفعّل كل تصنيفاته الفرعية تلقائيًا)
export async function assertCustomerSection(customerId, sectionId) {
  const { rows } = await query(
    `SELECT 1
       FROM sections s
       JOIN customer_sections cs ON cs.section_id = COALESCE(s.parent_id, s.id)
      WHERE s.id = $2 AND cs.customer_id = $1 AND cs.enabled`,
    [customerId, sectionId]
  );
  if (!rows.length) throw new ApiError(403, "هذا القسم غير مفعّل لحسابك");
}

// نطاق الأقسام المخصّص لموظف معيّن (لتقييد عمله على موردين/طلبيات أقسام بعينها).
// إرجاع null يعني "غير مقيّد" — الموظف ما عندهوش صفوف بالجدول، فيشتغل على كل الأقسام
// زي أي موظف عادي (وهذا يحافظ على سلوك كل الموظفين الحاليين بدون تغيير حتى نخصص أحدهم فعليًا)
export async function getEmployeeSectionScope(employeeId) {
  const { rows } = await query(
    `SELECT section_id FROM employee_section_scope WHERE employee_id = $1`,
    [employeeId]
  );
  return rows.length ? new Set(rows.map((r) => r.section_id)) : null;
}

// يتحقق إن كل قسم من الأقسام المطلوبة (sectionIds) داخل نطاق الموظف — يُستخدم وقت
// اعتماد حساب أو تعديل أقسامه، عشان موظف مقيّد ما يقدرش يمنح/يعتمد قسم مو مخصص له
export async function assertSectionScope(employeeId, sectionIds) {
  const scope = await getEmployeeSectionScope(employeeId);
  if (scope === null) return; // غير مقيّد
  const ids = sectionIds ?? [];
  if (!ids.length || !ids.every((id) => scope.has(id))) {
    throw new ApiError(403, "لا تملك صلاحية على أحد الأقسام المطلوبة");
  }
}
