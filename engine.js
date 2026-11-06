// Motor de financiamento SAC: porte fiel de Imoveis/Calculadora_financiamento/src/financiamento.
// Usa decimal.js com o mesmo contexto do Decimal do Python (28 dígitos, arredondamento bancário
// nas operações intermediárias) e arredondamento comercial ao centavo, para resultados idênticos.
import Decimal from "./vendor/decimal.esm.js";

export const D = Decimal.clone({ precision: 28, rounding: Decimal.ROUND_HALF_EVEN, toExpNeg: -30, toExpPos: 30 });
export const ZERO = new D(0);
const CENT = new D("0.01");

export const dec = (v) => {
  const r = v instanceof D ? v : new D(String(v));
  if (!r.isFinite()) throw new Error("Valores devem ser finitos.");
  return r;
};
export const money = (v) => dec(v).toDecimalPlaces(2, D.ROUND_HALF_UP);
const sum = (values) => values.reduce((a, b) => a.plus(b), ZERO);
const maxOf = (values) => values.reduce((a, b) => (b.gt(a) ? b : a), values[0] ?? ZERO);
const minOf = (values) => values.reduce((a, b) => (b.lt(a) ? b : a), values[0] ?? ZERO);

export function monthlyRate(annualPercent, kind = "nominal") {
  const rate = dec(annualPercent).div(100);
  if (rate.lt(0) || !["nominal", "efetiva"].includes(kind))
    throw new Error("Taxa não negativa e tipo nominal ou efetiva são obrigatórios.");
  return kind === "nominal" ? rate.div(12) : rate.plus(1).pow(new D(1).div(12)).minus(1);
}

// ---------- Datas (meses do contrato) ----------
export function parseDate(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return { y, m, d };
}
const daysIn = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
export function addMonths(start, months) {
  const abs = start.y * 12 + start.m - 1 + months;
  const y = Math.floor(abs / 12), m = (abs % 12) + 1;
  return { y, m, d: Math.min(start.d, daysIn(y, m)) };
}
export const formatDate = (x) => `${String(x.d).padStart(2, "0")}/${String(x.m).padStart(2, "0")}/${x.y}`;

// ---------- Cenário ----------
export function defaultCosts() {
  return {
    mip_percent: ZERO, dfi_percent: ZERO, administration: ZERO, initial: ZERO,
    package_initial: ZERO, package_monthly: ZERO, package_months: 0,
    pension_initial: ZERO, pension_monthly: ZERO, pension_months: 0,
    zero_insurance_at_payoff: true, mip_basis: "opening", mip_bands: [],
  };
}

export const principal = (s) => dec(s.property_value).minus(dec(s.down_payment));

export function validate(s) {
  for (const v of [s.property_value, s.down_payment, s.annual_rate, s.tr_annual]) dec(v);
  const price = dec(s.property_value), down = dec(s.down_payment);
  if (price.lte(0) || down.lt(0) || down.gt(price))
    throw new Error("Imóvel positivo e entrada entre zero e o valor do imóvel.");
  if (!Number.isInteger(s.months) || s.months < 1 || s.months > 600)
    throw new Error("Prazo deve ser inteiro entre 1 e 600 meses.");
  if (!money(principal(s)).eq(principal(s)) || !money(price).eq(price))
    throw new Error("Valores monetários devem ter no máximo duas casas decimais.");
  monthlyRate(s.annual_rate, s.rate_kind);
  monthlyRate(s.tr_annual, "efetiva");
  const c = s.costs;
  for (const [name, value] of Object.entries(c)) {
    if (typeof value === "boolean" || name === "mip_basis" || name === "mip_bands") continue;
    if (dec(value).lt(0)) throw new Error("Custos e durações devem ser não negativos.");
    if (name.endsWith("months") && (!Number.isInteger(value) || value > 600))
      throw new Error("Duração de custos deve ser inteira entre 0 e 600.");
  }
  if (!["opening", "closing"].includes(c.mip_basis)) throw new Error("Base do MIP deve ser opening ou closing.");
  let previous = 0;
  for (const [start, percent] of c.mip_bands) {
    if (!Number.isInteger(start) || !(previous < start && start <= 600) || dec(percent).lt(0))
      throw new Error("Faixas do MIP devem ter meses crescentes e alíquotas não negativas.");
    if (previous === 0 && start !== 1) throw new Error("A primeira faixa do MIP deve começar no mês 1.");
    previous = start;
  }
  const buyers = s.buyers ?? [{ share_percent: new D(100) }];
  if (!buyers.length || !sum(buyers.map((b) => dec(b.share_percent))).eq(100))
    throw new Error("Participações dos compradores devem somar 100%.");
  for (const b of buyers) if (dec(b.share_percent).lt(0)) throw new Error("Participação e nascimento inválidos.");
}

