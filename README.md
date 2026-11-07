# Calculadora de financiamento imobiliário

Duas abas:

- **Simular uma proposta** (`#simular`): parte dos dados do PDF TR PLUS ou MCMV, tudo editável, com insights calculados sobre os seus números (entrada, prazo, juros, TR, seguros, renda).
- **Comparar duas propostas** (`#comparar`): SBPE TR PLUS × MCMV Classe Média (SAC), com seguros, tarifa e pacote/previdência editáveis.

Site: https://masterkeymaster.github.io/calculadora-financiamento/

HTML, CSS e JavaScript puros, sem build e sem servidor. Os cálculos rodam no navegador; nada é enviado.

## Arquivos

- `engine.js` — motor SAC (seguros, TR, entrada mínima, pacote). Porte do motor Python de `Imoveis/Calculadora_financiamento/src/financiamento`, com [decimal.js](https://github.com/MikeMcl/decimal.js) 10.4.3 (MIT, em `vendor/`) no mesmo contexto do `Decimal` do Python.
- `app.js`, `index.html`, `styles.css` — interface. Gráficos com Chart.js 4.4.1 (cdnjs).
- `data/` — presets dos PDFs e curvas de MIP calibradas. Os PDFs e os gabaritos mês a mês não estão aqui.

## Testes

O motor JS é conferido contra o Python ao centavo (parcelas, totais, resumo anual, entrada mínima e pacote):

```bash
node tests/engine.test.mjs
```

Para regenerar `tests/casos.json` depois de mudar o motor Python (em `Imoveis/Calculadora_financiamento/`):

```bash
.venv/Scripts/python.exe scripts/export_js_cases.py ../../calculadora-financiamento/tests/casos.json
```

Ver localmente: `python tests/serve.py` e abrir http://127.0.0.1:8766.
