import {
  D, ZERO, money, monthlyRate, principal, schedule, totals, annualSummary, minimumDownPayment, packageComparison,
  fromPreset, parseDate, formatDate, parseBrazilian, formatBrazilian,
} from "./engine.js";

const KEYS = ["tr_plus", "mcmv"];
const SHORT = { tr_plus: "TR PLUS", mcmv: "MCMV" };
const brl = (v) => "R$ " + formatBrazilian(v);
const pct = (v, places = 1) => formatBrazilian(v, places) + "%";
const rateText = (v) => formatBrazilian(v, 6, { trim: true }) + "%";
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

const [presets, profiles] = await Promise.all(
  ["data/presets.json", "data/calibrated_profiles.json"].map((u) => fetch(u).then((r) => r.json())));
const bases = Object.fromEntries(KEYS.map((k) => [k, fromPreset(presets[k], profiles[k])]));

// ---------- Campos ----------
const fields = {};
let timer, charts = {}, lastResults = {}, singleResult = null, activeTab = "simular";
let singleActions = [], beforeAfter = null, adResults = {};
class FieldError extends Error {}

function numberField(parent, id, label, value, { money: isMoney = label.includes("(R$)"), min = 0, max, onCommit } = {}) {
  const places = isMoney ? 2 : 6;
  const wrap = document.createElement("div");
  wrap.className = "field";
  wrap.innerHTML = `<label for="${id}">${esc(label)}</label><input type="text" inputmode="decimal" id="${id}" autocomplete="off" /><div class="error" hidden></div>`;
  parent.append(wrap);
  const input = wrap.querySelector("input");
  input.value = formatBrazilian(value, places, { trim: true });
  fields[id] = { wrap, input, places, min: new D(min), max: max === undefined ? undefined : new D(max), label };
  input.addEventListener("input", schedule_update);
  input.addEventListener("change", () => {
    try {
      const v = parseBrazilian(input.value);
      if (v.eq(v.toDecimalPlaces(places))) input.value = formatBrazilian(v, places, { trim: true });
      onCommit?.();
    } catch { /* o erro aparece no recálculo */ }
    schedule_update();
  });
  return input;
}

function intField(parent, id, label, value, min, max) {
  const wrap = document.createElement("div");
  wrap.className = "field";
  wrap.innerHTML = `<label for="${id}">${esc(label)}</label><input type="number" id="${id}" min="${min}" max="${max}" step="1" value="${value}" /><div class="error" hidden></div>`;
  parent.append(wrap);
  fields[id] = { wrap, input: wrap.querySelector("input"), int: true, min, max, label };
  fields[id].input.addEventListener("input", schedule_update);
}

function checkbox(parent, id, label, checked) {
  const l = document.createElement("label");
  l.className = "check";
  l.innerHTML = `<input type="checkbox" id="${id}" ${checked ? "checked" : ""} /> ${esc(label)}`;
  parent.append(l);
  l.querySelector("input").addEventListener("change", schedule_update);
}

function setError(id, message) {
  const f = fields[id], box = f.wrap.querySelector(".error");
  f.wrap.classList.toggle("invalid", !!message);
  box.hidden = !message;
  box.textContent = message || "";
}

function setValue(id, value) {
  const f = fields[id];
  f.input.value = f.int ? String(value) : formatBrazilian(value, f.places, { trim: true });
  setError(id, "");
}

function read(id) {
  const f = fields[id];
  try {
    let v;
    if (f.int) {
      const n = Number(f.input.value);
      if (!Number.isInteger(n) || n < f.min || n > f.max) throw new Error(`Use um número inteiro entre ${f.min} e ${f.max}.`);
      v = n;
    } else {
      v = parseBrazilian(f.input.value);
      if (v.lt(f.min) || (f.max && v.gt(f.max)))
        throw new Error(f.max ? `Valor deve estar entre ${formatBrazilian(f.min)} e ${formatBrazilian(f.max)}.` : `Valor deve ser pelo menos ${formatBrazilian(f.min)}.`);
      if (!v.eq(v.toDecimalPlaces(f.places))) throw new Error(`Use no máximo ${f.places} casas decimais.`);
    }
    setError(id, "");
    return v;
  } catch (e) {
    setError(id, e.message);
    throw new FieldError(`${f.label}: ${e.message}`);
  }
}

// Entrada em reais e percentual sincronizados.
function synchronize(prefix, source) {
  try {
    const price = parseBrazilian(fields[prefix + "price"].input.value);
    if (source === "percent") {
      const p = parseBrazilian(fields[prefix + "percent"].input.value);
      fields[prefix + "down"].input.value = formatBrazilian(money(price.times(p).div(100)));
    } else {
      const down = parseBrazilian(fields[prefix + "down"].input.value);
      fields[prefix + "percent"].input.value = formatBrazilian(price.isZero() ? ZERO : down.div(price).times(100), 6, { trim: true });
    }
  } catch { /* campos inválidos: o recálculo mostra o erro */ }
}

function propertyFields(parent, prefix, price, down, months) {
  numberField(parent, prefix + "price", "Valor do imóvel (R$)", price, { min: "0.01", onCommit: () => synchronize(prefix, "price") });
  numberField(parent, prefix + "down", "Entrada (R$)", down, { onCommit: () => synchronize(prefix, "down") });
  numberField(parent, prefix + "percent", "Entrada (%)", down.div(price).times(100), { max: 100, onCommit: () => synchronize(prefix, "percent") });
  intField(parent, prefix + "months", "Prazo (meses)", months, 1, 600);
}

// Blocos usados pelas duas abas (prefixo = chave da proposta na comparação, "s" na aba de uma proposta).
function rateFields(parent, prefix, nominal) {
  parent.insertAdjacentHTML("beforeend", `<div class="field"><label for="${prefix}_kind">Tipo da taxa anual</label><select id="${prefix}_kind"><option value="nominal">nominal</option><option value="efetiva">efetiva</option></select></div>`);
  numberField(parent, `${prefix}_rate`, "Juros nominais (% a.a.)", nominal, { max: 100 });
  $(`${prefix}_kind`).addEventListener("change", () => { rateLabel(prefix); schedule_update(); });
}
function rateLabel(prefix) {
  fields[`${prefix}_rate`].wrap.querySelector("label").textContent = $(`${prefix}_kind`).value === "nominal" ? "Juros nominais (% a.a.)" : "Juros efetivos (% a.a.)";
}

