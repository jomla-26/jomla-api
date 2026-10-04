import { Router } from "express";
import { z } from "zod";
import { query, withTransaction, writeAudit } from "../lib/db.js";
import { ApiError, asyncRoute, normalizePhone } from "../lib/helpers.js";
import {
  authenticate, requirePermission, requireAnyPermission,
  getEffectivePermissionCodes, getEmployeeSectionScope,
  stripSecrets, invalidateAuthCache,
} from "../middleware/auth.js";

export const employeeRouter = Router();
employeeRouter.use(authenticate);

const GM_ROLE = "general_manager";

function pageParams(req, defLimit = 200, maxLimit = 1000) {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || defLimit, 1), maxLimit);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
  return { limit, offset };
}

// الهاتف يُخزَّن بنفس صيغة تسجيل الدخول (normalizePhone) عشان الدخول بالـ OTP يلقاه دايمًا
function cleanPhone(raw) {
  const phone = normalizePhone(raw);
  if (phone.length < 9 || phone.length > 15) throw new ApiError(400, "رقم الهاتف غير صالح");
  return phone;
}

/* ---------------------------- حماية رفع الصلاحيات ---------------------------- */

// الموظف ما يقدرش يدير موظف صلاحياته الفعلية أعلى من صلاحياته هو (يمنع تعديل/تعطيل/نقل رقم المدير العام)
async function assertCanManageTarget(callerPerms, targetId) {
  const target = await getEffectivePermissionCodes(targetId);
  for (const code of target) {
    if (!callerPerms.has(code)) {
      throw new ApiError(403, "لا تملك صلاحية التعديل على موظف صلاحياته أعلى من صلاحياتك");
    }
  }
}

// ما يقدرش يمنح وظيفة فيها صلاحيات هو نفسه ما يملكها
async function assertCanGrantRole(callerPerms, roleId) {
  const { rows } = await query(
    `SELECT p.code FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id WHERE rp.role_id = $1`,
    [roleId]
  );
  for (const r of rows) {
    if (!callerPerms.has(r.code)) {
      throw new ApiError(403, "لا يمكنك منح وظيفة تتضمن صلاحيات لا تملكها أنت");
    }
  }
}

// آخر مدير عام نشط ما يتعطّل ولا يتغيّر دوره. نقفل صفوف المديرين النشطين لمنع تعطيل اثنين بالتوازي.
async function assertNotLastGeneralManager(client, targetId) {
  const { rows } = await client.query(
    `SELECT e.id FROM employees e JOIN roles r ON r.id = e.role_id
      WHERE r.code = $1 AND e.is_active ORDER BY e.id FOR UPDATE OF e`,
    [GM_ROLE]
  );
  if (rows.some((r) => r.id === targetId) && rows.length <= 1) {
    throw new ApiError(409, "لا يمكن تعطيل أو تغيير آخر مدير عام نشط في المنظومة");
  }
}

employeeRouter.get("/roles", asyncRoute(async (_req, res) => {
  const { rows } = await query(`SELECT code, name FROM roles ORDER BY name`);
  res.json(rows);
}));

employeeRouter.get("/", requireAnyPermission("employees.manage", "finance.salaries"), asyncRoute(async (req, res) => {
  const { status } = req.query; // "active" (افتراضي) | "inactive" | "all"
  const activeFilter = status === "inactive" ? "NOT e.is_active"
    : status === "all" ? "TRUE"
    : "e.is_active";
  const pg = pageParams(req);

  const { rows } = await query(
    `SELECT e.id, e.name, e.phone, e.monthly_salary, e.started_on, e.last_login_at, e.is_active,
            r.code AS role_code, r.name AS role_name
       FROM employees e JOIN roles r ON r.id = e.role_id
      WHERE ${activeFilter}
      ORDER BY e.name
      LIMIT $1 OFFSET $2`,
    [pg.limit, pg.offset]
  );
  res.json(rows);
}));

const createSchema = z.object({
  name: z.string().trim().min(2).max(120),
  phone: z.string().min(9).max(20),
  roleCode: z.string().max(60),
  monthlySalary: z.number().nonnegative().max(10_000_000),
});

