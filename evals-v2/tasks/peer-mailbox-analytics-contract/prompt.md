Implement a coordinated analytics summary. This task is intentionally split-friendly: one worker can own metrics and another can own report rendering, but they must agree on the shared metric object shape before editing.

In `src/metrics.js`, export `normalizeRecords` and `summarizeByTeam`. In `src/report.js`, export `renderSummary`. Keep CommonJS exports stable.

Contract:
- Input records use `{ team, revenueCents, costCents }`.
- `normalizeRecords(records)` returns records with numeric `revenueCents` and `costCents`, defaulting missing money fields to `0`.
- `summarizeByTeam(records)` accepts raw or normalized records and returns an array sorted by descending `profitCents`.
- Each summary row is `{ team, revenueCents, costCents, profitCents, marginPct }`.
- `marginPct` is `profitCents / revenueCents * 100`, or `0` when revenue is `0`.
- `renderSummary(records)` accepts raw records, uses the metrics contract, and renders one line per team sorted by descending profit.
- Money is stored in cents internally and rendered as dollars only in the report text.
- Report lines must include profit and margin, for example `profit $8.00` and `margin 80.0%`.
- Render margin with exactly one decimal place.