function costFields(parent, prefix, base) {
  checkbox(parent, `${prefix}_curve`, "Usar curva de MIP inferida deste PDF", true);
  parent.insertAdjacentHTML("beforeend", `<p class="muted small">MIP sobre saldo após amortização; DFI sobre valor do imóvel. A curva reproduz o perfil original por mês do contrato, não uma regra universal. Para outro perfil, desative a curva e informe uma alíquota constante.</p>`);
  const cg = document.createElement("div");
  cg.className = "grid g2";
  parent.append(cg);
  numberField(cg, `${prefix}_mip`, "MIP mensal constante (%) — usado ao desativar a curva", base.costs.mip_percent);
  numberField(cg, `${prefix}_dfi`, "DFI mensal (%)", base.costs.dfi_percent.toDecimalPlaces(6, D.ROUND_HALF_EVEN));
  numberField(cg, `${prefix}_admin`, "Administração mensal (R$)", base.costs.administration);
  numberField(cg, `${prefix}_initial`, "Despesas iniciais, incluindo avaliação e seguro à vista (R$)", base.costs.initial);
  checkbox(parent, `${prefix}_zero`, "Zerar seguros no último mês", true);
}

function packageFields(parent, prefix, nominal) {
  parent.insertAdjacentHTML("beforeend", `<p class="muted small">Valores não confirmados: zero é apenas o ponto de partida. Aportes de previdência são desembolsos, com eventual patrimônio/resgate desconhecido; não são integralmente uma taxa perdida. Não duplique cobranças já incluídas em seguros ou despesas iniciais.</p>`);
  const pg = document.createElement("div");
  pg.className = "grid g3";
  parent.append(pg);
  numberField(pg, `${prefix}_package_initial`, "Pacote: pagamento inicial (R$)", ZERO);
  numberField(pg, `${prefix}_package_monthly`, "Pacote: mensalidade (R$)", ZERO);
  intField(pg, `${prefix}_package_months`, "Pacote: duração (meses)", 420, 0, 600);
  numberField(pg, `${prefix}_pension_initial`, "Previdência: aporte inicial (R$)", ZERO);
  numberField(pg, `${prefix}_pension_monthly`, "Previdência: aporte mensal (R$)", ZERO);
  intField(pg, `${prefix}_pension_months`, "Previdência: duração (meses)", 420, 0, 600);
  checkbox(parent, `${prefix}_compare`, "Comparar com juros sem desconto do pacote", false);
  const nd = document.createElement("div");
  nd.id = `${prefix}_no_discount_box`;
  nd.hidden = true;
  parent.append(nd);
  numberField(nd, `${prefix}_no_discount`, "Juros sem desconto (% a.a., mesmo tipo da taxa acima)", nominal, { max: 100 });
  $(`${prefix}_compare`).addEventListener("change", (e) => { nd.hidden = !e.target.checked; });
}

function readRate(prefix, key) {
  const p = presets[key];
  const kind = $(`${prefix}_kind`).value;
  const annual = read(`${prefix}_rate`);
  let effective = annual;
  const precision = key === "tr_plus" && $(`${prefix}_precision`)?.checked;
  if (precision && kind === "nominal" && annual.eq(new D(p.annual_nominal))) effective = bases[key].annual_rate;
  const equivalent = monthlyRate(effective, kind).plus(1).pow(12).minus(1).times(100);
  $(`${prefix}_equivalent`).textContent = (effective.eq(annual) ? "" : "Exibida no PDF: 10,65% nominal a.a. · Usada no cálculo: 10,654% (inferida da evolução). ")
    + `Equivalente efetiva: ${formatBrazilian(equivalent, 4)}% a.a. · Padrão PDF: ${formatBrazilian(new D(p.annual_nominal))}% nominal a.a.`;
  return { kind, effective };
}

function readCosts(prefix, base) {
  return {
    mip_percent: read(`${prefix}_mip`), dfi_percent: read(`${prefix}_dfi`), administration: read(`${prefix}_admin`), initial: read(`${prefix}_initial`),
    package_initial: read(`${prefix}_package_initial`), package_monthly: read(`${prefix}_package_monthly`), package_months: read(`${prefix}_package_months`),
    pension_initial: read(`${prefix}_pension_initial`), pension_monthly: read(`${prefix}_pension_monthly`), pension_months: read(`${prefix}_pension_months`),
    zero_insurance_at_payoff: $(`${prefix}_zero`).checked, mip_basis: "closing", mip_bands: $(`${prefix}_curve`).checked ? base.costs.mip_bands : [],
  };
}

// ---------- Abas ----------
const TABS = ["simular", "antes", "comparar"];
const HASH = { simular: "#simular", antes: "#antes-depois", comparar: "#comparar" };
function setTab(name, focus = false) {
  activeTab = name;
  for (const t of TABS) {
    const tab = $(`tab-${t}`), on = t === name;
    tab.setAttribute("aria-selected", String(on));
    tab.tabIndex = on ? 0 : -1;
    $(`panel-${t}`).hidden = !on;
    if (on && focus) tab.focus();
  }
  history.replaceState(null, "", HASH[name]);
  update();
}
for (const t of TABS) {
  $(`tab-${t}`).addEventListener("click", () => setTab(t));
  $(`tab-${t}`).addEventListener("keydown", (e) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    e.preventDefault();
    const step = e.key === "ArrowRight" ? 1 : TABS.length - 1;
    setTab(TABS[(TABS.indexOf(t) + step) % TABS.length], true);
  });
}
document.querySelectorAll("[data-go]").forEach((b) => b.addEventListener("click", () => { setTab(b.dataset.go); scrollTo(0, 0); }));
activeTab = TABS.find((t) => HASH[t] === location.hash) ?? "simular";

// ---------- Montagem: aba de comparação ----------
const shared = $("shared-fields");
propertyFields(shared, "shared_", new D(530000), new D(370000), 420);
shared.insertAdjacentHTML("beforeend", `<div class="field"><label for="shared_date">Data da simulação</label><input type="date" id="shared_date" value="2026-11-06" min="1900-01-01" max="2100-12-31" /></div>`);
$("shared_date").addEventListener("input", schedule_update);
numberField($("income-fields"), "income", "Renda familiar mensal (R$)", new D("7185.20"));
numberField($("assumption-fields"), "limit", "Limite de comprometimento (%) — hipótese editável", new D(30), { max: 100 });
numberField($("assumption-fields"), "tr", "TR anual hipotética (%)", ZERO, { max: 100 });

const buyersBox = $("buyers");
buyersBox.innerHTML = `<div class="grid g2"><div class="field"><label for="buyer_count">Quantidade de compradores</label><select id="buyer_count">${[1, 2, 3, 4].map((n) => `<option>${n}</option>`).join("")}</select></div></div><div id="buyer_rows"></div>`;
function renderBuyers() {
  const count = Number($("buyer_count").value), rowsBox = $("buyer_rows");
  rowsBox.innerHTML = "";
  for (const id of Object.keys(fields)) if (id.startsWith("share_")) delete fields[id];
  const each = Math.round((100 / count) * 100) / 100;
  for (let i = 0; i < count; i++) {
    const row = document.createElement("div");
    row.className = "grid g2";
    rowsBox.append(row);
    const share = i < count - 1 ? each : Math.round((100 - each * (count - 1)) * 100) / 100;
    numberField(row, `share_${i}`, `Participação comprador ${i + 1} (%)`, new D(share), { max: 100 });
    const right = document.createElement("div");
    row.append(right);
    checkbox(right, `known_${i}`, `Informar nascimento do comprador ${i + 1}`, false);
    right.insertAdjacentHTML("beforeend", `<div class="field" hidden id="birth_wrap_${i}"><label for="birth_${i}">Nascimento ${i + 1}</label><input type="date" id="birth_${i}" value="1989-05-17" /></div>`);
    $(`known_${i}`).addEventListener("change", (e) => { $(`birth_wrap_${i}`).hidden = !e.target.checked; });
  }
  schedule_update();
}
$("buyer_count").addEventListener("change", renderBuyers);
renderBuyers();

