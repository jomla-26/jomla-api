// بحث مرن بالكلمات: كل كلمة تُطابَق كجزء من اسم الصنف بأي ترتيب (مثل "خلا لون" → "خلاط دوش لونا").
// الدرجة الثانية (relaxed) تقصّ كل كلمة طويلة لأول 3 حروف لتغطية أخطاء الكتابة في آخر الكلمة.
const DIAC = /[ً-ْـ]/g;

export function normalizeAr(s) {
  return String(s ?? "")
    .toLowerCase()
    .replace(DIAC, "")
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ئ/g, "ي")
    .replace(/ؤ/g, "و")
    .replace(/ة/g, "ه")
    .replace(/\s+/g, " ")
    .trim();
}

// null لو ما فيه نص بحث. relaxed: يقصّ الكلمات الأطول من 3 حروف إلى 3 (و5+ حروف إلى 3 فقط).
export function searchTokens(search, relaxed = false) {
  const n = normalizeAr(search);
  if (!n) return null;
  let toks = n.split(" ").filter(Boolean).slice(0, 8);
  if (relaxed) toks = toks.map((t) => (t.length >= 5 ? t.slice(0, 3) : t.length >= 3 ? t.slice(0, 2) : t));
  return toks;
}

// تعبير SQL للنص بعد التطبيع (نفس قواعد normalizeAr تقريبًا). expr عمود/تعبير ثابت من الكود.
export function sqlNorm(expr) {
  return `translate(lower(${expr}), 'أإآٱىئؤةـ', 'ااااييوه')`;
}
