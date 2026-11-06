from dataclasses import asdict, replace
from datetime import date
from decimal import Decimal as D
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
import pandas as pd
import plotly.graph_objects as go
import streamlit as st

from financiamento.affordability import minimum_down_payment
from financiamento.models import Buyer, Costs, money, monthly_rate
from financiamento.localization import format_brazilian, parse_brazilian
from financiamento.sac import schedule
from financiamento.scenarios import from_preset, package_comparison, presets
from financiamento.summaries import annual_summary, totals


def brl(value):
    return "R$ " + format_brazilian(value)


def normalize_input(key, places, on_change, args):
    try:
        value = parse_brazilian(st.session_state[key])
        # Não arredondar uma entrada inválida antes de mostrar o erro.
        if value != value.quantize(D(1).scaleb(-places)):
            return
        st.session_state[key] = format_brazilian(value, places, trim=True)
        if on_change:
            on_change(*args)
    except ValueError:
        pass


def num(label, value, key, *, maximum=None, minimum=0, step=0.01, disabled=False, on_change=None, args=()):
    places = 2 if "(R$)" in label else 6
    if key not in st.session_state or not isinstance(st.session_state[key], str):
        st.session_state[key] = format_brazilian(st.session_state.get(key, value), places, trim=True)
    text = st.text_input(label, key=key, disabled=disabled,
                         on_change=normalize_input, args=(key, places, on_change, args))
    try:
        parsed = parse_brazilian(text)
        if parsed < D(str(minimum)) or maximum is not None and parsed > D(str(maximum)):
            raise ValueError(f"Valor deve estar entre {format_brazilian(minimum)} e {format_brazilian(maximum)}." if maximum is not None
                             else f"Valor deve ser pelo menos {format_brazilian(minimum)}.")
        if parsed != parsed.quantize(D(1).scaleb(-places)):
            raise ValueError(f"Use no máximo {places} casas decimais.")
        return parsed
    except ValueError as error:
        st.error(f"{label}: {error}")
        st.stop()


def synchronize(source, prefix=""):
    price = parse_brazilian(st.session_state[prefix + "price"])
    down = parse_brazilian(st.session_state[prefix + "down"])
    if source == "percent":
        percent = parse_brazilian(st.session_state[prefix + "percent"])
        st.session_state[prefix + "down"] = format_brazilian(money(price * percent / 100))
    else:
        st.session_state[prefix + "percent"] = format_brazilian(down / price * 100 if price else 0, 6, trim=True)


def reset_rates():
    for key, preset in presets().items():
        st.session_state[f"{key}_rate"] = format_brazilian(preset["annual_nominal"])
        st.session_state[f"{key}_kind"] = "nominal"
    st.session_state.tr_plus_precision = False


def frame(rows):
    return pd.DataFrame([{k: float(v) if isinstance(v, D) else v for k, v in asdict(r).items()}
                         for r in rows])


st.set_page_config(page_title="Financiamento | SAC", page_icon="⌂", layout="wide")
st.title("Compare seu financiamento")
st.caption("SAC · Referências CAIXA de novembro de 2026 · Cálculo local e transparente")
st.info("Modelo calibrado contra as 420 parcelas de cada PDF. Curvas de MIP inferidas para os perfis originais, "
        "sem tabela etária universal. A última parcela inclui o residual de amortização omitido no fluxo do PDF. "
        "Pacote e previdência continuam separados: informe eventuais cobranças abaixo.")
mode = st.radio("Modo de comparação", ["Comparar nas mesmas condições", "Reproduzir PDFs (aproximação)"], index=1, horizontal=True, key="comparison_mode_br")
original = mode.startswith("Reproduzir")
if original:
    st.info("Cada modalidade começa com imóvel, entrada, prazo e data do seu PDF. Os campos podem ser editados. "
            "Nos PDFs, as entradas diferem em R$ 21.537,01; a diferença de desembolso não decorre apenas dos juros. "
            "Juros e custos continuam editáveis; use o botão para restaurar as taxas dos PDFs.")

