// تهيئة بيانات أولية آمنة وقابلة للتكرار (idempotent) — تُستدعى مرة واحدة بعد إقلاع السيرفر.
// - DDL: جدول banner_sections (يُنشأ كسولًا أيضًا من مسار البانرات عبر ensureBannerSections)
// - المهام لمرة واحدة محروسة بجدول app_state (مفتاح bootstrap:<job>) + قفل استشاري، وكل مهمة بمعاملة واحدة
// - أي خطأ/اختلاف في المخطط يُسجَّل وتُتخطّى المهمة (تُعاد المحاولة في الإقلاع التالي) — لا يوقف السيرفر أبدًا
import { pool, withTransaction } from "./db.js";

const BASE_URL = "https://jomla-customer-beta.vercel.app";
const log = (...a) => console.log("[bootstrap]", ...a);

/* ------------------------------ أدوات عامة ------------------------------ */

// توحيد الحروف العربية للمطابقة (همزات، ى/ي، ة/ه، تشكيل)
function norm(s) {
  return String(s ?? "")
    .toLowerCase()
    .replace(/[ً-ْـ]/g, "")
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/\s+/g, " ")
    .trim();
}

// regex لكلمات تبدأ عند حدّ كلمة (مع "ال" اختيارية). المصدر يُوحَّد تلقائيًا
function wordRe(src) {
  return new RegExp(`(?:^|\\s)(?:ال)?(?:${norm(src)})`);
}

async function getColumns(client, table) {
  const { rows } = await client.query(
    `SELECT column_name, data_type, is_nullable, column_default
       FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = $1`,
    [table]
  );
  const m = new Map();
  for (const r of rows) m.set(r.column_name, r);
  return m; // فاضية = الجدول غير موجود
}

function hasCols(cols, names) {
  return names.every((n) => cols.has(n));
}

function sqlType(dataType) {
  switch (dataType) {
    case "uuid": return "UUID";
    case "integer": return "INTEGER";
    case "bigint": return "BIGINT";
    case "smallint": return "SMALLINT";
    default: return "TEXT";
  }
}

// إعداد إدراج صف: id تلقائي لو ما له default (uuid فقط)، وcreated_by لو العمود إجباري
async function insertContext(client, table, cols) {
  const ctx = { extraCols: [], extraVals: [] };
  const idCol = cols.get("id");
  if (idCol && !idCol.column_default) {
    if (idCol.data_type === "uuid") { ctx.extraCols.push("id"); ctx.extraVals.push("gen_random_uuid()"); }
    else throw new Error(`${table}.id بلا قيمة افتراضية ونوعه ${idCol.data_type}`);
  }
  const cb = cols.get("created_by");
  if (cb && cb.is_nullable === "NO") {
    const { rows } = await client.query(`SELECT id FROM employees WHERE is_active ORDER BY id LIMIT 1`);
    if (!rows.length) throw new Error(`${table}.created_by إجباري ولا يوجد موظف`);
    ctx.createdBy = rows[0].id;
  }
  return ctx;
}

async function insertRow(client, table, ctx, colNames, values) {
  const cols = [...colNames];
  const places = values.map((_, i) => `$${i + 1}`);
  const vals = [...values];
  for (let i = 0; i < ctx.extraCols.length; i++) { cols.push(ctx.extraCols[i]); places.push(ctx.extraVals[i]); }
  if (ctx.createdBy !== undefined) { cols.push("created_by"); vals.push(ctx.createdBy); places.push(`$${vals.length}`); }
  const { rows } = await client.query(
    `INSERT INTO ${table} (${cols.join(", ")}) VALUES (${places.join(", ")}) RETURNING id`,
    vals
  );
  return rows[0].id;
}

/* ------------------------- DDL: banner_sections ------------------------- */

let ensurePromise = null;

async function createBannerSections() {
  const client = await pool.connect();
  try {
    const banners = await getColumns(client, "promo_banners");
    const sections = await getColumns(client, "sections");
    if (!banners.has("id") || !sections.has("id")) throw new Error("promo_banners أو sections غير موجود");
    const bt = sqlType(banners.get("id").data_type);
    const st = sqlType(sections.get("id").data_type);
    try {
      await client.query(
        `CREATE TABLE IF NOT EXISTS banner_sections (
           banner_id  ${bt} NOT NULL REFERENCES promo_banners(id) ON DELETE CASCADE,
           section_id ${st} NOT NULL REFERENCES sections(id) ON DELETE CASCADE,
           PRIMARY KEY (banner_id, section_id)
         )`
      );
    } catch (e) {
      // سباق إنشاء بين عمليتين: الجدول صار موجودًا
      if (!["42P07", "23505", "42710"].includes(e?.code)) throw e;
    }
    await client.query(`CREATE INDEX IF NOT EXISTS idx_banner_sections_section ON banner_sections (section_id)`);
  } finally {
    client.release();
  }
}

