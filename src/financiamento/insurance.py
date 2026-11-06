from .models import Costs, ZERO, money


def insurance(balance, property_value, costs: Costs, final: bool, *, closing_balance=None, month=1):
    """Alíquota constante ou curva mensal do perfil de referência; sem tabela etária universal."""
    if final and costs.zero_insurance_at_payoff:
        return ZERO, ZERO
    percent = costs.mip_percent
    for start, band_percent in costs.mip_bands:
        if month < start:
            break
        percent = band_percent
    if costs.mip_basis == "closing":
        balance = closing_balance
    return (money(balance * percent / 100),
            money(property_value * costs.dfi_percent / 100))