if not original:
    c1, c2, c3 = st.columns(3)
    with c1:
        price = num("Valor do imóvel (R$)", 530000, "price", minimum=0.01, on_change=synchronize, args=("price",))
    with c2:
        down = num("Entrada (R$)", 370000, "down", on_change=synchronize, args=("down",))
    with c3:
        num("Entrada (%)", D(370000) / 530000 * 100, "percent", maximum=100, on_change=synchronize, args=("percent",))
    c1, c2 = st.columns(2)
    months = c1.number_input("Prazo (meses)", min_value=1, max_value=600, value=420)
    simulation_date = c2.date_input("Data da simulação", value=date(2026, 11, 6), format="DD/MM/YYYY",
                                    min_value=date(1900, 1, 1), max_value=date(2100, 12, 31))
    if down > price:
        st.error("A entrada não pode superar o valor do imóvel.")
        st.stop()
income = num("Renda familiar mensal (R$)", "7185.20", "income")

with st.expander("Premissas compartilhadas e perfil dos compradores"):
    limit = num("Limite de comprometimento (%) — hipótese editável", 30, "limit", maximum=100.0)
    tr = num("TR anual hipotética (%)", 0, "tr", maximum=100.0)
    if original:
        tr = D(0)
        st.caption("TR zero na reprodução, como nas tabelas. O campo acima só se aplica ao modo comparativo.")
    st.caption("Cenário de TR: saldo corrigido antes dos juros; amortização recalculada pelo prazo restante. "
               "Hipótese matemática, sem previsão da TR nem garantia da convenção do contrato.")
    count = st.number_input("Quantidade de compradores", min_value=1, max_value=4, value=1)
    buyers = []
    for index in range(count):
        left, right = st.columns(2)
        default_share = round(100 / count, 2) if index < count - 1 else round(100 - round(100 / count, 2) * (count - 1), 2)
        with left:
            share = num(f"Participação comprador {index + 1} (%)", default_share, f"share_{count}_{index}", maximum=100)
        known = right.checkbox(f"Informar nascimento do comprador {index + 1}", key=f"known_{index}")
        birth = right.date_input(f"Nascimento {index + 1}", value=date(1989, 5, 17),
                                 min_value=date(1900, 1, 1), max_value=date(2100, 12, 31), key=f"birth_{index}") if known else None
        buyers.append(Buyer(D(str(share)), birth))
    st.caption("Perfil apenas informativo: idade e participação não recalculam a curva de seguro inferida do PDF. "
               "MCMV original: nascimento 17/05/1989; TR PLUS: não informado. "
               "No modo PDF, preservamos esses perfis originais.")

