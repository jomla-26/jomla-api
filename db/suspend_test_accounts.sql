-- إخفاء حسابات التجربة (لا يحذف شي): يوقف الحسابات ويخفي أصنافها. للرجوع غيّر القيم يدويًا.
UPDATE customers SET status = 'suspended' WHERE phone LIKE '09002%';
UPDATE suppliers SET status = 'suspended' WHERE phone LIKE '09001%';
UPDATE employees SET is_active = false   WHERE phone LIKE '0900%';
UPDATE products  SET is_active = false   WHERE supplier_id IN (SELECT id FROM suppliers WHERE phone LIKE '09001%');
