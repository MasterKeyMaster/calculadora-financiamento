"""Conversão explícita de números brasileiros, sem depender do locale do SO."""
from decimal import Decimal, InvalidOperation
import re


def parse_brazilian(text: str) -> Decimal:
    text = text.strip().removeprefix("R$").strip()
    if not re.fullmatch(r"[+-]?(?:\d+|\d{1,3}(?:\.\d{3})+)(?:,\d+)?", text):
        raise ValueError("Use vírgula nos decimais e ponto nos milhares, por exemplo 500.000,00.")
    try:
        value = Decimal(text.replace(".", "").replace(",", "."))
    except InvalidOperation as error:
        raise ValueError("Número inválido.") from error
    if not value.is_finite():
        raise ValueError("Número deve ser finito.")
    return value


def format_brazilian(value, places=2, *, trim=False) -> str:
    text = f"{Decimal(str(value)):,.{places}f}".replace(",", "X").replace(".", ",").replace("X", ".")
    if trim and places > 2:
        integer, fraction = text.split(",")
        text = integer + "," + fraction.rstrip("0").ljust(2, "0")
    return text
