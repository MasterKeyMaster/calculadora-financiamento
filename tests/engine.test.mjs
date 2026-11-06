// Confere o motor JavaScript contra os resultados do motor Python (tests/casos.json), ao centavo.
// Uso: node tests/engine.test.mjs
import { readFileSync } from "node:fs";
import { D, schedule, totals, annualSummary, minimumDownPayment, packageComparison, parseDate,
  parseBrazilian, formatBrazilian } from "../engine.js";

const cases = JSON.parse(readFileSync(new URL("./casos.json", import.meta.url), "utf8"));
const toScenario = (j) => ({
  ...j,
  property_value: new D(j.property_value), down_payment: new D(j.down_payment),
  annual_rate: new D(j.annual_rate), tr_annual: new D(j.tr_annual),
  simulation_date: parseDate(j.simulation_date),
  costs: { ...j.costs, mip_bands: j.costs.mip_bands.map(([m, p]) => [m, new D(p)]) },
  buyers: j.buyers.map((b) => ({ share_percent: new D(b.share_percent) })),
});
const iso = (d) => `${d.y}-${String(d.m).padStart(2, "0")}-${String(d.d).padStart(2, "0")}`;

let failures = 0, compared = 0;
const check = (label, js, py) => {
  compared++;
  const ok = typeof py === "string" && /^-?\d+(\.\d+)?(E[+-]?\d+)?$/.test(py) ? new D(py).eq(js) : String(js) === String(py);
  if (!ok) { failures++; if (failures <= 20) console.error(`DIFERE ${label}: js=${js} py=${py}`); }
};
const compareObj = (label, js, py) => { for (const k of Object.keys(py)) check(`${label}.${k}`, js[k], py[k]); };

for (const c of cases) {
  const s = toScenario(c.scenario);
  const rows = schedule(s);
  check(`${c.name}.linhas`, rows.length, c.rows.length);
  rows.forEach((r, i) => compareObj(`${c.name}[${r.month}]`, { ...r, due_date: iso(r.due_date) }, c.rows[i]));
  compareObj(`${c.name}.totais`, totals(s, rows), c.totals);
  annualSummary(rows).forEach((a, i) => compareObj(`${c.name}.ano${a.year}`, a, c.annual[i]));
  compareObj(`${c.name}.pacote`, packageComparison(s, "11.5"), c.package);
  if (c.affordability) compareObj(`${c.name}.entrada`, minimumDownPayment(s, ...c.affordability.args), c.affordability.result);
}

for (const [input, expected] of [["500.000,00", "500000"], ["R$ 391.537,01", "391537.01"], ["10,65", "10.65"], ["1234", "1234"]])
  check(`parse ${input}`, parseBrazilian(input), expected);
for (const bad of ["10.65", "1,2,3", "abc", ""]) {
  compared++;
  try { parseBrazilian(bad); failures++; console.error(`DIFERE parse aceitou ${bad}`); } catch { /* esperado */ }
}
check("format", formatBrazilian(new D("1234567.891")), "1.234.567,89");
check("format trim", formatBrazilian(new D("0.015400"), 6, { trim: true }), "0,0154");

const rowsTotal = cases.reduce((n, c) => n + c.rows.length, 0);
console.log(`${cases.length} casos, ${rowsTotal} parcelas, ${compared} valores comparados, ${failures} diferenças`);
process.exit(failures ? 1 : 0);