st.button("Restaurar juros dos PDFs", on_click=reset_rates)
results = {}
for column, (key, preset) in zip(st.columns(2), presets().items()):
    with column:
        st.subheader(preset["name"])
        base = from_preset(key)
        if original:
            proposal_price = num("Valor do imóvel (R$)", base.property_value, f"{key}_price", minimum=0.01,
                                 on_change=synchronize, args=("price", key + "_"))
            proposal_down = num("Entrada (R$)", base.down_payment, f"{key}_down", on_change=synchronize, args=("down", key + "_"))
            num("Entrada (%)", base.down_payment / base.property_value * 100, f"{key}_percent", maximum=100,
                on_change=synchronize, args=("percent", key + "_"))
            proposal_months = st.number_input("Prazo (meses)", min_value=1, max_value=600, value=base.months, key=f"{key}_months")
            if proposal_down > proposal_price:
                st.error("A entrada não pode superar o valor do imóvel.")
                continue
        kind = st.selectbox("Tipo da taxa anual", ["nominal", "efetiva"], key=f"{key}_kind")
        annual = num("Juros nominais (% a.a.)" if kind == "nominal" else "Juros efetivos (% a.a.)", preset["annual_nominal"], f"{key}_rate", maximum=100.0)
        effective_input = annual
        if key == "tr_plus":
            use_precision = st.checkbox("Usar precisão interna inferida do PDF", value=False, key=f"{key}_precision")
            if use_precision and kind == "nominal" and annual == D(preset["annual_nominal"]):
                effective_input = base.annual_rate
                st.caption("Exibida no PDF: 10,65% nominal a.a. · Usada no cálculo: 10,654% nominal a.a., "
                           "inferida da evolução. Ao editar os juros, o valor digitado é usado exatamente.")
        equivalent = ((1 + monthly_rate(effective_input, kind)) ** 12 - 1) * 100
        st.caption(f"Equivalente efetiva: {format_brazilian(equivalent, 4)}% a.a. · Padrão PDF: {format_brazilian(preset['annual_nominal'])}% nominal a.a.")
        with st.expander("Seguros, tarifas e despesas iniciais"):
            use_curve = st.checkbox("Usar curva de MIP inferida deste PDF", value=True, key=f"{key}_curve")
            st.caption("MIP sobre saldo após amortização; DFI sobre valor do imóvel. A curva reproduz o perfil "
                       "original por mês do contrato, não uma regra universal para outros compradores. "
                       "Para outro perfil, desative a curva e informe uma alíquota constante.")
            mip = num("MIP mensal constante (%) — usado ao desativar a curva", base.costs.mip_percent, f"{key}_mip", step=0.000001)
            dfi = num("DFI mensal (%)", base.costs.dfi_percent, f"{key}_dfi", step=0.000001)
            admin = num("Administração mensal (R$)", 25, f"{key}_admin")
            initial = num("Despesas iniciais, incluindo avaliação e seguro à vista (R$)", base.costs.initial, f"{key}_initial")
            zero_insurance = st.checkbox("Zerar seguros no último mês", value=True, key=f"{key}_zero")
        with st.expander("Pacote de serviços e previdência para desconto"):
            st.caption("Valores não confirmados: zero é apenas o ponto de partida. Aportes de previdência "
                       "são desembolsos, com eventual patrimônio/resgate desconhecido; não são integralmente uma taxa perdida. "
                       "Não duplicar aqui cobranças já incluídas em seguros ou despesas iniciais.")
            package_initial = num("Pacote: pagamento inicial (R$)", 0, f"{key}_package_initial")
            package_monthly = num("Pacote: mensalidade (R$)", 0, f"{key}_package_monthly")
            package_months = st.number_input("Pacote: duração (meses)", min_value=0, max_value=600, value=420, key=f"{key}_package_months")
            pension_initial = num("Previdência: aporte inicial (R$)", 0, f"{key}_pension_initial")
            pension_monthly = num("Previdência: aporte mensal (R$)", 0, f"{key}_pension_monthly")
            pension_months = st.number_input("Previdência: duração (meses)", min_value=0, max_value=600, value=420, key=f"{key}_pension_months")
            compare_package = st.checkbox("Comparar com juros sem desconto do pacote", key=f"{key}_compare")
            no_discount = num("Juros nominais sem desconto (% a.a.)" if kind == "nominal" else "Juros efetivos sem desconto (% a.a.)", annual, f"{key}_no_discount", maximum=100.0) if compare_package else None
        quota = num("Cota máxima (%) — referência do PDF, editável", preset["quota_percent"], f"{key}_quota", maximum=100.0)
        costs = Costs(mip, dfi, admin, initial, package_initial, package_monthly, package_months,
                      pension_initial, pension_monthly, pension_months, zero_insurance,
                      mip_basis="closing", mip_bands=base.costs.mip_bands if use_curve else ())
        scenario = replace(base, annual_rate=effective_input, rate_kind=kind, costs=costs, tr_annual=tr)
        if original:
            scenario = replace(scenario, property_value=proposal_price, down_payment=proposal_down, months=proposal_months)
        else:
            scenario = replace(scenario, property_value=D(str(price)), down_payment=D(str(down)), months=months,
                               simulation_date=simulation_date, buyers=tuple(buyers))
        try:
            rows = schedule(scenario)
            total = totals(scenario, rows)
            with st.spinner("Estimando entrada por renda e cota…"):
                affordability = minimum_down_payment(scenario, D(str(income)), limit, quota)
        except ValueError as error:
            st.error(str(error))
            continue
        st.metric("Valor financiado", brl(scenario.principal))
        st.caption(f"Entrada {brl(scenario.down_payment)} · {scenario.months} meses · {scenario.simulation_date:%d/%m/%Y}")
        st.metric("Primeiro desembolso mensal", brl(total["first"]))
        st.metric("Último desembolso mensal", brl(total["last"]))
        st.metric("Maior desembolso mensal", brl(total["maximum"]))
        st.metric("Desembolso completo", brl(total["full_outflow"]))
        st.dataframe(pd.DataFrame([
            {"Componente": label, "Valor": brl(total[field])} for label, field in [
                ("Juros", "interest"), ("Correção TR amortizada", "correction"), ("MIP", "mip"),
                ("DFI", "dfi"), ("Tarifas mensais", "administration"), ("Total das parcelas do financiamento", "installment"),
                ("Pacote mensal acumulado", "package"), ("Previdência mensal acumulada", "pension"),
                ("Despesas e aportes iniciais", "initial"), ("Aportes totais de previdência", "pension_contributions")]]), hide_index=True)
        commitment = total["maximum"] / D(str(income)) * 100 if income else None
        st.write(f"Maior comprometimento da renda: {format_brazilian(commitment)}%" if commitment is not None else "Comprometimento indisponível: renda zero.")
        st.write(f"Entrada estimada pela cota: **{brl(affordability['quota'])}**")
        st.write(f"Entrada estimada pelo orçamento: **{brl(affordability['income'])}**")
        st.write(f"Entrada mínima combinada: **{brl(affordability['minimum'])}**")
        if scenario.down_payment < affordability["minimum"]:
            st.warning("Entrada abaixo dos parâmetros simulados de renda/cota. A entrada digitada foi preservada.")
        st.caption("Estimativa matemática pelo maior desembolso mensal, incluindo pacote e previdência. "
                   "Não é análise de crédito ou confirmação de elegibilidade ao programa.")
        if original:
            reference_file = Path(__file__).resolve().parents[1] / "data" / f"{key}_image_reference.json"
            if reference_file.exists():
                reference = json.loads(reference_file.read_text(encoding="utf-8"))["rows"]
                reference_total = sum(D(r["installment"]) for r in reference)
                comparison_rows = [
                    ("Primeiro encargo", rows[0].installment, D(reference[0]["installment"])),
                    ("Último encargo", rows[-1].installment, D(reference[-1]["installment"])),
                    ("Amortização + juros", total["amortization"] + total["interest"], D(preset["total_summary"])),
                    ("Total com seguros e tarifas", total["installment"], reference_total),
                ] if rows else []
                st.dataframe(pd.DataFrame([{"Item": label, "Calculado": brl(calculated), "PDF": brl(ref),
                                            "Diferença": brl(calculated - ref)} for label, calculated, ref in comparison_rows]), hide_index=True)
                st.caption("Comparação inclui suas edições. O PDF mantém amortização arredondada até o fim, "
                           "deixando residual de R$ 1,00 (TR) / R$ 1,59 (MCMV), apesar de mostrar saldo zero. "
                           "O motor quita esse residual na última parcela; não o oculta em seguros ou previdência.")
        st.caption(f"CET histórico do PDF: {preset['cet_historical']}% a.a. · CET desta simulação: indisponível, "
                   "sem validação normativa do fluxo. Não inclui estimativa de retorno/resgate da previdência.")
        if no_discount is not None:
            comparison = package_comparison(scenario, no_discount)
            st.write(f"Sem pacote/previdência: {brl(comparison['without_package'])}")
            st.write(f"Economia bruta com desconto e aportes: {brl(comparison['gross_saving'])}")
            st.caption("Valor negativo indica maior desembolso com pacote. Comparação nominal, sem valor presente, "
                       "rendimentos, tributos ou resgates. Encerramento dos aportes não cancela automaticamente o desconto; "
                       "confirme essa condição no contrato. Cobranças são limitadas ao prazo do financiamento.")
        results[key] = (scenario, rows, total, annual_summary(rows))