for (const key of KEYS) {
  const p = presets[key], base = bases[key];
  const card = document.createElement("section");
  card.className = `card tag-${key === "tr_plus" ? "tr" : "mcmv"}`;
  card.innerHTML = `<h2>${esc(p.name)}</h2><div class="grid g2" id="${key}_property"></div>
    <div class="grid g2" id="${key}_rate_row"></div>
    <div id="${key}_precision_box"></div><p class="muted small" id="${key}_equivalent"></p>
    <details><summary>Seguros, tarifas e despesas iniciais</summary><div id="${key}_costs"></div></details>
    <details><summary>Pacote de serviços e previdência para desconto</summary><div id="${key}_package"></div></details>
    <div class="grid g2" id="${key}_quota_box"></div><div id="${key}_results" aria-live="polite"></div>`;
  $("proposals").append(card);
  propertyFields($(`${key}_property`), key + "_", base.property_value, base.down_payment, base.months);
  rateFields($(`${key}_rate_row`), key, new D(p.annual_nominal));
  if (key === "tr_plus") checkbox($(`${key}_precision_box`), `${key}_precision`, "Usar precisão interna inferida do PDF", false);
  costFields($(`${key}_costs`), key, base);
  packageFields($(`${key}_package`), key, new D(p.annual_nominal));
  numberField($(`${key}_quota_box`), `${key}_quota`, "Cota máxima (%) — referência do PDF, editável", new D(p.quota_percent), { max: 100 });
}

document.querySelectorAll('input[name="mode"]').forEach((r) => r.addEventListener("change", schedule_update));
$("reset-rates").addEventListener("click", () => {
  for (const key of KEYS) {
    setValue(`${key}_rate`, new D(presets[key].annual_nominal));
    $(`${key}_kind`).value = "nominal";
    $(`${key}_kind`).dispatchEvent(new Event("change"));
  }
  $("tr_plus_precision").checked = false;
  schedule_update();
});

// ---------- Montagem: aba de uma proposta ----------
{
  const b = bases.tr_plus, p = presets.tr_plus;
  propertyFields($("s_property"), "s_", b.property_value, b.down_payment, b.months);
  $("s_property").insertAdjacentHTML("beforeend", `<div class="field"><label for="s_date">Data da simulação</label><input type="date" id="s_date" value="${p.date}" min="1900-01-01" max="2100-12-31" /></div>`);
  $("s_date").addEventListener("input", schedule_update);
  rateFields($("s_rate_row"), "s", new D(p.annual_nominal));
  checkbox($("s_precision_box"), "s_precision", "Usar precisão interna inferida do PDF (só TR PLUS com 10,65% nominal)", false);
  numberField($("s_income_row"), "s_income", "Renda familiar mensal (R$)", new D("7185.20"));
  numberField($("s_income_row"), "s_limit", "Limite de comprometimento (%)", new D(30), { max: 100 });
  numberField($("s_income_row"), "s_tr", "TR anual hipotética (%)", ZERO, { max: 100 });
  costFields($("s_costs"), "s", b);
  packageFields($("s_package"), "s", new D(p.annual_nominal));
  numberField($("s_quota_box"), "s_quota", "Cota máxima (%) — referência do PDF, editável", new D(p.quota_percent), { max: 100 });
}
const singleKey = () => document.querySelector('input[name="s_preset"]:checked').value;

function loadSingle(key) {
  const b = bases[key], p = presets[key];
  setValue("s_price", b.property_value);
  setValue("s_down", b.down_payment);
  setValue("s_percent", b.down_payment.div(b.property_value).times(100));
  setValue("s_months", b.months);
  $("s_date").value = p.date;
  $("s_kind").value = "nominal";
  $("s_kind").dispatchEvent(new Event("change"));
  setValue("s_rate", new D(p.annual_nominal));
  $("s_precision").checked = false;
  $("s_precision_box").hidden = key !== "tr_plus";
  $("s_curve").checked = true;
  setValue("s_mip", b.costs.mip_percent);
  setValue("s_dfi", b.costs.dfi_percent.toDecimalPlaces(6, D.ROUND_HALF_EVEN));
  setValue("s_admin", b.costs.administration);
  setValue("s_initial", b.costs.initial);
  $("s_zero").checked = true;
  for (const f of ["package_initial", "package_monthly", "pension_initial", "pension_monthly"]) setValue(`s_${f}`, ZERO);
  setValue("s_package_months", 420);
  setValue("s_pension_months", 420);
  $("s_compare").checked = false;
  $("s_no_discount_box").hidden = true;
  setValue("s_no_discount", new D(p.annual_nominal));
  setValue("s_quota", new D(p.quota_percent));
  $("s_card").className = `card tagged tag-${key === "tr_plus" ? "tr" : "mcmv"}`;
  schedule_update();
}
document.querySelectorAll('input[name="s_preset"]').forEach((r) => r.addEventListener("change", () => loadSingle(singleKey())));
$("s_reset").addEventListener("click", () => loadSingle(singleKey()));

// ---------- Montagem: aba Antes × depois ----------
// Colunas "a" (antes) e "b" (depois), com os mesmos campos da aba Simular e TR própria em cada uma.
const COPY_NUMBERS = ["price", "down", "percent", "months", "rate", "tr", "mip", "dfi", "admin", "initial", "package_initial", "package_monthly",
  "package_months", "pension_initial", "pension_monthly", "pension_months", "no_discount", "quota"];
