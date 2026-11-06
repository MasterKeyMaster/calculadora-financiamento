from .models import ZERO, Scenario, money


def totals(scenario: Scenario, rows):
    names = ("amortization", "interest", "mip", "dfi", "administration", "installment",
             "package", "pension", "outflow", "correction")
    result = {name: sum((getattr(r, name) for r in rows), ZERO) for name in names}
    c = scenario.costs
    # Sem empréstimo, despesas de contratação e relacionamento não são incorridas.
    initial = money(c.initial + c.package_initial + c.pension_initial) if rows else ZERO
    result.update(initial=initial, full_outflow=scenario.down_payment + initial + result["outflow"],
                  maximum=max((r.outflow for r in rows), default=ZERO),
                  first=rows[0].outflow if rows else ZERO, last=rows[-1].outflow if rows else ZERO,
                  pension_contributions=result["pension"] + (money(c.pension_initial) if rows else ZERO))
    return result


def annual_summary(rows):
    result = []
    for start in range(0, len(rows), 12):
        group = rows[start:start + 12]
        total = sum((r.outflow for r in group), ZERO)
        result.append({"year": start // 12 + 1, "months": len(group), "total": total,
                       "mean": total / len(group), "minimum": min(r.outflow for r in group),
                       "maximum": max(r.outflow for r in group), "balance": group[-1].balance,
                       "installments": sum((r.installment for r in group), ZERO)})
    return result
