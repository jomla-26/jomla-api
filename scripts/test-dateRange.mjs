// اختبار وحدة لـ src/lib/dateRange.js — تشغيل: node scripts/test-dateRange.mjs
// (بدون قاعدة بيانات. لو bcrypt غير مثبّت نستبدله بـ mock لأن helpers.js يستورده فقط)
import assert from "node:assert/strict";
import { register } from "node:module";

register("data:text/javascript," + encodeURIComponent(`
  export async function resolve(spec, ctx, next) {
    try { return await next(spec, ctx); }
    catch (e) {
      if (spec === "bcrypt") return { url: "data:text/javascript,export default {hash:async()=>'',compare:async()=>false}", shortCircuit: true };
      throw e;
    }
  }
`));

const { parseRange, addRange, addDateColRange, andClause, buildLedger, tripoliDay, OPENING_LABEL } =
  await import("../src/lib/dateRange.js");

let n = 0;
const t = (name, fn) => { fn(); n++; console.log("ok -", name); };
const bad = (q) => { try { parseRange(q); } catch (e) { return e; } assert.fail("expected 400 for " + JSON.stringify(q)); };

t("parseRange: no params", () => assert.deepEqual(parseRange({}), { from: null, to: null }));
t("parseRange: undefined query", () => assert.deepEqual(parseRange(undefined), { from: null, to: null }));
t("parseRange: empty strings ignored", () => assert.deepEqual(parseRange({ from: "", to: "" }), { from: null, to: null }));
t("parseRange: valid", () => assert.deepEqual(parseRange({ from: "2026-01-05", to: "2026-01-05" }), { from: "2026-01-05", to: "2026-01-05" }));
t("parseRange: only from / only to", () => {
  assert.deepEqual(parseRange({ from: "2026-01-05" }), { from: "2026-01-05", to: null });
  assert.deepEqual(parseRange({ to: "2026-01-05" }), { from: null, to: "2026-01-05" });
});
t("parseRange: bad format => 400 Arabic", () => {
  for (const q of [{ from: "2026/01/05" }, { to: "5-1-2026" }, { from: "2026-1-5" }, { from: "2026-02-30" }, { to: "2026-13-01" },
                   { from: ["2026-01-01", "2026-01-02"] }, { from: "2026-01-01T00:00:00Z" }, { from: "abc" }]) {
    const e = bad(q);
    assert.equal(e.status, 400);
    assert.match(e.message, /[؀-ۿ]/);
  }
});
t("parseRange: from > to => 400", () => assert.equal(bad({ from: "2026-02-01", to: "2026-01-01" }).status, 400));
t("parseRange: leap day valid", () => assert.equal(parseRange({ from: "2028-02-29" }).from, "2028-02-29"));

t("addRange: none adds nothing", () => {
  const p = [1], c = [];
  addRange("o.created_at", { from: null, to: null }, p, c);
  assert.deepEqual(p, [1]); assert.deepEqual(c, []);
  assert.equal(andClause(c), "");
});
t("addRange: both, numbering continues after existing params", () => {
  const p = ["a", "b", 200, 0], c = [];
  addRange("o.created_at", { from: "2026-01-01", to: "2026-01-31" }, p, c);
  assert.deepEqual(p, ["a", "b", 200, 0, "2026-01-01", "2026-01-31"]);
  assert.equal(c[0], "((o.created_at) AT TIME ZONE 'Africa/Tripoli')::date >= $5::date");
  assert.equal(c[1], "((o.created_at) AT TIME ZONE 'Africa/Tripoli')::date <= $6::date");
  assert.equal(andClause(c), " AND " + c.join(" AND "));
});
t("addRange: only to", () => {
  const p = [], c = [];
  addRange("x", { from: null, to: "2026-03-03" }, p, c);
  assert.deepEqual(p, ["2026-03-03"]); assert.match(c[0], /<= \$1::date$/);
});
t("addDateColRange: plain date column", () => {
  const p = [9], c = [];
  addDateColRange("trip_date", { from: "2026-01-01", to: null }, p, c);
  assert.equal(c[0], "(trip_date)::date >= $2::date");
});

t("tripoliDay: UTC evening rolls to next Tripoli day (UTC+2)", () => {
  assert.equal(tripoliDay(new Date("2026-03-10T22:30:00Z")), "2026-03-11");
  assert.equal(tripoliDay(new Date("2026-03-10T21:59:59Z")), "2026-03-10");
  assert.equal(tripoliDay("2026-03-10"), "2026-03-10");
  assert.equal(tripoliDay(null), null);
});

const d = (iso) => new Date(iso);
const custRows = () => [
  { entry_date: d("2026-01-01T10:00:00Z"), label: "فاتورة A", reference: "A", voucher_number: null, debit: 100, credit: 0 },
  { entry_date: d("2026-01-05T10:00:00Z"), label: "قبض", reference: "A", voucher_number: "V1", debit: 0, credit: 30 },
  { entry_date: d("2026-01-10T10:00:00Z"), label: "فاتورة B", reference: "B", voucher_number: null, debit: 50, credit: 0 },
  { entry_date: d("2026-01-20T10:00:00Z"), label: "قبض 2", reference: "B", voucher_number: "V2", debit: 0, credit: 200 },
];

