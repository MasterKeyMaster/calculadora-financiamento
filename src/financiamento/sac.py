from calendar import monthrange
from datetime import date

from .insurance import insurance
from .models import Payment, Scenario, ZERO, money, monthly_rate


def add_months(start: date, months: int) -> date:
    absolute = start.year * 12 + start.month - 1 + months
    year, month = divmod(absolute, 12)
    month += 1
    return date(year, month, min(start.day, monthrange(year, month)[1]))


def schedule(scenario: Scenario) -> list[Payment]:
    scenario.validate()
    if scenario.principal == 0:
        return []
    rate = monthly_rate(scenario.annual_rate, scenario.rate_kind)
    tr = monthly_rate(scenario.tr_annual, "efetiva")
    balance = scenario.principal
    fixed_amortization = money(balance / scenario.months)
    rows = []
    c = scenario.costs
    for month in range(1, scenario.months + 1):
        correction = money(balance * tr)
        corrected_balance = balance + correction
        remaining = scenario.months - month + 1
        # TR: SAC recalculado sobre saldo corrigido/prazo restante.
        amortization = money(corrected_balance / remaining) if tr else fixed_amortization
        amortization = corrected_balance if remaining == 1 else min(amortization, corrected_balance)
        interest = money(corrected_balance * rate)
        mip, dfi = insurance(corrected_balance, scenario.property_value, c, remaining == 1,
                             closing_balance=corrected_balance - amortization, month=month)
        administration = money(c.administration)
        installment = amortization + interest + mip + dfi + administration
        package = money(c.package_monthly) if month <= c.package_months else ZERO
        pension = money(c.pension_monthly) if month <= c.pension_months else ZERO
        balance = corrected_balance - amortization
        rows.append(Payment(month, add_months(scenario.simulation_date, month), correction,
                            amortization, interest, mip, dfi, administration, installment,
                            package, pension, installment + package + pension, balance))
    return rows