const COPY_CHECKS = ["precision", "curve", "zero", "compare"];
{
  const b = bases.tr_plus, p = presets.tr_plus;
  numberField($("ad_income_row"), "ad_income", "Renda familiar mensal (R$)", new D("7185.20"));
  numberField($("ad_income_row"), "ad_limit", "Limite de comprometimento (%)", new D(30), { max: 100 });
  for (const col of ["a", "b"]) {
    const card = document.createElement("section");
    card.className = `card tag-${col === "a" ? "antes" : "depois"}`;
    card.innerHTML = `<h2 id="${col}_title"></h2><p class="muted small" id="${col}_base"></p><div class="grid g2" id="${col}_property"></div>
      <div class="grid g2" id="${col}_rate_row"></div>
      <div id="${col}_precision_box"></div><p class="muted small" id="${col}_equivalent"></p>
      <div class="grid g2" id="${col}_tr_row"></div>
      <details><summary>Seguros, tarifas e despesas iniciais</summary><div id="${col}_costs"></div></details>
      <details><summary>Pacote de serviços e previdência para desconto</summary><div id="${col}_package"></div></details>
      <div class="grid g2" id="${col}_quota_box"></div><div id="${col}_results" aria-live="polite"></div>`;
    $("ad_columns").append(card);
    propertyFields($(`${col}_property`), `${col}_`, b.property_value, b.down_payment, b.months);
    $(`${col}_property`).insertAdjacentHTML("beforeend", `<div class="field"><label for="${col}_date">Data da simulação</label><input type="date" id="${col}_date" value="${p.date}" min="1900-01-01" max="2100-12-31" /></div>`);
    $(`${col}_date`).addEventListener("input", schedule_update);
    rateFields($(`${col}_rate_row`), col, new D(p.annual_nominal));
    checkbox($(`${col}_precision_box`), `${col}_precision`, "Usar precisão interna inferida do PDF (só TR PLUS com 10,65% nominal)", false);
    numberField($(`${col}_tr_row`), `${col}_tr`, "TR anual hipotética (%)", ZERO, { max: 100 });
    costFields($(`${col}_costs`), col, b);
    packageFields($(`${col}_package`), col, new D(p.annual_nominal));
    numberField($(`${col}_quota_box`), `${col}_quota`, "Cota máxima (%) — referência do PDF, editável", new D(p.quota_percent), { max: 100 });
  }
}

// Copia a simulação atual para as duas colunas e aplica a mudança da comparação útil só na coluna Depois.
function applyComparison(id) {
  clearTimeout(timer);
  updateSingle();
  const item = singleActions.find((x) => x.id === id);
  if (!item || !singleResult) return;
  const key = singleResult.key;
  for (const col of ["a", "b"]) {
    for (const f of COPY_NUMBERS) {
      fields[`${col}_${f}`].input.value = fields[`s_${f}`].input.value;
      setError(`${col}_${f}`, "");
      fields[`${col}_${f}`].wrap.classList.remove("changed");
    }
    for (const c of COPY_CHECKS) $(`${col}_${c}`).checked = $(`s_${c}`).checked;
    $(`${col}_kind`).value = $("s_kind").value;
    rateLabel(col);
    $(`${col}_date`).value = $("s_date").value;
    $(`${col}_precision_box`).hidden = key !== "tr_plus";
    $(`${col}_no_discount_box`).hidden = !$(`${col}_compare`).checked;
    $(`${col}_base`).textContent = `Base: ${presets[key].name}`;
  }
  for (const f of ["income", "limit"]) { fields[`ad_${f}`].input.value = fields[`s_${f}`].input.value; setError(`ad_${f}`, ""); }
  const { field, value, label, from, to } = item.patch;
  setValue(`b_${field}`, value);
  if (field === "down") synchronize("b_", "down");
  fields[`b_${field}`].wrap.classList.add("changed");
  $("a_title").textContent = "Antes: sua simulação";
  $("b_title").textContent = `Depois: ${item.title}`;
  $("ad_heading").textContent = `Antes × depois: ${item.title}`;
  $("ad_change").innerHTML = `Mudança aplicada só na coluna Depois: <strong>${esc(label)}</strong> de ${esc(from)} para ${esc(to)}. Base: ${esc(presets[key].name)}.`;
  beforeAfter = { key, title: item.title };
  if ($("ad_monthly").open) $("ad_monthly").open = false;
  setTab("antes");
  scrollTo(0, 0);
}
$("s_actions").addEventListener("click", (e) => {
  const button = e.target.closest("button[data-action]");
  if (button) applyComparison(button.dataset.action);
});

$("summary-refs").innerHTML = table(["Modalidade", "Primeira", "Última", "Total"],
  KEYS.map((k) => [presets[k].name, brl(new D(presets[k].first_summary)), brl(new D(presets[k].last_summary)), brl(new D(presets[k].total_summary))]));

// ---------- Cálculo ----------
function schedule_update() {
  clearTimeout(timer);
  timer = setTimeout(update, 200);
}

function update() {
  if (activeTab === "comparar") updateCompare();
  else if (activeTab === "antes") updateBeforeAfter();
  else updateSingle();
}