if len(results) != 2:
    st.stop()
left, right = results.values()
difference = left[2]["full_outflow"] - right[2]["full_outflow"]
st.subheader("Diferença no desembolso completo")
st.write(f"TR PLUS − MCMV: **{brl(difference)}**. Valores positivos indicam maior desembolso no TR PLUS.")
st.caption("Desembolso completo = entrada + parcelas do financiamento + pacote/previdência mensais + despesas/aportes iniciais. "
           "Sem dupla contagem dos seguros mensais. Previdência integra o fluxo bruto, não uma estimativa de perda patrimonial.")

st.subheader("Evolução por ano do contrato")
fig, balance_fig = go.Figure(), go.Figure()
annual_frames = []
for key, (_, rows, total, annual) in results.items():
    name = "SBPE TR PLUS" if key == "tr_plus" else "MCMV Classe Média"
    if not annual:
        continue
    data = pd.DataFrame([{k: float(v) if isinstance(v, D) else v for k, v in r.items()} for r in annual])
    data["Modalidade"] = name
    annual_frames.append(data)
    fig.add_trace(go.Scatter(x=data.year, y=data["mean"], name=name, mode="lines",
        customdata=data[["minimum", "maximum", "total", "months"]],
        hovertemplate="Ano %{x}<br>Média mensal R$ %{y:.2f}<br>Mínimo R$ %{customdata[0]:.2f}"
                      "<br>Máximo R$ %{customdata[1]:.2f}<br>Total R$ %{customdata[2]:.2f}"
                      "<br>Meses %{customdata[3]}<extra>%{fullData.name}</extra>"))
    balance_fig.add_trace(go.Scatter(x=data.year, y=data.balance, name=name, mode="lines"))