function insurance(balance, propertyValue, c, final, closingBalance, month) {
  if (final && c.zero_insurance_at_payoff) return [ZERO, ZERO];
  let percent = dec(c.mip_percent);
  for (const [start, band] of c.mip_bands) {
    if (month < start) break;
    percent = dec(band);
  }
  if (c.mip_basis === "closing") balance = closingBalance;
  return [money(balance.times(percent).div(100)), money(dec(propertyValue).times(dec(c.dfi_percent)).div(100))];
}

export function schedule(s) {
  validate(s);
  if (principal(s).isZero()) return [];
  const rate = monthlyRate(s.annual_rate, s.rate_kind);
  const tr = monthlyRate(s.tr_annual, "efetiva");
  const c = s.costs;
  let balance = principal(s);
  const fixed = money(balance.div(s.months));
  const admin = money(c.administration);
  const rows = [];
  for (let month = 1; month <= s.months; month++) {
    const correction = money(balance.times(tr));
    const corrected = balance.plus(correction);
    const remaining = s.months - month + 1;
    // TR: SAC recalculado sobre saldo corrigido/prazo restante.
    let amortization = tr.isZero() ? fixed : money(corrected.div(remaining));
    amortization = remaining === 1 ? corrected : D.min(amortization, corrected);
    const interest = money(corrected.times(rate));
    const [mip, dfi] = insurance(corrected, s.property_value, c, remaining === 1, corrected.minus(amortization), month);
    const installment = amortization.plus(interest).plus(mip).plus(dfi).plus(admin);
    const pkg = month <= c.package_months ? money(c.package_monthly) : ZERO;
    const pension = month <= c.pension_months ? money(c.pension_monthly) : ZERO;
    balance = corrected.minus(amortization);
    rows.push({
      month, due_date: addMonths(s.simulation_date, month), correction, amortization, interest, mip, dfi,
      administration: admin, installment, package: pkg, pension, outflow: installment.plus(pkg).plus(pension), balance,
    });
  }
  return rows;
}

// ---------- Resumos ----------
const TOTAL_FIELDS = ["amortization", "interest", "mip", "dfi", "administration", "installment", "package", "pension", "outflow", "correction"];

export function totals(s, rows) {
  const r = Object.fromEntries(TOTAL_FIELDS.map((f) => [f, sum(rows.map((x) => x[f]))]));
  const c = s.costs;
  // Sem empréstimo, despesas de contratação e relacionamento não são incorridas.
  const initial = rows.length ? money(dec(c.initial).plus(c.package_initial).plus(c.pension_initial)) : ZERO;
  return {
    ...r, initial,
    full_outflow: dec(s.down_payment).plus(initial).plus(r.outflow),
    maximum: maxOf(rows.map((x) => x.outflow)),
    first: rows.length ? rows[0].outflow : ZERO,
    last: rows.length ? rows[rows.length - 1].outflow : ZERO,
    pension_contributions: r.pension.plus(rows.length ? money(c.pension_initial) : ZERO),
  };
}

export function annualSummary(rows) {
  const result = [];
  for (let start = 0; start < rows.length; start += 12) {
    const g = rows.slice(start, start + 12), out = g.map((x) => x.outflow);
    const total = sum(out);
    result.push({
      year: start / 12 + 1, months: g.length, total, mean: total.div(g.length),
      minimum: minOf(out), maximum: maxOf(out), balance: g[g.length - 1].balance,
      installments: sum(g.map((x) => x.installment)),
    });
  }
  return result;
}

// ---------- Entrada mínima por renda e cota ----------
const peakOf = (rows) => maxOf(rows.map((r) => r.outflow));

