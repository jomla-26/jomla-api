-- صلاحية جديدة: سحب طلبية من مندوب وإسنادها لمندوب آخر (حالات الطوارئ)
INSERT INTO permissions (code, description) VALUES
 ('orders.reassign_driver', 'سحب الطلبية من مندوب وإسنادها لمندوب آخر (طارئ)')
ON CONFLICT (code) DO NOTHING;

-- نعطيها للمدير العام تلقائيًا؛ باقي الموظفين تعطيهم إياها من شاشة الموظفين
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r JOIN permissions p ON p.code = 'orders.reassign_driver'
WHERE r.code = 'general_manager'
ON CONFLICT DO NOTHING;
