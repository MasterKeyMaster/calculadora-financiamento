from dataclasses import replace
from decimal import Decimal, ROUND_CEILING

from .models import CENT, ZERO, decimal
from .sac import schedule


def minimum_down_payment(scenario, income, limit_percent, quota_percent):
    """Busca em centavos pelo maior empréstimo que cabe no orçamento mensal total."""
    income, limit_percent, quota_percent = map(decimal, (income, limit_percent, quota_percent))
    if income < 0 or not 0 <= limit_percent <= 100 or not 0 <= quota_percent <= 100:
        raise ValueError("Renda não negativa e limites entre 0 e 100%.")
    scenario.validate()
    cap = income * limit_percent / 100
    low, high = 0, int(scenario.property_value / CENT)
    while low < high:
        middle = (low + high + 1) // 2
        candidate = replace(scenario, down_payment=scenario.property_value - middle * CENT)
        rows = schedule(candidate)
        # Sem TR, avaliar os meses intermediários, incluindo saltos de MIP. O residual da
        # última amortização oscila nos degraus de arredondamento: incluí-lo na
        # busca binária perderia soluções válidas em centavos.
        peak = (max(r.outflow for r in rows[:-1]) if rows and scenario.tr_annual == 0 and scenario.months > 1
                else max((r.outflow for r in rows), default=ZERO))
        if peak <= cap:
            low = middle
        else:
            high = middle - 1
    if scenario.tr_annual == 0:
        while low > 0:
            candidate = replace(scenario, down_payment=scenario.property_value - low * CENT)
            if max((r.outflow for r in schedule(candidate)), default=ZERO) <= cap:
                break
            low -= 1
    income_down = scenario.property_value - low * CENT
    quota_down = (scenario.property_value * (1 - quota_percent / 100)).quantize(CENT, rounding=ROUND_CEILING)
    combined = max(income_down, quota_down)
    # Uma entrada maior pode cair em outro degrau do residual da última parcela.
    # Revalidar a combinação de cota e orçamento em vez de presumir monotonicidade.
    while combined < scenario.property_value:
        candidate = replace(scenario, down_payment=combined)
        if max((r.outflow for r in schedule(candidate)), default=ZERO) <= cap:
            break
        combined += CENT
    return {"income": income_down, "quota": quota_down, "minimum": combined, "cap": cap}
