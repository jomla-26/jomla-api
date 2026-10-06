-- شكاوي المندوبين (تكت على الطلبية) — يُشغَّل مرّة وحدة في Supabase → SQL Editor (مشروع جملة)
-- آمن للتكرار (IF NOT EXISTS)، ما يعدّل أي جدول موجود.
CREATE TABLE IF NOT EXISTS public.order_driver_complaints (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id    UUID NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
  driver_id   UUID NOT NULL REFERENCES public.employees(id),
  kind        TEXT NOT NULL CHECK (kind IN
              ('not_delivered','customer_unreachable','wrong_address','customer_refused','supplier_issue','other')),
  note        TEXT,
  status      TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  admin_note  TEXT,
  closed_by   UUID,
  closed_at   TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS order_driver_complaints_order_idx ON public.order_driver_complaints (order_id, created_at DESC);
CREATE INDEX IF NOT EXISTS order_driver_complaints_open_idx  ON public.order_driver_complaints (status) WHERE status = 'open';
