-- حسابات تجربة وهمية للضغط على المنظومة (أرقامها تبدأ بـ 0900 — غير حقيقية، فما تنبعتش لها رسائل واتساب فعلية)
-- كلها بكود دخول ثابت لما تضيف في Railway المتغيرين TEST_OTP_CODE و TEST_OTP_PHONES (انظر الشرح).
-- آمنة للتكرار: لو شغلتها مرتين ما تكرّر شي.
--   موردين:   0900100001 .. 0900100012
--   عملاء:    0900200001 .. 0900200040
--   مناديب:   0900300001 .. 0900300010
--   مسؤولي طلبيات: 0900400001 .. 0900400003 | محاسب: 0900500001 | كتالوج: 0900600001 | مدير: 0900700001
DO $$
DECLARE i int; j int; sid uuid; cid uuid; roots uuid[]; allsecs uuid[]; sec uuid; root uuid;
BEGIN
  SELECT array_agg(id) INTO roots   FROM sections WHERE parent_id IS NULL AND is_active;
  SELECT array_agg(id) INTO allsecs FROM sections WHERE is_active;
  IF roots IS NULL THEN RAISE EXCEPTION 'ما فيش أقسام فعّالة — أنشئ قسم واحد على الأقل أولًا'; END IF;

  FOR i IN 1..12 LOOP
    IF NOT EXISTS (SELECT 1 FROM suppliers WHERE phone = '09001'||lpad(i::text,5,'0')) THEN
      INSERT INTO suppliers(business_name, phone, status, commission_rate_percent)
      VALUES ('تجربة • مورد '||i, '09001'||lpad(i::text,5,'0'), 'approved', 5) RETURNING id INTO sid;
      INSERT INTO supplier_sections(supplier_id, section_id, enabled) SELECT sid, r, true FROM unnest(roots) r;
      FOR j IN 1..10 LOOP
        sec := allsecs[1 + ((i + j) % array_length(allsecs,1))];
        INSERT INTO products(section_id, supplier_id, name, unit, base_price, purchase_cost, stock_qty, availability, is_active, approval_status, supplier_sku)
        VALUES (sec, sid, 'تجربة • صنف '||i||'-'||j, 'قطعة', 10 + j, 7 + j, 500, 'available', true, 'approved', 'T'||i||'-'||j);
      END LOOP;
    END IF;
  END LOOP;

  FOR i IN 1..40 LOOP
    IF NOT EXISTS (SELECT 1 FROM customers WHERE phone = '09002'||lpad(i::text,5,'0')) THEN
      INSERT INTO customers(business_name, phone, status) VALUES ('تجربة • عميل '||i, '09002'||lpad(i::text,5,'0'), 'approved') RETURNING id INTO cid;
      INSERT INTO customer_sections(customer_id, section_id, enabled) SELECT cid, r, true FROM unnest(roots) r;
    END IF;
  END LOOP;

  FOR i IN 1..10 LOOP
    IF NOT EXISTS (SELECT 1 FROM employees WHERE phone = '09003'||lpad(i::text,5,'0')) THEN
      INSERT INTO employees(name, phone, role_id, is_active) VALUES ('تجربة • مندوب '||i, '09003'||lpad(i::text,5,'0'), (SELECT id FROM roles WHERE code='driver'), true);
    END IF;
  END LOOP;
  FOR i IN 1..3 LOOP
    IF NOT EXISTS (SELECT 1 FROM employees WHERE phone = '09004'||lpad(i::text,5,'0')) THEN
      INSERT INTO employees(name, phone, role_id, is_active) VALUES ('تجربة • مسؤول طلبيات '||i, '09004'||lpad(i::text,5,'0'), (SELECT id FROM roles WHERE code='order_manager'), true);
    END IF;
  END LOOP;
  INSERT INTO employees(name, phone, role_id, is_active)
  SELECT v.n, v.p, (SELECT id FROM roles WHERE code = v.c), true
    FROM (VALUES ('تجربة • محاسب','0900500001','accountant'),('تجربة • مسؤول كتالوج','0900600001','catalog_manager'),('تجربة • مدير','0900700001','general_manager')) v(n,p,c)
   WHERE NOT EXISTS (SELECT 1 FROM employees e WHERE e.phone = v.p);
END $$;

-- القائمة الجاهزة للصق في Railway ← TEST_OTP_PHONES (كل أرقام التجربة)
SELECT string_agg(phone, ',' ORDER BY phone) AS "TEST_OTP_PHONES"
  FROM (SELECT phone FROM suppliers WHERE phone LIKE '09001%'
        UNION ALL SELECT phone FROM customers WHERE phone LIKE '09002%'
        UNION ALL SELECT phone FROM employees WHERE phone LIKE '0900%') x;
