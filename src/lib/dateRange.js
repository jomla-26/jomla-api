// فلترة بالتاريخ (من/إلى) — عقد موحّد لكل نقاط الـAPI
// from / to بصيغة YYYY-MM-DD، شاملة للطرفين، والأيام بتوقيت ليبيا (Africa/Tripoli).
import { ApiError } from "./helpers.js";

export const RANGE_TZ = "Africa/Tripoli";
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

// يتأكد إن النص تاريخ حقيقي (مثلًا 2026-02-30 مرفوض)
function validDate(s) {
  const m = DATE_RE.exec(s);
  if (!m) return false;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

function readOne(v, label) {
  if (v === undefined || v === null || v === "") return null;
  if (typeof v !== "string" || !validDate(v)) {
    throw new ApiError(400, `تاريخ "${label}" غير صالح، الصيغة المطلوبة YYYY-MM-DD`);
  }
  return v;
}

// يقرأ from/to من req.query. بدون أي واحد منهم => {from:null, to:null}
export function parseRange(q) {
  const query = q || {};
  const from = readOne(query.from, "من");
  const to = readOne(query.to, "إلى");
  if (from && to && from > to) {
    throw new ApiError(400, "تاريخ البداية بعد تاريخ النهاية");
  }
  return { from, to };
}

export const hasRange = (range) => !!(range && (range.from || range.to));

// يضيف شروط SQL للعمود (timestamptz أو date) ويدفع القيم في params.
// col تعبير SQL ثابت من الكود (مو من المستخدم). تُرجع conds نفسها.
export function addRange(col, range, params, conds) {
  if (range?.from) {
    params.push(range.from);
    conds.push(`((${col}) AT TIME ZONE '${RANGE_TZ}')::date >= $${params.length}::date`);
  }
  if (range?.to) {
    params.push(range.to);
    conds.push(`((${col}) AT TIME ZONE '${RANGE_TZ}')::date <= $${params.length}::date`);
  }
  return conds;
}

// نسخة للأعمدة من نوع DATE (بدون منطقة زمنية)، مثل expense_date / sold_on
export function addDateColRange(col, range, params, conds) {
  if (range?.from) {
    params.push(range.from);
    conds.push(`(${col})::date >= $${params.length}::date`);
  }
  if (range?.to) {
    params.push(range.to);
    conds.push(`(${col})::date <= $${params.length}::date`);
  }
  return conds;
}

// " AND a AND b" أو "" — للّصق في نهاية WHERE موجود
export const andClause = (conds) => (conds.length ? " AND " + conds.join(" AND ") : "");

const dayFmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: RANGE_TZ, year: "numeric", month: "2-digit", day: "2-digit",
});

// تحويل قيمة تاريخ/وقت (Date أو نص) ليوم ليبيا YYYY-MM-DD (null لو فاضي/غير صالح)
export function tripoliDay(v) {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "string" && DATE_RE.test(v)) return v;
  const d = v instanceof Date ? v : new Date(v);
  if (Number.isNaN(d.getTime())) return null;
  return dayFmt.format(d);
}

const toCents = (n) => Math.round(Number(n || 0) * 100);
const fromCents = (c) => c / 100;

export const OPENING_LABEL = "رصيد سابق (قبل الفترة)";

// كشف حساب بحدود زمنية. rows مرتّبة زمنيًا ومعها الحقول المالية.
//  mode "debit-credit": الرصيد = مدين − دائن (عميل)
//  mode "credit-debit": الرصيد = دائن − مدين (مورد)
//  mode "in-out":       الرصيد = وارد − صادر (محفظة المندوب) بالحقول in_amount/out_amount
// بدون from/to: نفس الصفوف مع رصيد جارٍ (السلوك القديم).
// مع from: صف افتتاحي is_opening في الأول والرصيد يكمل منه. to يقطع الصفوف فقط.
export function buildLedger(rows, range, mode, extra = {}) {
  const sides = {
    "debit-credit": ["debit", "credit", 1],
    "credit-debit": ["debit", "credit", -1],
    "in-out": ["in_amount", "out_amount", 1],
  }[mode];
  if (!sides) throw new Error("buildLedger: unknown mode " + mode);
  const [dKey, cKey] = sides;
  // الاتجاه: الرصيد = (positiveKey − negativeKey)
  const [posKey, negKey] = mode === "credit-debit" ? ["credit", "debit"] : [dKey, cKey];
  const delta = (r) => toCents(r[posKey]) - toCents(r[negKey]);

  const { from, to } = range || {};
  let openingC = 0;
  let runC = 0;
  const out = [];
  for (const r of rows) {
    const day = from || to ? tripoliDay(r.entry_date) : null;
    if (from || to) {
      if (!day) continue; // بدون تاريخ لا يمكن وضعه داخل فترة محددة
      if (from && day < from) { openingC += delta(r); continue; }
      if (to && day > to) continue;
    }
    out.push(r);
  }
  runC = openingC;
  const body = out.map((r) => {
    runC += delta(r);
    return { ...r, balance: fromCents(runC) };
  });
  // بدون from: لا صف افتتاحي (والـto فقط يقطع)
  if (!from) return body;

  const opening = {
    ...extra,
    is_opening: true,
    entry_date: from,
    label: OPENING_LABEL,
    reference: "",
    voucher_number: null,
    [posKey]: openingC >= 0 ? fromCents(openingC) : 0,
    [negKey]: openingC < 0 ? fromCents(-openingC) : 0,
    balance: fromCents(openingC),
  };
  return [opening, ...body];
}