export function minimumDownPayment(s, income, limitPercent, quotaPercent) {
  income = dec(income); limitPercent = dec(limitPercent); quotaPercent = dec(quotaPercent);
  if (income.lt(0) || limitPercent.lt(0) || limitPercent.gt(100) || quotaPercent.lt(0) || quotaPercent.gt(100))
    throw new Error("Renda não negativa e limites entre 0 e 100%.");
  validate(s);
  const price = dec(s.property_value);
  const cap = income.times(limitPercent).div(100);
  const withLoan = (cents) => ({ ...s, down_payment: price.minus(CENT.times(cents)) });
  const noTr = dec(s.tr_annual).isZero();
  let low = 0, high = price.div(CENT).trunc().toNumber();
  while (low < high) {
    const middle = Math.floor((low + high + 1) / 2);
    const rows = schedule(withLoan(middle));
    // Sem TR, ignora o residual da última amortização na busca binária (degraus de arredondamento).
    const peak = rows.length && noTr && s.months > 1 ? peakOf(rows.slice(0, -1)) : peakOf(rows);
    if (peak.lte(cap)) low = middle; else high = middle - 1;
  }
  if (noTr) {
    while (low > 0) {
      if (peakOf(schedule(withLoan(low))).lte(cap)) break;
      low -= 1;
    }
  }
  const incomeDown = price.minus(CENT.times(low));
  const quotaDown = price.times(new D(1).minus(quotaPercent.div(100))).toDecimalPlaces(2, D.ROUND_CEIL);
  let combined = D.max(incomeDown, quotaDown);
  // Revalida a combinação: entrada maior pode cair em outro degrau do residual final.
  while (combined.lt(price)) {
    if (peakOf(schedule({ ...s, down_payment: combined })).lte(cap)) break;
    combined = combined.plus(CENT);
  }
  return { income: incomeDown, quota: quotaDown, minimum: combined, cap };
}

// ---------- Pacote/previdência ----------
export function packageComparison(s, undiscountedRate) {
  const without = {
    ...s, annual_rate: dec(undiscountedRate),
    costs: { ...s.costs, package_initial: ZERO, package_monthly: ZERO, package_months: 0, pension_initial: ZERO, pension_monthly: ZERO, pension_months: 0 },
  };
  const withTotal = totals(s, schedule(s)).full_outflow;
  const withoutTotal = totals(without, schedule(without)).full_outflow;
  return { with_package: withTotal, without_package: withoutTotal, gross_saving: withoutTotal.minus(withTotal) };
}

// ---------- Presets ----------
export function fromPreset(p, profile) {
  const price = dec(p.property_value), down = dec(p.down_payment);
  const bands = profile.mip_bands.map(([start, percent]) => [start, dec(percent)]);
  return {
    property_value: price, down_payment: down, months: p.months,
    annual_rate: dec(profile.annual_nominal_inferred), rate_kind: "nominal",
    simulation_date: parseDate(p.date), tr_annual: ZERO,
    costs: {
      ...defaultCosts(),
      mip_percent: bands[0][1],
      dfi_percent: dec(p.first_dfi).div(price).times(100),
      administration: dec(p.administration),
      initial: dec(p.evaluation).plus(dec(p.upfront_insurance)),
      mip_basis: profile.mip_basis, mip_bands: bands,
    },
    buyers: [{ share_percent: new D(100), birth_date: p.birth_date }],
  };
}

// ---------- Números brasileiros ----------
export function parseBrazilian(text) {
  text = String(text).trim();
  if (text.startsWith("R$")) text = text.slice(2).trim();
  if (!/^[+-]?(?:\d+|\d{1,3}(?:\.\d{3})+)(?:,\d+)?$/.test(text))
    throw new Error("Use vírgula nos decimais e ponto nos milhares, por exemplo 500.000,00.");
  return new D(text.replaceAll(".", "").replace(",", "."));
}

export function formatBrazilian(value, places = 2, { trim = false } = {}) {
  const fixed = dec(value).toFixed(places, D.ROUND_HALF_EVEN);
  const negative = fixed.startsWith("-");
  let [integer, fraction] = (negative ? fixed.slice(1) : fixed).split(".");
  integer = integer.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  if (trim && places > 2) fraction = fraction.replace(/0+$/, "").padEnd(2, "0");
  return (negative ? "-" : "") + integer + (fraction !== undefined ? "," + fraction : "");
}