employeeRouter.post("/", requirePermission("employees.manage"), asyncRoute(async (req, res) => {
  const body = createSchema.parse(req.body);
  const phone = cleanPhone(body.phone);
  const callerPerms = await getEffectivePermissionCodes(req.actor.id);

  const employee = await withTransaction(async (client) => {
    const role = await client.query(`SELECT id, name FROM roles WHERE code = $1`, [body.roleCode]);
    if (!role.rows.length) throw new ApiError(400, "الوظيفة غير معروفة");
    await assertCanGrantRole(callerPerms, role.rows[0].id);

    const dup = await client.query(`SELECT id FROM employees WHERE phone = $1`, [phone]);
    if (dup.rows.length) throw new ApiError(409, "رقم الهاتف مسجّل مسبقًا لموظف آخر");

    const { rows } = await client.query(
      `INSERT INTO employees (name, phone, role_id, monthly_salary)
       VALUES ($1,$2,$3,$4) RETURNING id, name, phone, monthly_salary, started_on`,
      [body.name, phone, role.rows[0].id, body.monthlySalary]
    );
    const created = { ...rows[0], role_code: body.roleCode, role_name: role.rows[0].name };

    await writeAudit(client, {
      actorType: "employee", actorId: req.actor.id, actorName: req.actor.name,
      action: "employee.created", entityType: "employee", entityId: created.id,
      entityLabel: body.name, after: created, ip: req.ip,
    });
    return created;
  });

  res.status(201).json(employee);
}));

employeeRouter.patch("/:id", requirePermission("employees.manage"), asyncRoute(async (req, res) => {
  const body = z.object({
    name: z.string().trim().min(2).max(120).optional(),
    phone: z.string().min(9).max(20).optional(),
    roleCode: z.string().max(60).optional(),
    monthlySalary: z.number().nonnegative().max(10_000_000).optional(),
    isActive: z.boolean().optional(),
  }).parse(req.body);

  if (Object.keys(body).length === 0) {
    throw new ApiError(400, "لا توجد بيانات للتعديل");
  }
  const phone = body.phone !== undefined ? cleanPhone(body.phone) : null;
  const isSelf = req.params.id === req.actor.id;
  const callerPerms = await getEffectivePermissionCodes(req.actor.id);
  if (!isSelf) await assertCanManageTarget(callerPerms, req.params.id);

  const updated = await withTransaction(async (client) => {
    const before = await client.query(
      `SELECT e.*, r.code AS role_code FROM employees e JOIN roles r ON r.id = e.role_id WHERE e.id = $1 FOR UPDATE OF e`,
      [req.params.id]
    );
    if (!before.rows.length) throw new ApiError(404, "الموظف غير موجود");
    const prev = before.rows[0];

    let roleId = prev.role_id;
    const roleChanging = body.roleCode !== undefined && body.roleCode !== prev.role_code;
    if (roleChanging) {
      if (isSelf) throw new ApiError(403, "لا يمكنك تغيير وظيفتك بنفسك");
      const role = await client.query(`SELECT id FROM roles WHERE code = $1`, [body.roleCode]);
      if (!role.rows.length) throw new ApiError(400, "الوظيفة غير معروفة");
      await assertCanGrantRole(callerPerms, role.rows[0].id);
      roleId = role.rows[0].id;
    }
    if (isSelf && body.isActive === false) throw new ApiError(403, "لا يمكنك تعطيل حسابك بنفسك");
    if (isSelf && body.monthlySalary !== undefined && Number(body.monthlySalary) !== Number(prev.monthly_salary)) {
      throw new ApiError(403, "لا يمكنك تعديل راتبك بنفسك");
    }

    if ((body.isActive === false && prev.is_active) || (roleChanging && prev.role_code === GM_ROLE)) {
      await assertNotLastGeneralManager(client, req.params.id);
    }

    const phoneChanged = phone !== null && phone !== prev.phone;
    if (phoneChanged) {
      const dup = await client.query(`SELECT id FROM employees WHERE phone = $1 AND id != $2`, [phone, req.params.id]);
      if (dup.rows.length) throw new ApiError(409, "رقم الهاتف مسجّل مسبقًا لموظف آخر");
    }

    const { rows } = await client.query(
      `UPDATE employees SET
         name           = COALESCE($2, name),
         phone          = COALESCE($3, phone),
         role_id        = $4,
         monthly_salary = COALESCE($5, monthly_salary),
         is_active      = COALESCE($6, is_active),
         otp_hash       = CASE WHEN $7::BOOLEAN THEN NULL ELSE otp_hash END,
         otp_expires_at = CASE WHEN $7::BOOLEAN THEN NULL ELSE otp_expires_at END,
         otp_attempts   = CASE WHEN $7::BOOLEAN THEN 0 ELSE otp_attempts END
       WHERE id = $1
       RETURNING id, name, phone, monthly_salary, is_active, started_on, role_id`,
      [req.params.id, body.name ?? null, phone, roleId,
       body.monthlySalary ?? null, body.isActive ?? null, phoneChanged]
    );

    await writeAudit(client, {
      actorType: "employee", actorId: req.actor.id, actorName: req.actor.name,
      action: "employee.updated", entityType: "employee", entityId: req.params.id,
      entityLabel: rows[0].name, before: stripSecrets(prev), after: rows[0], ip: req.ip,
    });
    return rows[0];
  });

  invalidateAuthCache("employee", req.params.id);
  res.json(updated);
}));

