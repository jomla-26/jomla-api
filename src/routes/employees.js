import { Router } from "express";
import { z } from "zod";
import { query, withTransaction, writeAudit } from "../lib/db.js";
import { ApiError, asyncRoute } from "../lib/helpers.js";
import { authenticate, requirePermission, requireAnyPermission } from "../middleware/auth.js";

export const employeeRouter = Router();
employeeRouter.use(authenticate);

employeeRouter.get("/roles", asyncRoute(async (_req, res) => {
  const { rows } = await query(`SELECT code, name FROM roles ORDER BY name`);
  res.json(rows);
}));

employeeRouter.get("/", requireAnyPermission("employees.manage", "finance.salaries"), asyncRoute(async (req, res) => {
  const { status } = req.query; // "active" (افتراضي) | "inactive" | "all"
  const activeFilter = status === "inactive" ? "NOT e.is_active"
    : status === "all" ? "TRUE"
    : "e.is_active";

  const { rows } = await query(
    `SELECT e.id, e.name, e.phone, e.monthly_salary, e.started_on, e.last_login_at, e.is_active,
            r.code AS role_code, r.name AS role_name
       FROM employees e JOIN roles r ON r.id = e.role_id
      WHERE ${activeFilter}
      ORDER BY e.name`
  );
  res.json(rows);
}));

const createSchema = z.object({
  name: z.string().min(2),
  phone: z.string().min(9),
  roleCode: z.string(),
  monthlySalary: z.number().nonnegative(),
});

employeeRouter.post("/", requirePermission("employees.manage"), asyncRoute(async (req, res) => {
  const body = createSchema.parse(req.body);

  const employee = await withTransaction(async (client) => {
    const role = await client.query(`SELECT id, name FROM roles WHERE code = $1`, [body.roleCode]);
    if (!role.rows.length) throw new ApiError(400, "الوظيفة غير معروفة");

    const { rows } = await client.query(
      `INSERT INTO employees (name, phone, role_id, monthly_salary)
       VALUES ($1,$2,$3,$4) RETURNING id, name, phone, monthly_salary, started_on`,
      [body.name, body.phone, role.rows[0].id, body.monthlySalary]
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
    name: z.string().min(2).optional(),
    phone: z.string().min(9).optional(),
    roleCode: z.string().optional(),
    monthlySalary: z.number().nonnegative().optional(),
    isActive: z.boolean().optional(),
  }).parse(req.body);

  if (Object.keys(body).length === 0) {
    throw new ApiError(400, "لا توجد بيانات للتعديل");
  }

  const updated = await withTransaction(async (client) => {
    const before = await client.query(
      `SELECT e.*, r.code AS role_code FROM employees e JOIN roles r ON r.id = e.role_id WHERE e.id = $1 FOR UPDATE`,
      [req.params.id]
    );
    if (!before.rows.length) throw new ApiError(404, "الموظف غير موجود");

    let roleId = before.rows[0].role_id;
    if (body.roleCode) {
      const role = await client.query(`SELECT id FROM roles WHERE code = $1`, [body.roleCode]);
      if (!role.rows.length) throw new ApiError(400, "الوظيفة غير معروفة");
      roleId = role.rows[0].id;
    }

    const { rows } = await client.query(
      `UPDATE employees SET
         name           = COALESCE($2, name),
         phone          = COALESCE($3, phone),
         role_id        = $4,
         monthly_salary = COALESCE($5, monthly_salary),
         is_active      = COALESCE($6, is_active)
       WHERE id = $1
       RETURNING id, name, phone, monthly_salary, is_active, started_on, role_id`,
      [req.params.id, body.name ?? null, body.phone ?? null, roleId,
       body.monthlySalary ?? null, body.isActive ?? null]
    );

    await writeAudit(client, {
      actorType: "employee", actorId: req.actor.id, actorName: req.actor.name,
      action: "employee.updated", entityType: "employee", entityId: req.params.id,
      entityLabel: rows[0].name, before: before.rows[0], after: rows[0], ip: req.ip,
    });
    return rows[0];
  });

  res.json(updated);
}));

// "حذف" الموظف = تعطيله، عشان جداول attendance وemployee_reviews مربوطة بـ employee_id
employeeRouter.delete("/:id", requirePermission("employees.manage"), asyncRoute(async (req, res) => {
  const result = await withTransaction(async (client) => {
    const before = await client.query(`SELECT * FROM employees WHERE id = $1 FOR UPDATE`, [req.params.id]);
    if (!before.rows.length) throw new ApiError(404, "الموظف غير موجود");

    const { rows } = await client.query(
      `UPDATE employees SET is_active = FALSE WHERE id = $1 RETURNING id, name, is_active`,
      [req.params.id]
    );

    await writeAudit(client, {
      actorType: "employee", actorId: req.actor.id, actorName: req.actor.name,
      action: "employee.deactivated", entityType: "employee", entityId: req.params.id,
      entityLabel: before.rows[0].name, before: before.rows[0], after: rows[0], ip: req.ip,
    });
    return rows[0];
  });

  res.json(result);
}));


// كل الصلاحيات المعرّفة بالمنظومة — تُستخدم لبناء قائمة checkboxes في شاشة
// "الصلاحيات الفردية" بلوحة الإدارة
employeeRouter.get("/permissions", requirePermission("employees.manage"), asyncRoute(async (_req, res) => {
  const { rows } = await query(`SELECT id, code, name FROM permissions ORDER BY name`);
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

  const all = await query(`SELECT id, code, name FROM permissions ORDER BY name`);
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
          `INSERT INTO employee_permission_overrides (employee_id, permission_id, granted, assigned_by)
           VALUES ($1,$2,$3,$4)
           ON CONFLICT (employee_id, permission_id) DO UPDATE SET granted = $3, assigned_by = $4`,
          [req.params.id, permissionId, o.granted, req.actor.id]
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

  res.json({ overrides: result });
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
  const { rows } = await query(
    `SELECT * FROM attendance
      WHERE employee_id = $1
        AND ($2::DATE IS NULL OR work_date >= $2)
        AND ($3::DATE IS NULL OR work_date <= $3)
      ORDER BY work_date DESC`,
    [req.params.id, from || null, to || null]
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
  const { rows } = await query(
    `SELECT * FROM employee_reviews WHERE employee_id = $1 ORDER BY period_end DESC`, [req.params.id]
  );
  res.json(rows);
}));
