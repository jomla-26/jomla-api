import jwt from "jsonwebtoken";
import { query } from "../lib/db.js";
import { ApiError } from "../lib/helpers.js";

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) throw new Error("JWT_SECRET غير معرّف في متغيرات البيئة");

export function signToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: "12h" });
}

export function authenticate(req, _res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return next(new ApiError(401, "يلزم تسجيل الدخول"));

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.actor = {
      type: decoded.type,
      id: decoded.sub,
      name: decoded.name,
      role: decoded.role || null,
    };
    next();
  } catch {
    next(new ApiError(401, "الجلسة منتهية، يرجى تسجيل الدخول من جديد"));
  }
}

export const requireActorType = (...types) => (req, _res, next) => {
  if (!req.actor || !types.includes(req.actor.type)) {
    return next(new ApiError(403, "لا تملك صلاحية الوصول لهذه الشاشة"));
  }
  next();
};

export const requirePermission = (permissionCode) => async (req, _res, next) => {
  try {
    if (!req.actor) throw new ApiError(401, "يلزم تسجيل الدخول");
    if (req.actor.type !== "employee") throw new ApiError(403, "هذا الإجراء مخصص لموظفي الشركة");

    const { rows } = await query(
      `SELECT COALESCE(ovr.granted, TRUE) AS allowed
         FROM employees e
         JOIN roles r                 ON r.id = e.role_id
         LEFT JOIN role_permissions rp ON rp.role_id = r.id
         LEFT JOIN permissions p       ON p.id = rp.permission_id AND p.code = $2
         LEFT JOIN employee_permission_overrides ovr
                ON ovr.employee_id = e.id
               AND ovr.permission_id = (SELECT id FROM permissions WHERE code = $2)
        WHERE e.id = $1
          AND e.is_active
          AND (p.code IS NOT NULL OR ovr.granted IS TRUE)
        LIMIT 1`,
      [req.actor.id, permissionCode]
    );

    if (!rows.length || rows[0].allowed !== true) {
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

    const { rows } = await query(
      `SELECT 1
         FROM employees e
         JOIN role_permissions rp ON rp.role_id = e.role_id
         JOIN permissions p       ON p.id = rp.permission_id AND p.code = ANY($2::TEXT[])
        WHERE e.id = $1 AND e.is_active
        UNION
       SELECT 1
         FROM employee_permission_overrides ovr
         JOIN permissions p ON p.id = ovr.permission_id AND p.code = ANY($2::TEXT[])
        WHERE ovr.employee_id = $1 AND ovr.granted = TRUE
        LIMIT 1`,
      [req.actor.id, permissionCodes]
    );

    if (!rows.length) throw new ApiError(403, "لا تملك صلاحية تنفيذ هذا الإجراء");
    next();
  } catch (err) {
    next(err);
  }
};

export async function assertCustomerSection(customerId, sectionId) {
  const { rows } = await query(
    `SELECT 1 FROM customer_sections
      WHERE customer_id = $1 AND section_id = $2 AND enabled`,
    [customerId, sectionId]
  );
  if (!rows.length) throw new ApiError(403, "هذا القسم غير مفعّل لحسابك");
}