// "حذف" الموظف = تعطيله، عشان جداول attendance وemployee_reviews مربوطة بـ employee_id
employeeRouter.delete("/:id", requirePermission("employees.manage"), asyncRoute(async (req, res) => {
  if (req.params.id === req.actor.id) throw new ApiError(403, "لا يمكنك تعطيل حسابك بنفسك");
  const callerPerms = await getEffectivePermissionCodes(req.actor.id);
  await assertCanManageTarget(callerPerms, req.params.id);

  const result = await withTransaction(async (client) => {
    const before = await client.query(`SELECT * FROM employees WHERE id = $1 FOR UPDATE`, [req.params.id]);
    if (!before.rows.length) throw new ApiError(404, "الموظف غير موجود");
    if (before.rows[0].is_active) await assertNotLastGeneralManager(client, req.params.id);

    const { rows } = await client.query(
      `UPDATE employees SET is_active = FALSE WHERE id = $1 RETURNING id, name, is_active`,
      [req.params.id]
    );

    await writeAudit(client, {
      actorType: "employee", actorId: req.actor.id, actorName: req.actor.name,
      action: "employee.deactivated", entityType: "employee", entityId: req.params.id,
      entityLabel: before.rows[0].name, before: stripSecrets(before.rows[0]), after: rows[0], ip: req.ip,
    });
    return rows[0];
  });

  invalidateAuthCache("employee", req.params.id);
  res.json(result);
}));


// كل الصلاحيات المعرّفة بالمنظومة — تُستخدم لبناء قائمة checkboxes في شاشة
// "الصلاحيات الفردية" بلوحة الإدارة
employeeRouter.get("/permissions", requirePermission("employees.manage"), asyncRoute(async (_req, res) => {
  const { rows } = await query(`SELECT id, code, description FROM permissions ORDER BY description`);
  res.json(rows);
}));

// صلاحيات موظف معيّن: صلاحيات دوره الأساسية + أي استثناءات فردية مضافة له بعينه
employeeRouter.get("/:id/permissions", requirePermission("employees.manage"), asyncRoute(async (req, res) => {
  const emp = await query(
    `SELECT e.id, e.name, r.code AS role_code, r.name AS role_name
       FROM employees e JOIN roles r ON r.id = e.role_id WHERE e.id = $1`,
    [req.params.id]
  );
  if (!emp.rows.length) throw new ApiError(404, "الموظف غير موجود");

  const all = await query(`SELECT id, code, description FROM permissions ORDER BY description`);
  const roleGranted = await query(
    `SELECT p.code FROM role_permissions rp
       JOIN permissions p ON p.id = rp.permission_id
       JOIN employees e ON e.role_id = rp.role_id
      WHERE e.id = $1`,
    [req.params.id]
  );
  const overrides = await query(
    `SELECT p.code, ovr.granted FROM employee_permission_overrides ovr
       JOIN permissions p ON p.id = ovr.permission_id
      WHERE ovr.employee_id = $1`,
    [req.params.id]
  );

  res.json({
    employee: emp.rows[0],
    permissions: all.rows,
    roleGrantedCodes: roleGranted.rows.map((r) => r.code),
    overrides: Object.fromEntries(overrides.rows.map((o) => [o.code, o.granted])),
  });
}));

