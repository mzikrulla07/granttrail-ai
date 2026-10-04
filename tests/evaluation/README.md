# Extraction accuracy evaluation

Structure for measuring how accurately the extractor (Claude, or the demo
simulator) reads subaward agreements, against a **20-agreement labelled
test set**.

```
tests/evaluation/
├── agreements/          ← put the 20 real agreement PDFs here (git-ignored)
├── labels/
│   ├── samples.json     ← auto-generated labels for the 3 fictional samples
│   └── template.json.example
└── reports/             ← JSON + Markdown reports (git-ignored)
```

## Adding the 20-agreement set

1. Copy each signed agreement PDF into `agreements/` (these files are git-ignored
   because real agreements may contain sensitive information).
2. Copy `labels/template.json.example` to `labels/agreements.json` and add one entry
   per PDF. `expected` holds the values a grants specialist would approve, **as
   stated in the agreement**. Use `null` when the agreement does not contain the field.
3. Run `npm run eval` (uses Claude when `ANTHROPIC_API_KEY` is set) or
   `npm run eval -- demo`.

## Metrics

| Metric | Why it matters |
|---|---|
| Field accuracy (per field and overall) | Basic correctness |
| Fully-correct agreements | Share of records needing zero corrections |
| High-confidence precision | Whether a high score can be trusted |
| **Confident errors** | Wrong values with high confidence — the risk that a reviewer skims past a mistake. Target: 0 |
| Flagged errors | Wrong values that *were* flagged (low confidence / missing) — the system working as designed |
| **Hallucinations** | Values produced where the agreement has none. Target: 0 |

Comparison rules (`server/src/evaluation/scoring.ts`): UEI compared after
normalisation, amounts as cents, dates as ISO dates, names/places as normalised
tokens, and project descriptions by token F1 ≥ 0.80.

Suggested acceptance bar before production use: ≥ 95% field accuracy, 0
hallucinations, and 0 confident errors on the 20-agreement set.