// يُنشئ الجدول مرة واحدة لكل عملية (ويعيد المحاولة لو فشل)
export function ensureBannerSections() {
  if (!ensurePromise) {
    ensurePromise = createBannerSections().catch((e) => { ensurePromise = null; throw e; });
  }
  return ensurePromise;
}

/* ------------------------------ تشغيل المهام ------------------------------ */

async function runJob(name, fn) {
  const key = `bootstrap:${name}`;
  try {
    const result = await withTransaction(async (client) => {
      // سقف زمني: لا انتظار قفل ولا استعلام أبدي (يُرفع الخطأ فتُلغى المعاملة ويُحرَّر القفل تلقائيًا)
      await client.query(`SET LOCAL lock_timeout = '30s'`);
      await client.query(`SET LOCAL statement_timeout = '120s'`);
      await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [key]);
      const { rows } = await client.query(`SELECT value FROM app_state WHERE key = $1`, [key]);
      if (rows.length && String(rows[0].value).startsWith("done")) return { already: true };
      const out = (await fn(client)) || {};
      if (out.skipped) return out; // لا نسجّل الإنجاز — تُعاد المحاولة لاحقًا
      await client.query(
        `INSERT INTO app_state (key, value) VALUES ($1, $2)
           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
        [key, `done:${new Date().toISOString()}`]
      );
      return out;
    });
    if (result.already) log(`${name}: سبق تنفيذها`);
    else if (result.skipped) log(`${name}: تم التخطي — ${result.skipped}`);
    else log(`${name}: تمت`, JSON.stringify(result));
  } catch (e) {
    console.error(`[bootstrap] ${name}: فشلت (لا تأثير على السيرفر):`, e?.message || e);
  }
}

/* ------------------------------ تعريف الأقسام ------------------------------ */

// alias يُطابَق على الاسم بعد التوحيد (norm) — الترتيب مهم: أول مفتاح يحجز أول قسم مطابق
const MAIN = [
  { key: "food", name: "مواد غذائية", alias: /غذائيه|غذاء|تموين|اغذيه/ },
  { key: "building", name: "مواد بناء", alias: /بناء|مقاولات|انشائيه/ },
  { key: "sanitary", name: "أدوات صحية", alias: /ادوات صحيه|سباكه|صحيه|حمامات/ },
  { key: "electrical", name: "كهرباء", alias: /كهرب/ },
  { key: "cleaning", name: "منظفات", alias: /منظفات|نظافه|تنظيف/ },
  { key: "household", name: "أدوات منزلية", alias: /ادوات منزليه|مطبخ|منزليه/ },
  { key: "stationery", name: "قرطاسية", alias: /قرطاسيه|مكتبيه|ادوات مدرسيه/ },
  { key: "electronics", name: "إلكترونيات", alias: /الكترونيات|الكترونيه|هواتف/ },
  { key: "cosmetics", name: "عناية وتجميل", alias: /تجميل|عنايه|عطور/ },
  { key: "auto", name: "قطع غيار سيارات", alias: /سيارات|قطع غيار|سياره/ },
  { key: "medical", name: "مستلزمات طبية", alias: /طبيه|طبي|صيدليه|ادويه/ },
  { key: "cafe", name: "مقاهي ومطاعم", alias: /مقاهي|مطاعم|مقهي|كافيه/ },
];

const SUBS = {
  food: ["أرز وسكر ودقيق", "زيوت وسمن", "معلبات", "بقوليات وحبوب", "ألبان وأجبان", "مشروبات وعصائر", "حلويات وبسكويت", "توابل وبهارات", "معكرونة وشعيرية", "شاي وقهوة", "صلصات ومعجون طماطم"],
  building: ["إسمنت وخرسانة", "حديد وتسليح", "طوب وبلوك", "رمل وحصى", "دهانات", "عزل ومواد لاصقة", "أبواب ونوافذ", "أخشاب"],
  sanitary: ["أحواض وأطقم حمامات", "خلاطات", "مواسير وتوصيلات", "سخانات", "إكسسوارات حمام", "مضخات وخزانات"],
  electrical: ["أسلاك وكابلات", "مفاتيح وقوابس", "إضاءة", "قواطع ولوحات", "بطاريات ومولدات"],
  cleaning: ["منظفات أرضيات", "غسيل ملابس", "منظفات مطبخ وأطباق", "ورق ومناديل", "شامبو وعناية شخصية", "معقمات"],
  household: ["أواني وقدور", "بلاستيك وحافظات", "أجهزة صغيرة", "مفروشات", "أدوات مائدة"],
  stationery: ["دفاتر وأوراق", "أقلام وأدوات", "طابعات وأحبار", "حقائب مدرسية"],
  electronics: ["هواتف", "إكسسوارات هواتف", "شاشات وتلفزيونات", "شواحن وكابلات"],
  cosmetics: ["عطور", "مكياج", "عناية بالبشرة", "عناية بالشعر"],
  auto: ["إطارات", "زيوت محركات", "بطاريات سيارات", "إكسسوارات سيارات"],
  medical: ["مستهلكات طبية", "أجهزة طبية", "مكملات غذائية"],
  cafe: ["بن وقهوة", "مشروبات ساخنة", "أكواب وعلب تغليف", "معدات مقاهي"],
};

// مطابقة قسم/تصنيف موجود: key -> صف القسم الرئيسي
async function resolveMainSections(client) {
  const { rows } = await client.query(
    `SELECT id, name, sort_order, is_active, image_url FROM sections
      WHERE parent_id IS NULL ORDER BY is_active DESC, sort_order, name`
  );
  const map = new Map();
  const used = new Set();
  for (const def of MAIN) {
    const hit = rows.find((r) => !used.has(String(r.id)) && def.alias.test(norm(r.name)));
    if (hit) { map.set(def.key, hit); used.add(String(hit.id)); }
  }
  return { map, rows };
}

/* ------------------------------ المهمة (ب): الأقسام ------------------------------ */

async function seedSections(client) {
  const cols = await getColumns(client, "sections");
  if (!hasCols(cols, ["id", "name", "slug", "parent_id", "sort_order", "image_url", "is_active"])) {
    return { skipped: "مخطط sections مختلف" };
  }
  const ctx = await insertContext(client, "sections", cols);
  const { map, rows: mains } = await resolveMainSections(client);

  const { rows: slugRows } = await client.query(`SELECT slug FROM sections`);
  const slugs = new Set(slugRows.map((r) => r.slug));
  const makeSlug = (base) => {
    let s = base, n = 2;
    while (slugs.has(s)) s = `${base}-${n++}`;
    slugs.add(s);
    return s;
  };

  let maxSort = mains.reduce((m, r) => Math.max(m, Number(r.sort_order) || 0), 0);
  let createdMain = 0, createdSub = 0, imagesFilled = 0, matched = 0;

  for (const def of MAIN) {
    const imageUrl = `${BASE_URL}/sections/${def.key}.svg`;
    let parent = map.get(def.key);
    let parentId;
    if (parent) {
      matched++;
      parentId = parent.id;
      if (!parent.image_url || !String(parent.image_url).trim()) {
        await client.query(`UPDATE sections SET image_url = $2 WHERE id = $1`, [parent.id, imageUrl]);
        imagesFilled++;
      }
    } else {
      maxSort += 1;
      parentId = await insertRow(client, "sections", ctx,
        ["name", "slug", "parent_id", "sort_order", "image_url", "is_active"],
        [def.name, makeSlug(def.key), null, maxSort, imageUrl, true]);
      createdMain++;
    }

    const { rows: kids } = await client.query(`SELECT name FROM sections WHERE parent_id = $1`, [parentId]);
    const have = new Set(kids.map((k) => norm(k.name)));
    for (const [i, subName] of SUBS[def.key].entries()) {
      if (have.has(norm(subName))) continue;
      await insertRow(client, "sections", ctx,
        ["name", "slug", "parent_id", "sort_order", "image_url", "is_active"],
        [subName, makeSlug(`${def.key}-${i + 1}`), parentId, i + 1, null, true]);
      have.add(norm(subName));
      createdSub++;
    }
  }
  return { matchedExistingMain: matched, createdMain, createdSub, imagesFilled };
}

/* ------------------------------ المهمة (ج): البانرات ------------------------------ */

const BANNER_TEXT = {
  food: [["عروض الجملة على المواد الغذائية", "أسعار خاصة للكميات الكبيرة"], ["أرز وسكر وزيوت بأفضل سعر", "وفّر أكثر مع الكرتونة الكاملة"], ["موّن متجرك بالجملة", "توصيل سريع لكل المدن"]],
  building: [["مواد البناء بأسعار الجملة", "إسمنت وحديد وطوب بأفضل الأسعار"], ["جهّز مشروعك من مورد واحد", "كميات كبيرة وتوصيل للموقع"], ["عروض المقاولين", "خصومات على الطلبات الكبيرة"]],
  sanitary: [["الأدوات الصحية بالجملة", "أحواض وخلاطات بأسعار منافسة"], ["كل ما تحتاجه للسباكة", "مواسير وتوصيلات بجودة عالية"], ["تشكيلة سخانات ومضخات", "عروض حصرية للتجار"]],
  electrical: [["مستلزمات الكهرباء بالجملة", "أسلاك وقواطع بأفضل سعر"], ["إضاءة بتوفير أكبر", "لمبات ليد بأسعار الكرتونة"], ["بطاريات ومولدات", "جودة مضمونة وتوصيل سريع"]],
  cleaning: [["المنظفات بأسعار الجملة", "نظافة أكثر بتكلفة أقل"], ["مساحيق وسوائل غسيل", "اطلب بالكرتونة ووفّر"], ["ورق ومناديل ومعقمات", "كل احتياجات النظافة في مكان واحد"]],
  household: [["الأدوات المنزلية بالجملة", "أواني وقدور بأسعار مميزة"], ["بلاستيك وحافظات", "تشكيلة واسعة لمتجرك"], ["أجهزة صغيرة ومفروشات", "عروض خاصة على الكميات"]],
  stationery: [["القرطاسية بأسعار الجملة", "دفاتر وأقلام بأفضل سعر"], ["موسم العودة للمدارس", "حقائب وأدوات بخصومات كبيرة"], ["مستلزمات المكاتب", "طابعات وأحبار بأسعار منافسة"]],
  electronics: [["الإلكترونيات بالجملة", "هواتف وإكسسوارات بأسعار التجار"], ["شواحن وكابلات أصلية", "اطلب بالكرتونة ووفّر"], ["شاشات وتلفزيونات", "عروض حصرية للموزعين"]],
  cosmetics: [["العناية والتجميل بالجملة", "عطور ومكياج بأسعار مميزة"], ["منتجات العناية بالبشرة", "علامات موثوقة وكميات متاحة"], ["عناية بالشعر", "عروض الجملة لمتاجر التجميل"]],
  auto: [["قطع غيار السيارات بالجملة", "إطارات وزيوت بأفضل سعر"], ["بطاريات وإكسسوارات", "جودة مضمونة وتوصيل سريع"], ["زيوت المحركات", "اطلب بالكرتونة ووفّر"]],
  medical: [["المستلزمات الطبية بالجملة", "مستهلكات طبية بأسعار مناسبة"], ["أجهزة طبية موثوقة", "توفر دائم وتوصيل سريع"], ["مكملات غذائية", "عروض خاصة للصيدليات"]],
  cafe: [["مستلزمات المقاهي والمطاعم", "بن ومشروبات بأسعار الجملة"], ["أكواب وعلب تغليف", "كميات كبيرة بأسعار منافسة"], ["معدات المقاهي", "جهّز مقهاك بأفضل الأسعار"]],
};

const GENERAL_BANNERS = [
  { n: 1, title: "أهلاً بك في جملة", subtitle: "منصتك لتجارة الجملة بين الموردين والتجار" },
  { n: 2, title: "اطلب الآن بأسعار الجملة", subtitle: "تشكيلة واسعة وتوصيل موثوق" },
];

async function seedBanners(client) {
  const bCols = await getColumns(client, "promo_banners");
  if (!hasCols(bCols, ["id", "image_url", "title", "subtitle", "sort_order", "is_active"])) {
    return { skipped: "مخطط promo_banners مختلف" };
  }
  const bsCols = await getColumns(client, "banner_sections");
  if (!hasCols(bsCols, ["banner_id", "section_id"])) return { skipped: "banner_sections غير موجود" };
  const ctx = await insertContext(client, "promo_banners", bCols);
  const { map } = await resolveMainSections(client);

  let created = 0, skippedExisting = 0;
  const exists = async (img) => (await client.query(`SELECT 1 FROM promo_banners WHERE image_url = $1 LIMIT 1`, [img])).rows.length > 0;

  for (const g of GENERAL_BANNERS) {
    const img = `${BASE_URL}/banners/general-${g.n}.svg`;
    if (await exists(img)) { skippedExisting++; continue; }
    await insertRow(client, "promo_banners", ctx,
      ["image_url", "title", "subtitle", "sort_order", "is_active"],
      [img, g.title, g.subtitle, g.n, true]);
    created++;
  }

  for (const [ki, def] of MAIN.entries()) {
    const section = map.get(def.key);
    if (!section) continue;
    for (let n = 1; n <= 3; n++) {
      const img = `${BASE_URL}/banners/${def.key}-${n}.svg`;
      if (await exists(img)) { skippedExisting++; continue; }
      const [title, subtitle] = BANNER_TEXT[def.key][n - 1];
      const id = await insertRow(client, "promo_banners", ctx,
        ["image_url", "title", "subtitle", "sort_order", "is_active"],
        [img, title, subtitle, 10 + ki * 10 + n, true]);
      await client.query(
        `INSERT INTO banner_sections (banner_id, section_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [id, section.id]
      );
      created++;
    }
  }
  return { created, skippedExisting };
}

/* ------------------------- المهمة (د): تطبيع أصناف الموردين التجريبيين ------------------------- */

// نوع الصورة من اسم الصنف (الأخصّ أولًا)
const IMAGE_RULES = [
  ["tomato", "معجون طماطم|طماطم|صلصه|كاتشب"],
  ["toothpaste", "معجون اسنان|معجون"],
  ["rice", "ارز"], ["sugar", "سكر"], ["flour", "دقيق|طحين"],
  ["ghee", "سمن"], ["butter", "زبده"], ["oil", "زيت(?!ون)"],
  ["milk", "حليب|لبن"], ["cheese", "جبن"],
  ["lentils", "عدس|حمص"], ["beans", "فاصوليا|لوبيا|فول"],
  ["pasta", "معكرونه|مكرونه|شعيريه|شعريه|اسباغيتي"],
  ["tea", "شاي"], ["coffee", "قهوه|نسكافيه|بن(?=\\s|$)"],
  ["juice", "عصير"], ["soda", "مشروب غازي|مشروبات غازيه|كولا|بيبسي|صودا"],
  ["biscuits", "بسكويت|كيك|كعك"], ["chocolate", "شوكولا|شكولات|شوكلاته"],
  ["spices", "بهارات|توابل|كمون|فلفل|كركم|قرفه"],
  ["tuna", "تونه|سردين|معلب"], ["jam", "مربي"], ["honey", "عسل"], ["dates", "تمر"], ["eggs", "بيض"],
  ["water", "ماء|مياه"], ["vinegar", "خل(?=\\s|$)"], ["salt", "ملح"],
  ["detergent", "مسحوق|غسيل|منعم"], ["soap", "صابون"], ["shampoo", "شامبو|بلسم"],
  ["tissue", "مناديل|محارم|تواليت|ورق (?:مطبخ|ناعم|حمام)"],
  ["cleaner", "منظف|كلور|ديتول|معقم|مطهر|جلي|فلاش"],
  ["cement", "اسمنت|خرسان"], ["steel", "حديد|تسليح|سيخ"], ["brick", "طوب|بلوك"],
  ["paint", "دهان|طلاء|بويه"], ["tiles", "بلاط|سيراميك|رخام"], ["pipe", "ماسوره|مواسير|انبوب"],
  ["mixer", "خلاط|حنفيه"], ["sink", "حوض|مغسله|مرحاض"],
  ["cable", "سلك|كابل|اسلاك"], ["lamp", "لمبه|اضاءه|مصباح|كشاف|ليد"],
].map(([type, src]) => [type, wordRe(src)]);

// تصنيف فرعي من اسم الصنف: [المفتاح الرئيسي, اسم التصنيف الفرعي, كلمات] — الأخصّ أولًا
const SUB_RULES = [
  ["cosmetics", "عناية بالشعر", "زيت شعر|شعر(?!يه)|صبغه"],
  ["cosmetics", "مكياج", "مكياج|روج|ماسكرا|كحل|طلاء اظافر"],
  ["cosmetics", "عطور", "عطر|عطور"],
  ["cosmetics", "عناية بالبشرة", "كريم(?=\\s|$)|بشره|غسول|مرطب|لوشن|واقي شمس"],
  ["cafe", "أكواب وعلب تغليف", "كوب ورقي|اكواب ورقيه|علب تغليف|غطاء كوب|اكياس ورقيه|تغليف"],
  ["cafe", "معدات مقاهي", "ماكينه قهوه|مطحنه|ايسبريسو|اسبريسو"],
  ["cafe", "بن وقهوة", "حبوب قهوه|قهوه مختصه"],
  ["cafe", "مشروبات ساخنة", "كابتشينو|لاتيه|ماتشا|مشروب ساخن|مشروبات ساخنه"],
  ["auto", "زيوت محركات", "زيت (?:محرك|موتور)|زيوت محركات|موبيل"],
  ["auto", "بطاريات سيارات", "بطاريه سياره|بطاريات سيارات"],
  ["auto", "إطارات", "اطار|اطارات|كفر سياره|جنط"],
  ["auto", "إكسسوارات سيارات", "اكسسوار سياره|ممسحه|غطاء مقعد|معطر سياره"],
  ["medical", "مكملات غذائية", "فيتامين|مكمل|كالسيوم|اوميغا"],
  ["medical", "أجهزة طبية", "جهاز (?:ضغط|سكر)|ترمومتر|نيبولايزر|كرسي متحرك|ميزان حراره"],
  ["medical", "مستهلكات طبية", "كمامه|كمامات|قفاز|شاش|قطن|سرنجه|حقنه|ضماده"],
  ["electronics", "شواحن وكابلات", "شاحن|شواحن|usb"],
  ["electronics", "إكسسوارات هواتف", "جراب|حامل هاتف|سماعه|سماعات|باوربانك|حمايه شاشه"],
  ["electronics", "شاشات وتلفزيونات", "شاشه|شاشات|تلفزيون|تلفاز"],
  ["electronics", "هواتف", "هاتف|جوال|موبايل|ايفون"],
  ["electrical", "بطاريات ومولدات", "بطاريه|بطاريات|مولد"],
  ["electrical", "أسلاك وكابلات", "سلك|كابل|اسلاك"],
  ["electrical", "مفاتيح وقوابس", "مفتاح كهرباء|مفاتيح|قابس|فيش|بريزه"],
  ["electrical", "إضاءة", "لمبه|لمبات|اضاءه|مصباح|كشاف|ليد"],
  ["electrical", "قواطع ولوحات", "قاطع|لوحه كهرباء|فيوز"],
  ["sanitary", "سخانات", "سخان"],
  ["sanitary", "خلاطات", "خلاط مياه|خلاط حوض|خلاط حمام|خلاطات|حنفيه"],
  ["sanitary", "مضخات وخزانات", "مضخه|خزان|طلمبه"],
  ["sanitary", "أحواض وأطقم حمامات", "حوض|مغسله|طقم حمام|مرحاض|بانيو"],
  ["sanitary", "مواسير وتوصيلات", "ماسوره|مواسير|وصله"],
  ["sanitary", "إكسسوارات حمام", "اكسسوار حمام|شطاف|حامل مناديل"],
  ["building", "إسمنت وخرسانة", "اسمنت|خرسان"],
  ["building", "حديد وتسليح", "حديد|تسليح|سيخ"],
  ["building", "طوب وبلوك", "طوب|بلوك"],
  ["building", "رمل وحصى", "رمل|حصي|زلط"],
  ["building", "دهانات", "دهان|طلاء|بويه"],
  ["building", "عزل ومواد لاصقة", "عزل|غراء|سيليكون|مواد لاصقه|لاصق (?:بلاط|سيراميك)"],
  ["building", "أبواب ونوافذ", "باب|ابواب|نافذه|شباك"],
  ["building", "أخشاب", "خشب|اخشاب|ابلكاش"],
  ["cleaning", "شامبو وعناية شخصية", "شامبو|بلسم|صابون|معجون اسنان"],
  ["cleaning", "ورق ومناديل", "مناديل|محارم|تواليت|ورق (?:مطبخ|ناعم|حمام)"],
  ["cleaning", "معقمات", "معقم|كلور|مطهر|ديتول"],
  ["cleaning", "غسيل ملابس", "مسحوق|غسيل|منعم|تايد|اريال"],
  ["cleaning", "منظفات مطبخ وأطباق", "جلي|اطباق|صحون"],
  ["cleaning", "منظفات أرضيات", "ارضيات|فلاش|منظف"],
  ["household", "أواني وقدور", "اواني|قدر|قدور|طنجره|صحن|مقلاه|ابريق"],
  ["household", "بلاستيك وحافظات", "بلاستيك|حافظه|سله|جردل|دلو"],
  ["household", "أجهزة صغيرة", "غلايه|مكواه|مروحه|محضره|مكنسه"],
  ["household", "مفروشات", "مفرش|بطانيه|وساده|سجاد|ستاره|شرشف|لحاف"],
  ["household", "أدوات مائدة", "ملعقه|شوكه|سكين|كاس|اكواب|كوب"],
  ["stationery", "طابعات وأحبار", "طابعه|حبر|احبار|تونر|خرطوشه"],
  ["stationery", "حقائب مدرسية", "شنطه|حقيبه|حقائب"],
  ["stationery", "أقلام وأدوات", "قلم|اقلام|ممحاه|مسطره|ماركر|براية|مقص"],
  ["stationery", "دفاتر وأوراق", "دفتر|دفاتر|ورق|كراس|مفكره"],
  ["food", "صلصات ومعجون طماطم", "طماطم|صلصه|كاتشب|مايونيز|خل(?=\\s|$)"],
  ["food", "معكرونة وشعيرية", "معكرونه|مكرونه|شعيريه|شعريه|اسباغيتي"],
  ["food", "شاي وقهوة", "شاي|قهوه|نسكافيه"],
  ["food", "زيوت وسمن", "زيت(?!ون)|سمن|زبده"],
  ["food", "أرز وسكر ودقيق", "ارز|سكر|دقيق|طحين"],
  ["food", "ألبان وأجبان", "حليب|لبن|جبن|زبادي|قشطه"],
  ["food", "بقوليات وحبوب", "عدس|حمص|فاصوليا|لوبيا|فول|برغل|شوفان|ذره"],
  ["food", "توابل وبهارات", "بهارات|توابل|كمون|فلفل|كركم|ملح|قرفه"],
  ["food", "حلويات وبسكويت", "بسكويت|شوكولا|شكولات|حلوي|كيك|عسل|مربي|تمر"],
  ["food", "مشروبات وعصائر", "عصير|مشروب|كولا|بيبسي|ماء|مياه|صودا"],
  ["food", "معلبات", "تونه|سردين|معلب"],
].map(([key, sub, src]) => ({ key, sub, re: wordRe(src) }));

const PLACEHOLDER_IMG = /placeholder|placehold|dummyimage|picsum|lorempixel|example\.com|no-?image/i;

const hasWord = (n, src) => wordRe(src).test(n);

// اختيار وحدة بيع معقولة من اسم الصنف؛ null = ما نغيّر
function pickUnit(name) {
  const n = norm(name);
  if (hasWord(n, "كرتون")) return "كرتونة";
  if (hasWord(n, "علبه|علب")) return "علبة";
  if (hasWord(n, "كيس|اكياس|شوال|جوال")) return "كيس";
  if (hasWord(n, "زجاجه|قاروره")) return "زجاجة";
  if (/\d\s*(?:كغ|كجم|كلغ|كيلو|kg)(?![؀-ۿa-z])/.test(n)) return "كيس";
  if (/\d\s*(?:لتر|مل|ml|ل|l)(?![؀-ۿa-z])/.test(n)) {
    return hasWord(n, "عصير|ماء|مياه|زيت|خل(?=\\s|$)|مشروب|كولا|بيبسي") ? "زجاجة" : "عبوة";
  }
  if (/\d\s*(?:غ|غم|جم|جرام|غرام|g|gr)(?![؀-ۿa-z])/.test(n)) {
    return hasWord(n, "تونه|طماطم|مربي|عسل|معلب|صلصه|جبن|زبده|حمص|فول|قهوه|شاي|كاكاو") ? "علبة" : "قطعة";
  }
  return null;
}

function pickImageType(name) {
  const n = norm(name);
  for (const [type, re] of IMAGE_RULES) if (re.test(n)) return type;
  return "generic";
}

// رقم ثابت 80..600 مشتق من المعرّف (FNV-1a)
function stockFromId(id) {
  let h = 2166136261;
  for (const ch of String(id)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; }
  return 80 + (h % 521);
}

async function normalizeTestProducts(client) {
  const sup = await getColumns(client, "suppliers");
  const prod = await getColumns(client, "products");
  const sm = await getColumns(client, "stock_movements");
  const pv = await getColumns(client, "product_variants");
  const ss = await getColumns(client, "supplier_sections");
  if (!hasCols(sup, ["id", "business_name"]) ||
      !hasCols(prod, ["id", "name", "unit", "image_url", "stock_qty", "section_id", "supplier_id"]) ||
      !hasCols(sm, ["product_id", "change_qty", "reason"]) ||
      !hasCols(pv, ["product_id"]) ||
      !hasCols(ss, ["supplier_id", "section_id", "enabled"])) {
    return { skipped: "مخطط suppliers/products/stock_movements مختلف" };
  }

  const { rows: suppliers } = await client.query(
    `SELECT id FROM suppliers WHERE business_name ~ $1 OR business_name LIKE '%اختبار%'`,
    ["\\s\\d{1,2}$"]
  );
  if (!suppliers.length) return { testSuppliers: 0 };
  const supplierIds = suppliers.map((s) => s.id);

  const { rows: products } = await client.query(
    `SELECT p.id, p.supplier_id, p.section_id, p.name, p.unit, p.image_url, p.stock_qty
       FROM products p
      WHERE p.supplier_id = ANY($1)
        AND NOT EXISTS (SELECT 1 FROM product_variants v WHERE v.product_id = p.id)
      ORDER BY p.id`,
    [supplierIds]
  );

  // أقسام الموردين المفعّلة + الأقسام الرئيسية والفرعية الحالية
  const { rows: ssRows } = await client.query(
    `SELECT supplier_id::text AS s, section_id::text AS sec FROM supplier_sections
      WHERE enabled AND supplier_id = ANY($1)`, [supplierIds]);
  const enabled = new Set(ssRows.map((r) => `${r.s}|${r.sec}`));

  const { map } = await resolveMainSections(client);
  const subIds = new Map(); // `${key}|${normSubName}` -> id
  for (const [key, row] of map) {
    const { rows } = await client.query(`SELECT id, name FROM sections WHERE parent_id = $1`, [row.id]);
    for (const r of rows) subIds.set(`${key}|${norm(r.name)}`, String(r.id));
  }

  const smCtx = await insertContext(client, "stock_movements", sm);
  let unitFixed = 0, imageSet = 0, stockSet = 0, moved = 0;
  for (const p of products) {
    // (i) الوحدة
    const unit = pickUnit(p.name);
    const newUnit = unit ?? (p.unit && String(p.unit).trim() ? null : "قطعة");
    if (newUnit && newUnit !== p.unit) {
      await client.query(`UPDATE products SET unit = $2 WHERE id = $1`, [p.id, newUnit]);
      unitFixed++;
    }

    // (ii) الصورة
    const img = p.image_url == null ? "" : String(p.image_url).trim();
    if (!img || PLACEHOLDER_IMG.test(img)) {
      await client.query(`UPDATE products SET image_url = $2 WHERE id = $1`, [p.id, `${BASE_URL}/products/${pickImageType(p.name)}.svg`]);
      imageSet++;
    }

    // (iii) المخزون (قيمة ثابتة 80..600) مع حركة مخزون تسجّل الفرق
    const cur = Number(p.stock_qty) || 0;
    if (cur < 80 || cur > 600) {
      const target = stockFromId(p.id);
      await client.query(`UPDATE products SET stock_qty = $2 WHERE id = $1`, [p.id, target]);
      await insertRow(client, "stock_movements", smCtx,
        ["product_id", "change_qty", "reason"],
        [p.id, target - cur, "رصيد افتتاحي — تهيئة بيانات تجريبية"]);
      stockSet++;
    }

    // (iv) التصنيف الفرعي (فقط لو المورد مفعّل له القسم الرئيسي)
    const n = norm(p.name);
    const rule = SUB_RULES.find((r) => r.re.test(n));
    if (rule) {
      const parent = map.get(rule.key);
      const subId = subIds.get(`${rule.key}|${norm(rule.sub)}`);
      if (parent && subId && enabled.has(`${p.supplier_id}|${parent.id}`) && String(p.section_id) !== subId) {
        await client.query(`UPDATE products SET section_id = $2 WHERE id = $1`, [p.id, subId]);
        moved++;
      }
    }
  }
  return { testSuppliers: suppliers.length, products: products.length, unitFixed, imageSet, stockSet, moved };
}

/* ------------------------------ نقطة الدخول ------------------------------ */


/* ---- إصلاح: قسم غذائي مكرر (القسم القديم اسمه "غدائية" بخطأ إملائي ولم يُطابَق) ---- */
async function mergeFoodDuplicate(client) {
  const dupe = (await client.query(`SELECT id, image_url FROM sections WHERE parent_id IS NULL AND slug = 'food' LIMIT 1`)).rows[0];
  if (!dupe) return { skipped: "لا يوجد قسم food" };
  const old = (await client.query(
    `SELECT id, image_url FROM sections
      WHERE parent_id IS NULL AND id <> $1 AND (name LIKE '%غدائ%' OR name LIKE '%غذائ%' OR name LIKE '%تموين%')
      ORDER BY created_at LIMIT 1`, [dupe.id])).rows[0];
  if (!old) return { skipped: "لا يوجد قسم غذائي قديم للدمج" };
  const busy = await client.query(
    `SELECT
       (SELECT count(*) FROM products WHERE section_id = $1 OR section_id IN (SELECT id FROM sections WHERE parent_id = $1)) AS p,
       (SELECT count(*) FROM customer_sections WHERE section_id = $1) AS c,
       (SELECT count(*) FROM supplier_sections WHERE section_id = $1) AS s`, [dupe.id]);
  const b = busy.rows[0];
  if (Number(b.p) || Number(b.c) || Number(b.s)) return { skipped: "القسم المكرر مستخدم — لم يُدمج" };
  await client.query(`UPDATE sections SET parent_id = $1 WHERE parent_id = $2`, [old.id, dupe.id]);
  await client.query(
    `DELETE FROM banner_sections WHERE section_id = $2
        AND banner_id IN (SELECT banner_id FROM banner_sections WHERE section_id = $1)`, [old.id, dupe.id]);
  await client.query(`UPDATE banner_sections SET section_id = $1 WHERE section_id = $2`, [old.id, dupe.id]);
  await client.query(
    `UPDATE sections SET name = 'مواد غذائية', image_url = COALESCE(NULLIF(image_url, ''), $2) WHERE id = $1`,
    [old.id, dupe.image_url]);
  await client.query(`DELETE FROM sections WHERE id = $1`, [dupe.id]);
  return { merged: true };
}

export async function runBootstrap() {
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS app_state (key TEXT PRIMARY KEY, value TEXT, updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
    await ensureBannerSections();
  } catch (e) {
    console.error("[bootstrap] DDL فشل (لا تأثير على السيرفر):", e?.message || e);
    return;
  }
  // بالترتيب: الأقسام ثم البانرات ثم الأصناف (كل مهمة معزولة؛ فشلها لا يمنع غيرها)
  await runJob("seed_sections_v1", seedSections);
  await runJob("seed_banners_v1", seedBanners);
  await runJob("normalize_test_products_v1", normalizeTestProducts);
  await runJob("merge_food_duplicate_v1", mergeFoodDuplicate);
  await runJob("normalize_test_products_v2", normalizeTestProducts);
  log("اكتملت");
}