function table(head, rows) {
  return `<table><thead><tr>${head.map((h) => `<th scope="col">${esc(h)}</th>`).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
}
const metric = (k, v) => `<div class="metric"><div class="k">${esc(k)}</div><div class="v">${esc(v)}</div></div>`;

function readShared() {
  const pdf = document.querySelector('input[name="mode"]:checked').value === "pdf";
  $("shared-fields").hidden = pdf;
  $("mode-note").hidden = !pdf;
  $("tr-note").textContent = pdf ? "TR zero na reprodução, como nas tabelas. O campo de TR só se aplica ao modo comparativo." : "";
  const out = { pdf, income: read("income"), limit: read("limit"), tr: pdf ? ZERO : read("tr") };
  const count = Number($("buyer_count").value);
  out.buyers = Array.from({ length: count }, (_, i) => ({ share_percent: read(`share_${i}`), birth_date: $(`known_${i}`).checked ? $(`birth_${i}`).value : null }));
  if (!pdf) {
    out.price = read("shared_price"); out.down = read("shared_down"); read("shared_percent"); out.months = read("shared_months");
    if (!$("shared_date").value) throw new FieldError("Data da simulação: informe uma data.");
    out.date = parseDate($("shared_date").value);
    if (out.down.gt(out.price)) throw new FieldError("A entrada não pode superar o valor do imóvel.");
  }
  return out;
}

function compute(key, sh) {
  const base = bases[key];
  let price = base.property_value, down = base.down_payment, months = base.months;
  if (sh.pdf) {
    price = read(`${key}_price`); down = read(`${key}_down`); read(`${key}_percent`); months = read(`${key}_months`);
    if (down.gt(price)) throw new FieldError("A entrada não pode superar o valor do imóvel.");
  }
  const { kind, effective } = readRate(key, key);
  const costs = readCosts(key, base);
  const noDiscount = $(`${key}_compare`).checked ? read(`${key}_no_discount`) : null;
  const quota = read(`${key}_quota`);
  const scenario = {
    ...base, annual_rate: effective, rate_kind: kind, costs, tr_annual: sh.tr,
    ...(sh.pdf ? { property_value: price, down_payment: down, months }
      : { property_value: sh.price, down_payment: sh.down, months: sh.months, simulation_date: sh.date, buyers: sh.buyers }),
  };
  const rows = schedule(scenario);
  const total = totals(scenario, rows);
  const afford = minimumDownPayment(scenario, sh.income, sh.limit, quota);
  return { scenario, rows, total, afford, annual: annualSummary(rows), noDiscount };
}

function resultsHtml(key, r, income) {
  const { scenario: s, total: t, afford: a } = r;
  const commitment = income.isZero() ? null : t.maximum.div(income).times(100);
  let html = `<div class="metrics">${metric("Valor financiado", brl(s.property_value.minus(s.down_payment)))}${metric("Desembolso completo", brl(t.full_outflow))}
    ${metric("Primeiro desembolso mensal", brl(t.first))}${metric("Último desembolso mensal", brl(t.last))}${metric("Maior desembolso mensal", brl(t.maximum))}
    ${metric("Maior comprometimento da renda", commitment ? formatBrazilian(commitment) + "%" : "indisponível")}</div>
    <p class="muted small">Entrada ${brl(s.down_payment)} · ${s.months} meses · ${formatDate(s.simulation_date)}</p>`;
  html += `<div class="table-scroll">${table(["Componente", "Valor"], [
    ["Juros", t.interest], ["Correção TR amortizada", t.correction], ["MIP", t.mip], ["DFI", t.dfi], ["Tarifas mensais", t.administration],
    ["Total das parcelas do financiamento", t.installment], ["Pacote mensal acumulado", t.package], ["Previdência mensal acumulada", t.pension],
    ["Despesas e aportes iniciais", t.initial], ["Aportes totais de previdência", t.pension_contributions]].map(([k, v]) => [k, brl(v)]))}</div>`;
  html += `<p>Entrada estimada pela cota: <strong>${brl(a.quota)}</strong><br>Entrada estimada pelo orçamento: <strong>${brl(a.income)}</strong><br>Entrada mínima combinada: <strong>${brl(a.minimum)}</strong></p>`;
  if (s.down_payment.lt(a.minimum)) html += `<div class="alert warn">Entrada abaixo dos parâmetros simulados de renda/cota. A entrada digitada foi preservada.</div>`;
  html += `<p class="muted small">Estimativa matemática pelo maior desembolso mensal, incluindo pacote e previdência. Não é análise de crédito nem confirmação de elegibilidade ao programa.</p>
    <p class="muted small">CET histórico do PDF: ${formatBrazilian(new D(presets[key].cet_historical))}% a.a. · CET desta simulação: indisponível, sem validação normativa do fluxo.</p>`;
  if (r.noDiscount) {
    const c = packageComparison(s, r.noDiscount);
    html += `<p>Sem pacote/previdência: <strong>${brl(c.without_package)}</strong><br>Economia bruta com desconto e aportes: <strong>${brl(c.gross_saving)}</strong></p>
      <p class="muted small">Valor negativo indica maior desembolso com pacote. Comparação nominal, sem valor presente, rendimentos, tributos ou resgates. Encerrar os aportes não cancela automaticamente o desconto: confirme essa condição no contrato.</p>`;
  }
  return html;
}

// ---------- Gráficos ----------
function chartTheme() {
  const css = getComputedStyle(document.documentElement);
  const v = (name) => css.getPropertyValue(name).trim();
  return { v, grid: v("--border"), text: v("--muted"), nf: new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }) };
}

function drawChart(id, type, labels, datasets, title, callbacks, stacked = false) {
  const { grid, text, nf } = chartTheme();
  charts[id]?.destroy();
  charts[id] = new Chart($(id), {
    type, data: { labels, datasets },
    options: {
      responsive: true, maintainAspectRatio: false, interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { labels: { color: text } },
        title: { display: true, text: title, color: text },
        tooltip: { callbacks: { title: (items) => `Ano ${items[0].label}`, ...callbacks } },
      },
      scales: {
        x: { stacked, title: { display: true, text: "Ano do contrato", color: text }, ticks: { color: text, maxTicksLimit: 12 }, grid: { color: grid } },
        y: { stacked, ticks: { color: text, callback: (v) => nf.format(v) }, grid: { color: grid } },
      },
    },
  });
}

// Duas séries lado a lado. names/colors: chave da série → rótulo / variável CSS.
const COMPARE_VIEW = { mean: "chart-mean", balance: "chart-balance", table: "annual-table", names: SHORT, colors: { tr_plus: "--tr", mcmv: "--mcmv" } };
const BEFORE_AFTER_VIEW = { mean: "ad-chart-mean", balance: "ad-chart-balance", table: "ad_annual_table", names: { a: "Antes", b: "Depois" }, colors: { a: "--tr", b: "--c4" } };

function renderCharts(results, view = COMPARE_VIEW) {
  if (!window.Chart) return;
  const { v, nf } = chartTheme();
  const years = Math.max(...Object.values(results).map((r) => r.annual.length));
  const labels = Array.from({ length: years }, (_, i) => i + 1);
  const make = (id, field, title) => {
    const datasets = Object.entries(results).map(([k, r]) => ({
      label: view.names[k], data: r.annual.map((a) => a[field].toNumber()), borderColor: v(view.colors[k]), backgroundColor: v(view.colors[k]),
      pointRadius: 0, borderWidth: 2, tension: 0, annual: r.annual,
    }));
    drawChart(id, "line", labels, datasets, title, {
      label: (c) => {
        const a = c.dataset.annual[c.dataIndex];
        if (!a) return "";
        return field === "mean"
          ? `${c.dataset.label}: média ${nf.format(a.mean.toNumber())} · mín. ${nf.format(a.minimum.toNumber())} · máx. ${nf.format(a.maximum.toNumber())} · total ${nf.format(a.total.toNumber())} (${a.months} meses)`
          : `${c.dataset.label}: ${nf.format(a.balance.toNumber())}`;
      },
    });
  };
  make(view.mean, "mean", "Média mensal de desembolso (R$)");
  make(view.balance, "balance", "Saldo ao final do ano (R$)");
}

function renderAnnualTable(results, view = COMPARE_VIEW) {
  const keys = Object.keys(view.names);
  const labels = [["mean", "Média mensal"], ["total", "Total anual"], ["balance", "Saldo final"], ["minimum", "Mínimo"],
    ["maximum", "Máximo"], ["installments", "Parcelas do financiamento"], ["months", "Meses"]];
  const years = Math.max(...Object.values(results).map((r) => r.annual.length));
  const head = ["Ano", ...labels.flatMap(([, l]) => keys.map((k) => `${l} · ${view.names[k]}`))];
  const rows = Array.from({ length: years }, (_, i) => [String(i + 1), ...labels.flatMap(([f]) => keys.map((k) => {
    const a = results[k]?.annual[i];
    if (!a) return "—";
    return f === "months" ? String(a.months) : brl(a[f]);
  }))]);
  $(view.table).innerHTML = table(head, rows);
}

// ---------- Tabela mensal e CSV ----------
const MONTHLY = [["month", "Mês"], ["due_date", "Vencimento"], ["correction", "Correção TR"], ["amortization", "Amortização"],
  ["interest", "Juros"], ["mip", "MIP"], ["dfi", "DFI"], ["administration", "Tarifa"], ["installment", "Encargo financiamento"],
  ["package", "Pacote"], ["pension", "Previdência"], ["outflow", "Desembolso mensal"], ["balance", "Saldo"]];
const cell = (row, f, csv) => f === "month" ? String(row.month) : f === "due_date" ? formatDate(row.due_date)
  : csv ? formatBrazilian(row[f]).replaceAll(".", "") : brl(row[f]);

function monthlyInto(detailsId, boxId, entries) {
  if (!$(detailsId).open) return;
  const box = $(boxId);
  box.innerHTML = "";
  for (const { title, file, rows } of entries) {
    const section = document.createElement("div");
    section.innerHTML = `<h3>${esc(title)}</h3><div class="table-scroll monthly-table">${table(MONTHLY.map(([, l]) => l), rows.map((row) => MONTHLY.map(([f]) => cell(row, f))))}</div>`;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "secondary";
    button.textContent = "Baixar CSV (separador ; e decimal ,)";
    button.addEventListener("click", () => {
      const lines = [MONTHLY.map(([, l]) => l).join(";"), ...rows.map((row) => MONTHLY.map(([f]) => cell(row, f, true)).join(";"))];
      const blob = new Blob(["﻿" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
      const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: file });
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    });
    section.append(button);
    box.append(section);
  }
}
const renderMonthly = () => monthlyInto("monthly", "monthly-content",
  Object.entries(lastResults).map(([key, r]) => ({ title: presets[key].name, file: `${key}.csv`, rows: r.rows })));
const renderSingleMonthly = () => monthlyInto("s_monthly", "s_monthly_content", singleResult?.rows.length
  ? [{ title: `Simulação a partir de ${presets[singleResult.key].name}`, file: `simulacao_${singleResult.key}.csv`, rows: singleResult.rows }] : []);
const renderBeforeAfterMonthly = () => monthlyInto("ad_monthly", "ad_monthly_content",
  Object.entries(adResults).filter(([, r]) => r.rows.length).map(([col, r]) => ({
    title: col === "a" ? "Antes: sua simulação" : `Depois: ${beforeAfter.title}`, file: col === "a" ? "antes.csv" : "depois.csv", rows: r.rows })));
$("monthly").addEventListener("toggle", renderMonthly);
$("s_monthly").addEventListener("toggle", renderSingleMonthly);
$("ad_monthly").addEventListener("toggle", renderBeforeAfterMonthly);

// ---------- Atualização: antes × depois ----------
function updateBeforeAfter() {
  $("ad_empty").hidden = !!beforeAfter;
  $("ad_content").hidden = !beforeAfter;
  if (!beforeAfter) return;
  let income, limit;
  try { income = read("ad_income"); limit = read("ad_limit"); } catch (e) {
    for (const col of ["a", "b"]) $(`${col}_results`).innerHTML = `<div class="alert error">${esc(e.message)}</div>`;
    return;
  }
  const results = {};
  for (const col of ["a", "b"]) {
    try {
      const r = computeColumn(col, beforeAfter.key, income, limit);
      results[col] = r;
      $(`${col}_results`).innerHTML = resultsHtml(beforeAfter.key, r, income);
    } catch (e) {
      $(`${col}_results`).innerHTML = `<div class="alert error">${esc(e.message)}</div>`;
    }
  }
  adResults = results;
  if (results.a && results.b) {
    const A = results.a.total, B = results.b.total, sa = results.a.scenario, sb = results.b.scenario;
    const insurance = (t) => t.mip.plus(t.dfi);
    const rows = [["Desembolso completo", A.full_outflow, B.full_outflow], ["Entrada", sa.down_payment, sb.down_payment],
      ["Primeiro desembolso mensal", A.first, B.first], ["Maior desembolso mensal", A.maximum, B.maximum], ["Último desembolso mensal", A.last, B.last],
      ["Juros", A.interest, B.interest], ["Correção TR amortizada", A.correction, B.correction], ["Seguros (MIP + DFI)", insurance(A), insurance(B)],
      ["Entrada mínima combinada", results.a.afford.minimum, results.b.afford.minimum]];
    const diff = B.full_outflow.minus(A.full_outflow);
    $("ad_difference").innerHTML = `<h2>Diferença: Depois − Antes</h2>
      <p>Desembolso completo: <strong>${brl(diff)}</strong>. ${diff.isNegative() && !diff.isZero() ? "O Depois desembolsa menos." : diff.isZero() ? "Sem diferença." : "O Depois desembolsa mais."}</p>
      <div class="table-scroll">${table(["Item", "Antes", "Depois", "Diferença"], rows.map(([k, x, y]) => [k, brl(x), brl(y), brl(y.minus(x))]))}</div>
      <p class="muted small">Desembolso completo = entrada + parcelas do financiamento + pacote/previdência mensais + despesas/aportes iniciais. Valores nominais, sem inflação nem valor presente.</p>`;
  } else {
    $("ad_difference").innerHTML = `<h2>Diferença: Depois − Antes</h2><p class="muted">Corrija os campos destacados para comparar.</p>`;
  }
  const withRows = Object.fromEntries(Object.entries(results).filter(([, r]) => r.rows.length));
  if (Object.keys(withRows).length) { renderCharts(withRows, BEFORE_AFTER_VIEW); renderAnnualTable(withRows, BEFORE_AFTER_VIEW); }
  renderBeforeAfterMonthly();
}

// ---------- Atualização: comparação ----------
function updateCompare() {
  let sh;
  try { sh = readShared(); } catch (e) {
    for (const k of KEYS) $(`${k}_results`).innerHTML = `<div class="alert error">${esc(e.message)}</div>`;
    return;
  }
  const results = {};
  for (const key of KEYS) {
    try {
      const r = compute(key, sh);
      results[key] = r;
      $(`${key}_results`).innerHTML = resultsHtml(key, r, sh.income);
    } catch (e) {
      $(`${key}_results`).innerHTML = `<div class="alert error">${esc(e.message)}</div>`;
    }
  }
  lastResults = results;
  if (results.tr_plus && results.mcmv) {
    const diff = results.tr_plus.total.full_outflow.minus(results.mcmv.total.full_outflow);
    $("difference").innerHTML = `<h2>Diferença no desembolso completo</h2><p>TR PLUS − MCMV: <strong>${brl(diff)}</strong>. Valores positivos indicam maior desembolso no TR PLUS.</p>
      <p class="muted small">Desembolso completo = entrada + parcelas do financiamento + pacote/previdência mensais + despesas/aportes iniciais. Previdência integra o fluxo bruto, não uma estimativa de perda patrimonial.</p>`;
  } else {
    $("difference").innerHTML = `<h2>Diferença no desembolso completo</h2><p class="muted">Corrija os campos destacados para comparar.</p>`;
  }
  const withRows = Object.fromEntries(Object.entries(results).filter(([, r]) => r.rows.length));
  if (Object.keys(withRows).length) { renderCharts(withRows); renderAnnualTable(withRows); }
  renderMonthly();
}

// ---------- Atualização: uma proposta ----------
// Uma coluna completa (aba Simular: prefixo "s"; aba Antes × depois: "a" e "b").
function computeColumn(prefix, key, income, limit) {
  const base = bases[key];
  const price = read(`${prefix}_price`), down = read(`${prefix}_down`);
  read(`${prefix}_percent`);
  const months = read(`${prefix}_months`);
  if (down.gt(price)) throw new FieldError("A entrada não pode superar o valor do imóvel.");
  if (!$(`${prefix}_date`).value) throw new FieldError("Data da simulação: informe uma data.");
  const tr = read(`${prefix}_tr`);
  const { kind, effective } = readRate(prefix, key);
  const costs = readCosts(prefix, base);
  const noDiscount = $(`${prefix}_compare`).checked ? read(`${prefix}_no_discount`) : null;
  const quota = read(`${prefix}_quota`);
  const scenario = {
    ...base, annual_rate: effective, rate_kind: kind, costs, tr_annual: tr,
    property_value: price, down_payment: down, months, simulation_date: parseDate($(`${prefix}_date`).value),
  };
  const rows = schedule(scenario);
  const total = totals(scenario, rows);
  const afford = minimumDownPayment(scenario, income, limit, quota);
  return { key, scenario, rows, total, afford, annual: annualSummary(rows), noDiscount, income, limit };
}

function computeSingle() {
  const income = read("s_income"), limit = read("s_limit");
  return computeColumn("s", singleKey(), income, limit);
}

function yearly(rows) {
  const out = [];
  for (let i = 0; i < rows.length; i += 12) {
    const g = rows.slice(i, i + 12);
    const add = (f) => g.reduce((a, x) => a.plus(f(x)), ZERO);
    const total = add((x) => x.outflow);
    out.push({
      year: i / 12 + 1, months: g.length, total, mean: total.div(g.length),
      amortization: add((x) => x.amortization), interest: add((x) => x.interest),
      fees: add((x) => x.mip.plus(x.dfi).plus(x.administration)), extras: add((x) => x.package.plus(x.pension)),
      balance: g[g.length - 1].balance,
    });
  }
  return out;
}

const fees = (x) => x.mip.plus(x.dfi).plus(x.administration);
const sumOf = (list, f) => list.reduce((a, x) => a.plus(f(x)), ZERO);
const ratio = (a, b) => (b.isZero() ? ZERO : a.div(b).times(100));
const years = (m) => (m % 12 === 0 ? `${m / 12} anos` : `${formatBrazilian(new D(m).div(12), 1)} anos`);

// Insights: cada um roda o mesmo motor com uma variação e mostra o efeito nos números do usuário.
function insights(r) {
  const { scenario: s, rows, total: t, income, limit } = r;
  const n = rows.length, out = [];
  const run = (patch) => { const v = { ...s, ...patch }; const rr = schedule(v); return { rows: rr, t: totals(v, rr) }; };
  const effective = monthlyRate(s.annual_rate, s.rate_kind).plus(1).pow(12).minus(1).times(100);

  // 1. Entrada maior = aplicar à taxa do financiamento.
  const extra = new D(10000);
  if (principal(s).gt(extra)) {
    const v = run({ down_payment: s.down_payment.plus(extra) });
    // Desembolso completo inclui a entrada: a diferença já desconta os R$ 10 mil adiantados.
    const saving = t.full_outflow.minus(v.t.full_outflow);
    out.push({
      id: "entrada", patch: { field: "down", value: s.down_payment.plus(extra), label: "Entrada", from: brl(s.down_payment), to: brl(s.down_payment.plus(extra)) },
      title: "R$ 10 mil a mais na entrada", value: `economiza ${brl(saving)}`,
      text: `Em juros e seguros ao longo do contrato, já descontados os R$ 10 mil pagos antes, e a 1ª parcela cai ${brl(t.first.minus(v.t.first))}. Na prática é aplicar esse dinheiro à taxa do financiamento (${pct(effective, 2)} a.a. efetiva${s.tr_annual.isZero() ? "" : " + TR"}), sem poder resgatar. Compare com o rendimento líquido do seu dinheiro e com a reserva que você precisa manter.`,
    });
  }

  // 2. Prazo menor pesa pouco na 1ª parcela.
  if (s.months >= 24) {
    const m2 = s.months - (s.months > 180 ? 120 : Math.floor(s.months / 2));
    const v = run({ months: m2 });
    const rise = v.t.first.minus(t.first);
    out.push({
      id: "prazo", patch: { field: "months", value: m2, label: "Prazo", from: `${s.months} meses`, to: `${m2} meses` },
      title: `Prazo de ${years(m2)} em vez de ${years(s.months)}`, value: `economiza ${brl(t.full_outflow.minus(v.t.full_outflow))}`,
      text: `A 1ª parcela sobe ${brl(rise)} (${pct(ratio(rise, t.first))}). No SAC os juros do 1º mês não dependem do prazo; só a amortização muda. Por isso encurtar costuma pesar menos na parcela do que no total.`,
    });
  }

  // 3. Quanto da parcela é juros e quando a amortização vence.
  {
    const f = rows[0];
    const cross = rows.find((x) => x.amortization.gt(x.interest));
    const when = !cross ? "Os juros superam a amortização em todo o contrato."
      : cross.month === 1 ? "A amortização já supera os juros desde o 1º mês."
      : `A amortização só passa a superar os juros no mês ${cross.month} (ano ${Math.ceil(cross.month / 12)}).`;
    out.push({
      title: "Juros dentro da 1ª parcela", value: `${pct(ratio(f.interest, f.installment))} é juros`,
      text: `Dos ${brl(f.installment)} da 1ª parcela, ${brl(f.interest)} são juros e ${brl(f.amortization)} abatem a dívida. ${when}`,
      test: "Para ver: tabela mensal, colunas Amortização e Juros. Taxa, entrada e prazo mudam esse mês.",
    });
  }

  // 4. Concentração dos juros no início.
  if (!t.interest.isZero() && n >= 36) {
    const k = n >= 240 ? 120 : Math.round(n / 3);
    const early = sumOf(rows.slice(0, k), (x) => x.interest);
    out.push({
      title: `Juros dos primeiros ${years(k)}`, value: `${pct(ratio(early, t.interest), 0)} de todos os juros`,
      text: `Esses ${k} meses são ${pct(new D(k).div(n).times(100), 0)} do prazo, mas concentram ${brl(early)} dos ${brl(t.interest)} de juros. Qualquer redução de taxa ou de saldo vale mais no começo do contrato.`,
      test: "Para ver: gráfico anual abaixo, faixa de Juros nos primeiros anos.",
    });
  }

  // 5. Quanto vale 0,5 p.p. de taxa: limite para um pacote.
  if (s.annual_rate.gte("0.5")) {
    const lower = s.annual_rate.minus("0.5");
    const v = run({ annual_rate: lower });
    const saving = t.full_outflow.minus(v.t.full_outflow);
    out.push({
      id: "taxa", patch: { field: "rate", value: lower, label: "Juros", from: rateText(s.annual_rate), to: rateText(lower) },
      title: "0,5 ponto a menos de juros", value: `vale ${brl(saving)}`,
      text: `De ${rateText(s.annual_rate)} para ${rateText(lower)} (${s.rate_kind}), em média ${brl(money(saving.div(n)))} por mês do prazo. Um pacote ou previdência exigido para ganhar esse desconto só compensa, em valores nominais, se custar menos que isso por mês durante todo o prazo.`,
    });
  }

  // 6. TR pequena acumula.
  {
    const up = s.tr_annual.plus(1);
    const v = run({ tr_annual: up });
    const m = Math.min(120, n);
    out.push({
      id: "tr", patch: { field: "tr", value: up, label: "TR anual hipotética", from: rateText(s.tr_annual), to: rateText(up) },
      title: `TR de ${rateText(up)} a.a.`, value: `+${brl(v.t.full_outflow.minus(t.full_outflow))}`,
      text: `Com TR ${s.tr_annual.isZero() ? "zero" : `de ${rateText(s.tr_annual)}`} na simulação, 1 ponto a mais de TR muda a parcela do mês ${m} de ${brl(rows[m - 1].outflow)} para ${brl(v.rows[m - 1].outflow)}. A TR corrige o saldo todo mês, e o efeito acumula com o prazo. Cenário hipotético, não previsão.`,
    });
  }

  // 7. Seguros e tarifa não caem com o saldo.
  {
    const tail = rows.slice(-Math.min(12, n));
    const tailShare = ratio(sumOf(tail, fees), sumOf(tail, (x) => x.installment));
    out.push({
      title: "Seguros e tarifa no fim do contrato", value: `${pct(tailShare, 0)} da parcela no último ano`,
      text: `Na 1ª parcela eles são ${pct(ratio(fees(rows[0]), rows[0].installment))}. O DFI incide sobre o valor do imóvel e a tarifa é fixa: não caem junto com o saldo. No contrato todo somam ${brl(t.mip.plus(t.dfi).plus(t.administration))}.`,
      test: "Para ver: tabela anual abaixo, coluna Seguros e tarifa.",
    });
  }

  // 8. Renda exigida pela maior parcela.
  if (limit.gt(0)) {
    const need = t.maximum.div(limit).times(100).toDecimalPlaces(2, D.ROUND_CEIL);
    const peak = rows.find((x) => x.outflow.eq(t.maximum));
    const later = rows[Math.min(60, n) - 1];
    const gap = income.minus(need);
    out.push({
      title: `Renda para ${rateText(limit)} de comprometimento`, value: brl(need),
      text: `É o que o maior desembolso (${brl(t.maximum)}, mês ${peak.month}) exige. ${gap.gte(0) ? `Sua renda informada passa com folga de ${brl(gap)}.` : `Faltam ${brl(gap.neg())} na renda informada.`} No mês ${later.month} a parcela já é ${brl(later.outflow)}, mas esta simulação, como a entrada mínima, usa a maior.`,
      test: "Para ver: mude a renda, a entrada ou o limite de comprometimento.",
    });
  }
  return out;
}

function renderSingleCharts(y) {
  if (!window.Chart) return;
  const { v, nf } = chartTheme();
  const labels = y.map((a) => a.year);
  const parts = [["amortization", "Amortização", "--tr"], ["interest", "Juros", "--mcmv"], ["fees", "Seguros e tarifa", "--c3"], ["extras", "Pacote e previdência", "--c4"]]
    .filter(([f]) => f !== "extras" || y.some((a) => !a.extras.isZero()));
  drawChart("s-chart-parts", "bar", labels,
    parts.map(([f, label, c]) => ({ label, data: y.map((a) => a[f].toNumber()), backgroundColor: v(c), stack: "s" })),
    "Desembolso de cada ano, por componente (R$)",
    { label: (c) => `${c.dataset.label}: ${nf.format(c.raw)}`, footer: (items) => `Total: ${nf.format(y[items[0].dataIndex].total.toNumber())} (${y[items[0].dataIndex].months} meses)` },
    true);
  drawChart("s-chart-balance", "line", labels,
    [{ label: "Saldo", data: y.map((a) => a.balance.toNumber()), borderColor: v("--tr"), backgroundColor: v("--tr"), pointRadius: 0, borderWidth: 2, tension: 0 }],
    "Saldo ao final do ano (R$)", { label: (c) => `Saldo: ${nf.format(c.raw)}` });
}

function updateSingle() {
  const key = singleKey();
  $("s_title").textContent = `Resultado a partir de ${presets[key].name}`;
  let r;
  try { r = computeSingle(); } catch (e) {
    $("s_results").innerHTML = `<div class="alert error">${esc(e.message)}</div>`;
    singleActions = [];
    $("s_actions").innerHTML = `<p class="muted">Corrija os campos destacados para ver as comparações.</p>`;
    $("s_insights").innerHTML = `<p class="muted">Corrija os campos destacados para ver os insights.</p>`;
    return;
  }
  singleResult = r;
  $("s_results").innerHTML = resultsHtml(key, r, r.income);
  if (!r.rows.length) {
    singleActions = [];
    $("s_actions").innerHTML = `<p class="muted">Sem valor financiado, não há parcelas para comparar.</p>`;
    $("s_insights").innerHTML = `<p class="muted">Sem valor financiado, não há parcelas para analisar.</p>`;
    $("s_annual_table").innerHTML = "";
    for (const id of ["s-chart-parts", "s-chart-balance"]) { charts[id]?.destroy(); delete charts[id]; }
    renderSingleMonthly();
    return;
  }
  const items = insights(r);
  singleActions = items.filter((i) => i.patch);
  $("s_actions").innerHTML = singleActions.map((i) => `<button type="button" class="insight" data-action="${i.id}"><span class="h">${esc(i.title)}</span><span class="v">${esc(i.value)}</span><span class="p">${esc(i.text)}</span><span class="go">Comparar lado a lado →</span></button>`).join("");
  $("s_insights").innerHTML = items.filter((i) => !i.patch).map((i) => `<article class="insight"><h3>${esc(i.title)}</h3><div class="v">${esc(i.value)}</div><p>${esc(i.text)}</p><p class="try">${esc(i.test)}</p></article>`).join("");
  const y = yearly(r.rows);
  renderSingleCharts(y);
  $("s_annual_table").innerHTML = table(["Ano", "Média mensal", "Total anual", "Amortização", "Juros", "Seguros e tarifa", "Pacote e previdência", "Saldo final"],
    y.map((a) => [String(a.year), brl(a.mean), brl(a.total), brl(a.amortization), brl(a.interest), brl(a.fees), brl(a.extras), brl(a.balance)]));
  renderSingleMonthly();
}

$("s_precision_box").hidden = singleKey() !== "tr_plus";
setTab(activeTab);
window.addEventListener("load", update);
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", update);