// تحديث الاستثناءات الفردية لموظف: كل عنصر إما true (منح إضافي فوق دوره)،
// false (سحب صلاحية كانت متاحة له عبر دوره)، أو null (إلغاء أي استثناء والرجوع لوضع دوره الافتراضي)
employeeRouter.patch("/:id/permissions", requirePermission("employees.manage"), asyncRoute(async (req, res) => {
  const body = z.object({
    overrides: z.array(z.object({
      permissionCode: z.string(),
      granted: z.boolean().nullable(),
    })),
  }).parse(req.body);

  // الموظف ما يعدّل صلاحياته الفردية بنفسه، ولا يمنح صلاحية لا يملكها
  if (req.params.id === req.actor.id) throw new ApiError(403, "لا يمكنك تعديل صلاحياتك بنفسك");
  const callerPerms = await getEffectivePermissionCodes(req.actor.id);
  await assertCanManageTarget(callerPerms, req.params.id);
  const targetRoleCodes = new Set((await query(
    `SELECT p.code FROM employees e
       JOIN role_permissions rp ON rp.role_id = e.role_id
       JOIN permissions p ON p.id = rp.permission_id
      WHERE e.id = $1`, [req.params.id])).rows.map((r) => r.code));
  for (const o of body.overrides) {
    // منح صراحةً، أو إلغاء استثناء سحب كان يمنع صلاحية الدور = منح فعلي
    const effectivelyGrants = o.granted === true || (o.granted === null && targetRoleCodes.has(o.permissionCode));
    if (effectivelyGrants && !callerPerms.has(o.permissionCode)) {
      throw new ApiError(403, "لا يمكنك منح صلاحية لا تملكها أنت");
    }
  }

  const result = await withTransaction(async (client) => {
    const emp = await client.query(`SELECT * FROM employees WHERE id = $1 FOR UPDATE`, [req.params.id]);
    if (!emp.rows.length) throw new ApiError(404, "الموظف غير موجود");

    for (const o of body.overrides) {
      const perm = await client.query(`SELECT id FROM permissions WHERE code = $1`, [o.permissionCode]);
      if (!perm.rows.length) continue;
      const permissionId = perm.rows[0].id;

      if (o.granted === null) {
        await client.query(
          `DELETE FROM employee_permission_overrides WHERE employee_id = $1 AND permission_id = $2`,
          [req.params.id, permissionId]
        );
      } else {
        await client.query(
          `INSERT INTO employee_permission_overrides (employee_id, permission_id, granted)
           VALUES ($1,$2,$3)
           ON CONFLICT (employee_id, permission_id) DO UPDATE SET granted = $3`,
          [req.params.id, permissionId, o.granted]
        );
      }
    }

    await writeAudit(client, {
      actorType: "employee", actorId: req.actor.id, actorName: req.actor.name,
      action: "employee.permissions_updated", entityType: "employee", entityId: req.params.id,
      entityLabel: emp.rows[0].name, after: { overrides: body.overrides }, ip: req.ip,
    });

    const overrides = await client.query(
      `SELECT p.code, ovr.granted FROM employee_permission_overrides ovr
         JOIN permissions p ON p.id = ovr.permission_id
        WHERE ovr.employee_id = $1`,
      [req.params.id]
    );
    return Object.fromEntries(overrides.rows.map((o) => [o.code, o.granted]));
  });

  invalidateAuthCache("employee", req.params.id);
  res.json({ overrides: result });
}));

// نطاق الأقسام المخصّص لموظف — لو رجّع sectionIds فاضية يبقى الموظف غير مقيّد
// (يشتغل على كل الأقسام زي أي موظف عادي)
employeeRouter.get("/:id/section-scope", requirePermission("employees.manage"), asyncRoute(async (req, res) => {
  const emp = await query(`SELECT id, name FROM employees WHERE id = $1`, [req.params.id]);
  if (!emp.rows.length) throw new ApiError(404, "الموظف غير موجود");

  const scope = await query(
    `SELECT s.id, s.name FROM employee_section_scope ess
       JOIN sections s ON s.id = ess.section_id
      WHERE ess.employee_id = $1
      ORDER BY s.sort_order`,
    [req.params.id]
  );
  res.json({ employee: emp.rows[0], sections: scope.rows });
}));

