import {
  D, ZERO, money, monthlyRate, schedule, totals, annualSummary, minimumDownPayment, packageComparison,
  fromPreset, parseDate, formatDate, parseBrazilian, formatBrazilian,
} from "./engine.js";

const KEYS = ["tr_plus", "mcmv"];
const SHORT = { tr_plus: "TR PLUS", mcmv: "MCMV" };
const brl = (v) => "R$ " + formatBrazilian(v);
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

const [presets, profiles] = await Promise.all(
  ["data/presets.json", "data/calibrated_profiles.json"].map((u) => fetch(u).then((r) => r.json())));
const bases = Object.fromEntries(KEYS.map((k) => [k, fromPreset(presets[k], profiles[k])]));

// ---------- Campos ----------
const fields = {};
let timer, charts = {}, lastResults = {};
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
      const pct = parseBrazilian(fields[prefix + "percent"].input.value);
      fields[prefix + "down"].input.value = formatBrazilian(money(price.times(pct).div(100)));
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

// ---------- Montagem da interface ----------
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
    <div class="grid g2"><div class="field"><label for="${key}_kind">Tipo da taxa anual</label><select id="${key}_kind"><option value="nominal">nominal</option><option value="efetiva">efetiva</option></select></div><div id="${key}_rate_box"></div></div>
    <div id="${key}_precision_box"></div><p class="muted small" id="${key}_equivalent"></p>
    <details><summary>Seguros, tarifas e despesas iniciais</summary><div id="${key}_costs"></div></details>
    <details><summary>Pacote de serviços e previdência para desconto</summary><div id="${key}_package"></div></details>
    <div class="grid g2" id="${key}_quota_box"></div><div id="${key}_results" aria-live="polite"></div>`;
  $("proposals").append(card);
  propertyFields($(`${key}_property`), key + "_", base.property_value, base.down_payment, base.months);
  numberField($(`${key}_rate_box`), `${key}_rate`, "Juros nominais (% a.a.)", new D(p.annual_nominal), { max: 100 });
  $(`${key}_kind`).addEventListener("change", (e) => {
    fields[`${key}_rate`].wrap.querySelector("label").textContent = e.target.value === "nominal" ? "Juros nominais (% a.a.)" : "Juros efetivos (% a.a.)";
    schedule_update();
  });
  if (key === "tr_plus") checkbox($(`${key}_precision_box`), `${key}_precision`, "Usar precisão interna inferida do PDF", false);

  const costs = $(`${key}_costs`);
  checkbox(costs, `${key}_curve`, "Usar curva de MIP inferida deste PDF", true);
  costs.insertAdjacentHTML("beforeend", `<p class="muted small">MIP sobre saldo após amortização; DFI sobre valor do imóvel. A curva reproduz o perfil original por mês do contrato, não uma regra universal. Para outro perfil, desative a curva e informe uma alíquota constante.</p>`);
  const cg = document.createElement("div");
  cg.className = "grid g2";
  costs.append(cg);
  numberField(cg, `${key}_mip`, "MIP mensal constante (%) — usado ao desativar a curva", base.costs.mip_percent);
  numberField(cg, `${key}_dfi`, "DFI mensal (%)", base.costs.dfi_percent.toDecimalPlaces(6, D.ROUND_HALF_EVEN));
  numberField(cg, `${key}_admin`, "Administração mensal (R$)", new D(25));
  numberField(cg, `${key}_initial`, "Despesas iniciais, incluindo avaliação e seguro à vista (R$)", base.costs.initial);
  checkbox(costs, `${key}_zero`, "Zerar seguros no último mês", true);

  const pk = $(`${key}_package`);
  pk.insertAdjacentHTML("beforeend", `<p class="muted small">Valores não confirmados: zero é apenas o ponto de partida. Aportes de previdência são desembolsos, com eventual patrimônio/resgate desconhecido; não são integralmente uma taxa perdida. Não duplique cobranças já incluídas em seguros ou despesas iniciais.</p>`);
  const pg = document.createElement("div");
  pg.className = "grid g3";
  pk.append(pg);
  numberField(pg, `${key}_package_initial`, "Pacote: pagamento inicial (R$)", ZERO);
  numberField(pg, `${key}_package_monthly`, "Pacote: mensalidade (R$)", ZERO);
  intField(pg, `${key}_package_months`, "Pacote: duração (meses)", 420, 0, 600);
  numberField(pg, `${key}_pension_initial`, "Previdência: aporte inicial (R$)", ZERO);
  numberField(pg, `${key}_pension_monthly`, "Previdência: aporte mensal (R$)", ZERO);
  intField(pg, `${key}_pension_months`, "Previdência: duração (meses)", 420, 0, 600);
  checkbox(pk, `${key}_compare`, "Comparar com juros sem desconto do pacote", false);
  const nd = document.createElement("div");
  nd.id = `${key}_no_discount_box`;
  nd.hidden = true;
  pk.append(nd);
  numberField(nd, `${key}_no_discount`, "Juros sem desconto (% a.a., mesmo tipo da taxa acima)", new D(p.annual_nominal), { max: 100 });
  $(`${key}_compare`).addEventListener("change", (e) => { nd.hidden = !e.target.checked; });

  numberField($(`${key}_quota_box`), `${key}_quota`, "Cota máxima (%) — referência do PDF, editável", new D(p.quota_percent), { max: 100 });
}

document.querySelectorAll('input[name="mode"]').forEach((r) => r.addEventListener("change", schedule_update));
$("reset-rates").addEventListener("click", () => {
  for (const key of KEYS) {
    fields[`${key}_rate`].input.value = formatBrazilian(new D(presets[key].annual_nominal), 6, { trim: true });
    $(`${key}_kind`).value = "nominal";
    $(`${key}_kind`).dispatchEvent(new Event("change"));
  }
  $("tr_plus_precision").checked = false;
  schedule_update();
});

$("summary-refs").innerHTML = table(["Modalidade", "Primeira", "Última", "Total"],
  KEYS.map((k) => [presets[k].name, brl(new D(presets[k].first_summary)), brl(new D(presets[k].last_summary)), brl(new D(presets[k].total_summary))]));

// ---------- Cálculo ----------
function schedule_update() {
  clearTimeout(timer);
  timer = setTimeout(update, 200);
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
  const base = bases[key], p = presets[key];
  let price = base.property_value, down = base.down_payment, months = base.months;
  if (sh.pdf) {
    price = read(`${key}_price`); down = read(`${key}_down`); read(`${key}_percent`); months = read(`${key}_months`);
    if (down.gt(price)) throw new FieldError("A entrada não pode superar o valor do imóvel.");
  }
  const kind = $(`${key}_kind`).value;
  const annual = read(`${key}_rate`);
  let effective = annual;
  const precision = key === "tr_plus" && $("tr_plus_precision").checked;
  if (precision && kind === "nominal" && annual.eq(new D(p.annual_nominal))) effective = base.annual_rate;
  const equivalent = monthlyRate(effective, kind).plus(1).pow(12).minus(1).times(100);
  $(`${key}_equivalent`).textContent = (effective.eq(annual) ? "" : "Exibida no PDF: 10,65% nominal a.a. · Usada no cálculo: 10,654% (inferida da evolução). ")
    + `Equivalente efetiva: ${formatBrazilian(equivalent, 4)}% a.a. · Padrão PDF: ${formatBrazilian(new D(p.annual_nominal))}% nominal a.a.`;
  const useCurve = $(`${key}_curve`).checked;
  const compare = $(`${key}_compare`).checked;
  const costs = {
    mip_percent: read(`${key}_mip`), dfi_percent: read(`${key}_dfi`), administration: read(`${key}_admin`), initial: read(`${key}_initial`),
    package_initial: read(`${key}_package_initial`), package_monthly: read(`${key}_package_monthly`), package_months: read(`${key}_package_months`),
    pension_initial: read(`${key}_pension_initial`), pension_monthly: read(`${key}_pension_monthly`), pension_months: read(`${key}_pension_months`),
    zero_insurance_at_payoff: $(`${key}_zero`).checked, mip_basis: "closing", mip_bands: useCurve ? base.costs.mip_bands : [],
  };
  const noDiscount = compare ? read(`${key}_no_discount`) : null;
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

function renderProposal(key, r, sh) {
  const { scenario: s, total: t, afford: a } = r;
  const commitment = sh.income.isZero() ? null : t.maximum.div(sh.income).times(100);
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
  $(`${key}_results`).innerHTML = html;
}

function renderCharts(results) {
  if (!window.Chart) return;
  const css = getComputedStyle(document.documentElement);
  const color = { tr_plus: css.getPropertyValue("--tr").trim(), mcmv: css.getPropertyValue("--mcmv").trim() };
  const grid = css.getPropertyValue("--border").trim(), text = css.getPropertyValue("--muted").trim();
  const nf = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
  const years = Math.max(...Object.values(results).map((r) => r.annual.length));
  const labels = Array.from({ length: years }, (_, i) => i + 1);
  const make = (id, field, title) => {
    const datasets = Object.entries(results).map(([k, r]) => ({
      label: SHORT[k], data: r.annual.map((a) => a[field].toNumber()), borderColor: color[k], backgroundColor: color[k],
      pointRadius: 0, borderWidth: 2, tension: 0, annual: r.annual,
    }));
    charts[id]?.destroy();
    charts[id] = new Chart($(id), {
      type: "line", data: { labels, datasets },
      options: {
        responsive: true, maintainAspectRatio: false, interaction: { mode: "index", intersect: false },
        plugins: {
          legend: { labels: { color: text } },
          title: { display: true, text: title, color: text },
          tooltip: { callbacks: {
            title: (items) => `Ano ${items[0].label}`,
            label: (c) => {
              const a = c.dataset.annual[c.dataIndex];
              if (!a) return "";
              return field === "mean"
                ? `${c.dataset.label}: média ${nf.format(a.mean.toNumber())} · mín. ${nf.format(a.minimum.toNumber())} · máx. ${nf.format(a.maximum.toNumber())} · total ${nf.format(a.total.toNumber())} (${a.months} meses)`
                : `${c.dataset.label}: ${nf.format(a.balance.toNumber())}`;
            },
          } },
        },
        scales: {
          x: { title: { display: true, text: "Ano do contrato", color: text }, ticks: { color: text, maxTicksLimit: 12 }, grid: { color: grid } },
          y: { ticks: { color: text, callback: (v) => nf.format(v) }, grid: { color: grid } },
        },
      },
    });
  };
  make("chart-mean", "mean", "Média mensal de desembolso (R$)");
  make("chart-balance", "balance", "Saldo ao final do ano (R$)");
}

function renderAnnualTable(results) {
  const labels = [["mean", "Média mensal"], ["total", "Total anual"], ["balance", "Saldo final"], ["minimum", "Mínimo"],
    ["maximum", "Máximo"], ["installments", "Parcelas do financiamento"], ["months", "Meses"]];
  const years = Math.max(...Object.values(results).map((r) => r.annual.length));
  const head = ["Ano", ...labels.flatMap(([, l]) => KEYS.map((k) => `${l} · ${SHORT[k]}`))];
  const rows = Array.from({ length: years }, (_, i) => [String(i + 1), ...labels.flatMap(([f]) => KEYS.map((k) => {
    const a = results[k]?.annual[i];
    if (!a) return "—";
    return f === "months" ? String(a.months) : brl(a[f]);
  }))]);
  $("annual-table").innerHTML = table(head, rows);
}

const MONTHLY = [["month", "Mês"], ["due_date", "Vencimento"], ["correction", "Correção TR"], ["amortization", "Amortização"],
  ["interest", "Juros"], ["mip", "MIP"], ["dfi", "DFI"], ["administration", "Tarifa"], ["installment", "Encargo financiamento"],
  ["package", "Pacote"], ["pension", "Previdência"], ["outflow", "Desembolso mensal"], ["balance", "Saldo"]];
const cell = (row, f, csv) => f === "month" ? String(row.month) : f === "due_date" ? formatDate(row.due_date)
  : csv ? formatBrazilian(row[f]).replaceAll(".", "") : brl(row[f]);

function renderMonthly() {
  if (!$("monthly").open) return;
  const box = $("monthly-content");
  box.innerHTML = "";
  for (const [key, r] of Object.entries(lastResults)) {
    const section = document.createElement("div");
    section.innerHTML = `<h3>${esc(presets[key].name)}</h3><div class="table-scroll monthly-table">${table(MONTHLY.map(([, l]) => l), r.rows.map((row) => MONTHLY.map(([f]) => cell(row, f))))}</div>`;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "secondary";
    button.textContent = "Baixar CSV (separador ; e decimal ,)";
    button.addEventListener("click", () => {
      const lines = [MONTHLY.map(([, l]) => l).join(";"), ...r.rows.map((row) => MONTHLY.map(([f]) => cell(row, f, true)).join(";"))];
      const blob = new Blob(["﻿" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
      const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: `${key}.csv` });
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    });
    section.append(button);
    box.append(section);
  }
}
$("monthly").addEventListener("toggle", renderMonthly);

function update() {
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
      renderProposal(key, r, sh);
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

window.addEventListener("load", update);
if (document.readyState === "complete") update();
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => renderCharts(lastResults));