fig.update_layout(yaxis_title="Média mensal de desembolso (R$)", xaxis_title="Ano do contrato", separators=",.")
balance_fig.update_layout(yaxis_title="Saldo ao final do ano (R$)", xaxis_title="Ano do contrato", separators=",.")
st.plotly_chart(fig, width="stretch")
st.plotly_chart(balance_fig, width="stretch")
if annual_frames:
    # Uma linha por ano e valores das duas modalidades em colunas adjacentes.
    annual_data = pd.DataFrame()
    labels = {"mean": "Média mensal", "total": "Total anual", "balance": "Saldo final", "minimum": "Mínimo",
              "maximum": "Máximo", "installments": "Parcelas do financiamento", "months": "Meses"}
    for key, (_, _, _, annual) in results.items():
        if annual:
            short_name = "TR PLUS" if key == "tr_plus" else "MCMV"
            data = pd.DataFrame(annual).set_index("year")
            data = data.rename(columns={k: f"{label} · {short_name}" for k, label in labels.items()})
            annual_data = annual_data.join(data, how="outer")
    annual_data.index.name = "Ano"
    columns = [f"{label} · {model}" for label in labels.values() for model in ("TR PLUS", "MCMV")]
    annual_data = annual_data.reindex(columns=columns).reset_index()
    monetary_columns = [c for c in columns if not c.startswith("Meses")]
    for col in columns:
        annual_data[col] = pd.to_numeric(annual_data[col], errors="coerce")
    styled = annual_data.style.format({c: brl for c in monetary_columns}, na_rep="—")
    st.dataframe(styled, hide_index=True, width="stretch")