// تحديث نطاق الأقسام: sectionIds فاضية = إلغاء التقييد بالكامل (يرجع موظف عادي غير مقيّد)
employeeRouter.patch("/:id/section-scope", requirePermission("employees.manage"), asyncRoute(async (req, res) => {
  const { sectionIds } = z.object({ sectionIds: z.array(z.string().uuid()).max(500) }).parse(req.body);

  // ما يعدّل نطاقه بنفسه، وموظف مقيّد ما يقدر يوسّع/يلغي التقييد ولا يمنح أقسامًا خارج نطاقه
  if (req.params.id === req.actor.id) throw new ApiError(403, "لا يمكنك تعديل نطاق أقسامك بنفسك");
  const callerPerms = await getEffectivePermissionCodes(req.actor.id);
  await assertCanManageTarget(callerPerms, req.params.id);
  const callerScope = await getEmployeeSectionScope(req.actor.id);
  if (callerScope !== null && (!sectionIds.length || !sectionIds.every((id) => callerScope.has(id)))) {
    throw new ApiError(403, "لا تملك صلاحية على أحد الأقسام المطلوبة");
  }

  const result = await withTransaction(async (client) => {
    const emp = await client.query(`SELECT * FROM employees WHERE id = $1 FOR UPDATE`, [req.params.id]);
    if (!emp.rows.length) throw new ApiError(404, "الموظف غير موجود");

    await client.query(`DELETE FROM employee_section_scope WHERE employee_id = $1`, [req.params.id]);
    for (const sectionId of sectionIds) {
      await client.query(
        `INSERT INTO employee_section_scope (employee_id, section_id, assigned_by) VALUES ($1,$2,$3)`,
        [req.params.id, sectionId, req.actor.id]
      );
    }

    await writeAudit(client, {
      actorType: "employee", actorId: req.actor.id, actorName: req.actor.name,
      action: "employee.section_scope_updated", entityType: "employee", entityId: req.params.id,
      entityLabel: emp.rows[0].name, after: { sectionIds }, ip: req.ip,
    });

    const scope = await client.query(
      `SELECT s.id, s.name FROM employee_section_scope ess
         JOIN sections s ON s.id = ess.section_id
        WHERE ess.employee_id = $1
        ORDER BY s.sort_order`,
      [req.params.id]
    );
    return scope.rows;
  });

  res.json({ sections: result });
}));

employeeRouter.post("/:id/attendance", requirePermission("employees.manage"), asyncRoute(async (req, res) => {
  const body = z.object({
    workDate: z.string(),
    checkIn: z.string().optional(),
    checkOut: z.string().optional(),
    status: z.enum(["present", "absent", "leave", "holiday"]).default("present"),
    note: z.string().optional(),
  }).parse(req.body);

  const hours = body.checkIn && body.checkOut
    ? (new Date(body.checkOut) - new Date(body.checkIn)) / 3_600_000
    : null;

  const { rows } = await query(
    `INSERT INTO attendance (employee_id, work_date, check_in, check_out, hours_worked, status, note)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (employee_id, work_date) DO UPDATE SET
       check_in = $3, check_out = $4, hours_worked = $5, status = $6, note = $7
     RETURNING *`,
    [req.params.id, body.workDate, body.checkIn ?? null, body.checkOut ?? null,
     hours, body.status, body.note ?? null]
  );
  res.status(201).json(rows[0]);
}));

employeeRouter.get("/:id/attendance", requirePermission("employees.manage"), asyncRoute(async (req, res) => {
  const { from, to } = req.query;
  const pg = pageParams(req, 400);
  const { rows } = await query(
    `SELECT * FROM attendance
      WHERE employee_id = $1
        AND ($2::DATE IS NULL OR work_date >= $2)
        AND ($3::DATE IS NULL OR work_date <= $3)
      ORDER BY work_date DESC
      LIMIT $4 OFFSET $5`,
    [req.params.id, from || null, to || null, pg.limit, pg.offset]
  );
  res.json(rows);
}));

employeeRouter.post("/:id/reviews", requirePermission("employees.manage"), asyncRoute(async (req, res) => {
  const body = z.object({
    periodStart: z.string(), periodEnd: z.string(),
    tasksCompleted: z.number().int().nonnegative().default(0),
    ordersHandled: z.number().int().nonnegative().default(0),
    efficiencyScore: z.number().min(0).max(10).optional(),
    systemUsageScore: z.number().min(0).max(10).optional(),
    strengths: z.string().optional(),
    weaknesses: z.string().optional(),
    trainingNeeded: z.string().optional(),
  }).parse(req.body);

  const { rows } = await query(
    `INSERT INTO employee_reviews
       (employee_id, period_start, period_end, tasks_completed, orders_handled,
        efficiency_score, system_usage_score, strengths, weaknesses, training_needed, reviewed_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
    [req.params.id, body.periodStart, body.periodEnd, body.tasksCompleted, body.ordersHandled,
     body.efficiencyScore ?? null, body.systemUsageScore ?? null, body.strengths ?? null,
     body.weaknesses ?? null, body.trainingNeeded ?? null, req.actor.id]
  );
  res.status(201).json(rows[0]);
}));

employeeRouter.get("/:id/reviews", requirePermission("employees.manage"), asyncRoute(async (req, res) => {
  const pg = pageParams(req);
  const { rows } = await query(
    `SELECT * FROM employee_reviews WHERE employee_id = $1 ORDER BY period_end DESC LIMIT $2 OFFSET $3`,
    [req.params.id, pg.limit, pg.offset]
  );
  res.json(rows);
}));
