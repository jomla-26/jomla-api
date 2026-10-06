-- يسمح بإشعارات داخل التطبيق بدون قالب (مثل: إسناد طلبية للمندوب، فروقات تسوية العهدة...). آمن ومتكرر.
ALTER TABLE notifications ALTER COLUMN template_code DROP NOT NULL;
