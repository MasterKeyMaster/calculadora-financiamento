from dataclasses import dataclass, field
from datetime import date
from decimal import Decimal, ROUND_HALF_UP
from typing import Literal

ZERO = Decimal("0")
CENT = Decimal("0.01")


def decimal(value) -> Decimal:
    result = Decimal(str(value))
    if not result.is_finite():
        raise ValueError("Valores devem ser finitos.")
    return result


def money(value: Decimal) -> Decimal:
    return value.quantize(CENT, rounding=ROUND_HALF_UP)


def monthly_rate(annual_percent: Decimal, kind: str = "nominal") -> Decimal:
    rate = decimal(annual_percent) / 100
    if rate < 0 or kind not in ("nominal", "efetiva"):
        raise ValueError("Taxa não negativa e tipo nominal ou efetiva são obrigatórios.")
    return rate / 12 if kind == "nominal" else (1 + rate) ** (Decimal(1) / 12) - 1


@dataclass(frozen=True)
class Buyer:
    share_percent: Decimal = Decimal("100")
    birth_date: date | None = None


@dataclass(frozen=True)
class Costs:
    # Alíquotas mensais em %, sobre saldo anterior corrigido e valor do imóvel.
    mip_percent: Decimal = ZERO
    dfi_percent: Decimal = ZERO
    administration: Decimal = ZERO
    initial: Decimal = ZERO
    package_initial: Decimal = ZERO
    package_monthly: Decimal = ZERO
    package_months: int = 0
    pension_initial: Decimal = ZERO
    pension_monthly: Decimal = ZERO
    pension_months: int = 0
    zero_insurance_at_payoff: bool = True
    mip_basis: Literal["opening", "closing"] = "opening"
    mip_bands: tuple[tuple[int, Decimal], ...] = ()


@dataclass(frozen=True)
class Scenario:
    property_value: Decimal
    down_payment: Decimal
    months: int
    annual_rate: Decimal
    rate_kind: Literal["nominal", "efetiva"] = "nominal"
    simulation_date: date = date(2026, 11, 6)
    tr_annual: Decimal = ZERO
    costs: Costs = field(default_factory=Costs)
    buyers: tuple[Buyer, ...] = (Buyer(),)

    @property
    def principal(self):
        return self.property_value - self.down_payment

    def validate(self):
        for value in (self.property_value, self.down_payment, self.annual_rate, self.tr_annual):
            decimal(value)
        if self.property_value <= 0 or not ZERO <= self.down_payment <= self.property_value:
            raise ValueError("Imóvel positivo e entrada entre zero e o valor do imóvel.")
        if not isinstance(self.months, int) or isinstance(self.months, bool) or not 1 <= self.months <= 600:
            raise ValueError("Prazo deve ser inteiro entre 1 e 600 meses.")
        if money(self.principal) != self.principal or money(self.property_value) != self.property_value:
            raise ValueError("Valores monetários devem ter no máximo duas casas decimais.")
        monthly_rate(self.annual_rate, self.rate_kind)
        monthly_rate(self.tr_annual, "efetiva")
        for name, value in vars(self.costs).items():
            if isinstance(value, bool) or name in ("mip_basis", "mip_bands"):
                continue
            if decimal(value) < 0:
                raise ValueError("Custos e durações devem ser não negativos.")
            if name.endswith("months") and (not isinstance(value, int) or value > 600):
                raise ValueError("Duração de custos deve ser inteira entre 0 e 600.")
        if self.costs.mip_basis not in ("opening", "closing"):
            raise ValueError("Base do MIP deve ser opening ou closing.")
        previous = 0
        for start, percent in self.costs.mip_bands:
            if not isinstance(start, int) or isinstance(start, bool) or not previous < start <= 600 or decimal(percent) < 0:
                raise ValueError("Faixas do MIP devem ter meses crescentes e alíquotas não negativas.")
            if previous == 0 and start != 1:
                raise ValueError("A primeira faixa do MIP deve começar no mês 1.")
            previous = start
        if not self.buyers or sum((decimal(b.share_percent) for b in self.buyers), ZERO) != 100:
            raise ValueError("Participações dos compradores devem somar 100%.")
        for buyer in self.buyers:
            if buyer.share_percent < 0 or (buyer.birth_date and buyer.birth_date > self.simulation_date):
                raise ValueError("Participação e nascimento inválidos.")


@dataclass(frozen=True)
class Payment:
    month: int
    due_date: date
    correction: Decimal
    amortization: Decimal
    interest: Decimal
    mip: Decimal
    dfi: Decimal
    administration: Decimal
    installment: Decimal
    package: Decimal
    pension: Decimal
    outflow: Decimal
    balance: Decimal