t("ledger: no range = old behaviour (running balance, no opening row)", () => {
  const r = buildLedger(custRows(), { from: null, to: null }, "debit-credit");
  assert.equal(r.length, 4);
  assert.deepEqual(r.map((x) => x.balance), [100, 70, 120, -80]);
  assert.ok(!r.some((x) => x.is_opening));
});
t("ledger: from => opening row on debit side then continuing balance", () => {
  const r = buildLedger(custRows(), { from: "2026-01-08", to: null }, "debit-credit", { customer_id: "c1" });
  assert.equal(r.length, 3);
  assert.deepEqual(r[0], { customer_id: "c1", is_opening: true, entry_date: "2026-01-08", label: OPENING_LABEL,
    reference: "", voucher_number: null, debit: 70, credit: 0, balance: 70 });
  assert.deepEqual(r.slice(1).map((x) => x.balance), [120, -80]);
});
t("ledger: negative opening goes to credit side", () => {
  const r = buildLedger(custRows(), { from: "2026-01-25", to: null }, "debit-credit");
  assert.equal(r.length, 1);
  assert.equal(r[0].debit, 0); assert.equal(r[0].credit, 80); assert.equal(r[0].balance, -80);
});
t("ledger: from with no earlier rows => zero opening row", () => {
  const r = buildLedger(custRows(), { from: "2025-12-01", to: null }, "debit-credit");
  assert.equal(r[0].is_opening, true); assert.equal(r[0].balance, 0);
  assert.equal(r[0].debit, 0); assert.equal(r[0].credit, 0);
  assert.equal(r.length, 5);
});
t("ledger: to only cuts rows, no opening row", () => {
  const r = buildLedger(custRows(), { from: null, to: "2026-01-05" }, "debit-credit");
  assert.equal(r.length, 2); assert.deepEqual(r.map((x) => x.balance), [100, 70]);
});
t("ledger: from+to, inclusive both ends, Tripoli day boundaries", () => {
  // 2026-01-10T22:30Z هو 2026-01-11 بتوقيت طرابلس
  const rows = [
    { entry_date: d("2026-01-10T21:59:00Z"), debit: 10, credit: 0 },
    { entry_date: d("2026-01-10T22:30:00Z"), debit: 20, credit: 0 },
    { entry_date: d("2026-01-11T21:59:00Z"), debit: 40, credit: 0 },
    { entry_date: d("2026-01-11T22:00:00Z"), debit: 80, credit: 0 },
  ];
  const r = buildLedger(rows, { from: "2026-01-11", to: "2026-01-11" }, "debit-credit");
  assert.deepEqual(r.map((x) => x.balance), [10, 30, 70]);
  assert.equal(r[0].is_opening, true); assert.equal(r[0].debit, 10);
});
t("ledger: supplier mode (credit - debit)", () => {
  const rows = [
    { entry_date: d("2026-02-01T10:00:00Z"), debit: 0, credit: 500 },
    { entry_date: d("2026-02-03T10:00:00Z"), debit: 120, credit: 0 },
    { entry_date: d("2026-02-09T10:00:00Z"), debit: 0, credit: 60 },
  ];
  const all = buildLedger(rows, {}, "credit-debit");
  assert.deepEqual(all.map((x) => x.balance), [500, 380, 440]);
  const r = buildLedger(rows, { from: "2026-02-05" }, "credit-debit", { supplier_id: "s1" });
  assert.equal(r[0].credit, 380); assert.equal(r[0].debit, 0); assert.equal(r[0].balance, 380);
  assert.equal(r[0].supplier_id, "s1");
  assert.equal(r[1].balance, 440);
  const neg = buildLedger([{ entry_date: d("2026-02-01T10:00:00Z"), debit: 90, credit: 0 }], { from: "2026-02-02" }, "credit-debit");
  assert.equal(neg[0].debit, 90); assert.equal(neg[0].credit, 0); assert.equal(neg[0].balance, -90);
});
t("ledger: wallet in/out mode uses in_amount/out_amount", () => {
  const rows = [
    { entry_date: d("2026-04-01T10:00:00Z"), in_amount: 300, out_amount: 0 },
    { entry_date: d("2026-04-02T10:00:00Z"), in_amount: 0, out_amount: 50.25 },
    { entry_date: d("2026-04-10T10:00:00Z"), in_amount: 0, out_amount: 100 },
  ];
  const r = buildLedger(rows, { from: "2026-04-05" }, "in-out");
  assert.equal(r[0].in_amount, 249.75); assert.equal(r[0].out_amount, 0); assert.equal(r[0].balance, 249.75);
  assert.equal(r[1].balance, 149.75);
});
t("ledger: cents arithmetic has no float drift", () => {
  const rows = Array.from({ length: 10 }, (_, i) => ({ entry_date: d(`2026-05-0${i % 9 + 1}T10:00:00Z`), debit: 0.1, credit: 0 }));
  const r = buildLedger(rows, { from: "2026-05-09" }, "debit-credit");
  assert.equal(r[0].balance, 0.9);
});
t("ledger: null-dated rows kept without range, skipped with range", () => {
  const rows = [{ entry_date: null, debit: 5, credit: 0 }, { entry_date: d("2026-01-01T10:00:00Z"), debit: 1, credit: 0 }];
  assert.equal(buildLedger(rows, {}, "debit-credit").length, 2);
  assert.equal(buildLedger(rows, { to: "2026-12-31" }, "debit-credit").length, 1);
});
t("ledger: does not mutate input rows", () => {
  const rows = custRows(); const copy = JSON.parse(JSON.stringify(rows));
  buildLedger(rows, { from: "2026-01-08" }, "debit-credit");
  assert.deepEqual(JSON.parse(JSON.stringify(rows)), copy);
});

console.log(`\n${n} tests passed`);