with st.expander("Tabela mensal completa e exportação CSV"):
    for key, (_, rows, _, _) in results.items():
        st.markdown(f"**{presets()[key]['name']}**")
        data = frame(rows).rename(columns={"month": "Mês", "due_date": "Vencimento", "correction": "Correção TR",
            "amortization": "Amortização", "interest": "Juros", "mip": "MIP", "dfi": "DFI",
            "administration": "Tarifa", "installment": "Encargo financiamento", "package": "Pacote",
            "pension": "Previdência", "outflow": "Desembolso mensal", "balance": "Saldo"})
        if original and rows:
            reference_file = Path(__file__).resolve().parents[1] / "data" / f"{key}_image_reference.json"
            if reference_file.exists():
                reference = json.loads(reference_file.read_text(encoding="utf-8"))["rows"]
                lookup = {ref["month"]: D(ref["installment"]) for ref in reference}
                data["Encargo PDF"] = [float(lookup[row.month]) if row.month in lookup else float("nan") for row in rows]
                data["Diferença vs PDF"] = [float(row.installment - lookup[row.month]) if row.month in lookup else float("nan") for row in rows]
        money_columns = [c for c in data.columns if c not in ("Mês", "Vencimento")]
        st.dataframe(data.style.format({c: brl for c in money_columns}, na_rep="—"), hide_index=True, width="stretch")
        st.download_button("Baixar CSV (separador ; e decimal ,)", data.to_csv(index=False, sep=";", decimal=",").encode("utf-8-sig"),
                           file_name=f"{key}.csv", mime="text/csv", key=f"{key}_csv")

with st.expander("Premissas, fontes e diferenças conhecidas"):
    st.write("SAC com Decimal, arredondamento comercial em centavos e ajuste residual na última amortização. "
             "Taxa nominal anual dividida por 12; taxa efetiva anual convertida por capitalização equivalente. "
             "Tarifas, MIP e DFI arredondados por mês. Não inclui ITBI, registro e outras despesas salvo se informadas.")
    st.write("As 420 linhas de cada PDF foram relidas das imagens e conciliadas. O MIP e o DFI calibrados coincidem "
             "em todas as 840 parcelas originais. No TR, taxa nominal inferida de 10,654% a.a. explica os juros iniciais "
             "de R$ 1.420,53. Restam R$ 0,01 de diferença nas parcelas 132 e 341. "
             "A curva mensal pertence aos perfis originais; não é tabela etária universal.")
    st.write("O somatório dos resumos é a soma de amortização e juros da tabela. Com seguros e administração, "
             "os PDFs somam R$ 509.618,72 (TR) e R$ 422.393,66 (MCMV). "
             "O motor conserva o principal, acrescentando o residual de R$ 1,00 (TR) / R$ 1,59 (MCMV) na última parcela. "
             "Com a precisão inferida de 10,654% ativada no TR, os totais calculados são R$ 509.619,70 e R$ 422.395,25. "
             "Não houve ajuste artificial de seguro, previdência ou total.")
    st.write("Referências históricas dos resumos; o total abaixo inclui somente amortização e juros:")
    st.table(pd.DataFrame([{"Modalidade": p["name"], "Primeira": brl(D(p["first_summary"])),
                           "Última": brl(D(p["last_summary"])), "Total": brl(D(p["total_summary"]))} for p in presets().values()]))
    st.markdown("[CAIXA: relacionamento e juros](https://www.caixa.gov.br/voce/habitacao/financiamento/perguntas-frequentes/Paginas/default.aspx) · "
                "[CAIXA: amortização e indexadores](https://www.caixa.gov.br/Downloads/habitacao-documentos-gerais/passos_indexadores_amortizacao.pdf) · "
                "[SUSEP: seguro habitacional](https://www.gov.br/susep/pt-br/assuntos/meu-futuro-seguro/seguros-previdencia-e-capitalizacao/seguros/seguro-habitacional)")
