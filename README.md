# Calculadora de financiamento imobiliário

Compara SBPE TR PLUS e MCMV Classe Média (SAC), com seguros, tarifa e pacote/previdência editáveis.

Roda inteiramente no navegador com [stlite](https://github.com/whitphx/stlite) (Streamlit sobre Pyodide). Não há servidor: os dados digitados não saem do seu computador. O primeiro acesso demora cerca de um minuto para carregar o Python.

Cópia do app de `Imoveis/Calculadora_financiamento` (pasta `app/` e `src/financiamento/`). Os PDFs e os gabaritos mês a mês não estão aqui, por isso a comparação "calculado × PDF" não aparece.

Testar localmente:

```bash
python -m http.server 8765 --bind 127.0.0.1
```

Depois abra http://127.0.0.1:8765.
