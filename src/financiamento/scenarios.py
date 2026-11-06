from dataclasses import replace
from datetime import date
from decimal import Decimal as D
from importlib.resources import files
import json

from .models import Buyer, Costs, Scenario


def presets():
    return json.loads(files("financiamento").joinpath("data/presets.json").read_text(encoding="utf-8"))


def calibrated_profiles():
    return json.loads(files("financiamento").joinpath("data/calibrated_profiles.json").read_text(encoding="utf-8"))


def from_preset(key: str, *, calibrated: bool = True) -> Scenario:
    p = presets()[key]
    principal = D(p["property_value"]) - D(p["down_payment"])
    costs = Costs(mip_percent=D(p["first_mip"]) / principal * 100,
                  dfi_percent=D(p["first_dfi"]) / D(p["property_value"]) * 100,
                  administration=D(p["administration"]),
                  initial=D(p["evaluation"]) + D(p["upfront_insurance"]))
    annual_rate = D(p["annual_nominal"])
    if calibrated:
        profile = calibrated_profiles()[key]
        annual_rate = D(profile["annual_nominal_inferred"])
        bands = tuple((start, D(percent)) for start, percent in profile["mip_bands"])
        costs = replace(costs, mip_percent=bands[0][1], mip_basis=profile["mip_basis"], mip_bands=bands)
    return Scenario(D(p["property_value"]), D(p["down_payment"]), p["months"],
                    annual_rate, simulation_date=date.fromisoformat(p["date"]), costs=costs,
                    buyers=(Buyer(birth_date=date.fromisoformat(p["birth_date"]) if p["birth_date"] else None),))


def package_comparison(scenario, undiscounted_rate):
    """Fluxos brutos: não presume resgate, rendimento ou perda de aportes em previdência."""
    from .sac import schedule
    from .summaries import totals
    c = scenario.costs
    without = replace(scenario, annual_rate=D(str(undiscounted_rate)), costs=replace(c,
        package_initial=D(0), package_monthly=D(0), package_months=0,
        pension_initial=D(0), pension_monthly=D(0), pension_months=0))
    with_total = totals(scenario, schedule(scenario))["full_outflow"]
    without_total = totals(without, schedule(without))["full_outflow"]
    return {"with_package": with_total, "without_package": without_total,
            "gross_saving": without_total - with_total}
