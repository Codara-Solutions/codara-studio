Build a small personal-finance **ledger library** in Node.js (CommonJS, no external dependencies). The library is split into independent modules with a shared contract so the work can be divided across several workers in parallel. Every module must use `module.exports`. Keep the public API exactly as specified — hidden tests call these functions directly.

The module dependency graph (build the foundation modules first; they are independent of each other and of everything else):

- Foundation (no internal dependencies): `money`, `dates`, `categories`, `validate`, `csv`
- Mid layer: `transactions` (uses money, dates, categories, validate)
- Aggregation: `budget` (uses money, categories)
- Presentation: `report` (uses budget, transactions, money), and `index` (re-exports the full public API)

## `src/money.js`
- `formatMoney(cents)` — integer cents → dollar string with exactly two decimals and **no** thousands separators. Negative sign comes before the `$`.
  - `formatMoney(0)` → `"$0.00"`, `formatMoney(5)` → `"$0.05"`, `formatMoney(123456)` → `"$1234.56"`, `formatMoney(-50)` → `"-$0.50"`
- `parseMoney(str)` — dollar string → integer cents. Strip `$`, commas, and surrounding whitespace; parse the dollar amount and round to the nearest cent. A leading `-` means negative.
  - `parseMoney("$0.05")` → `5`, `parseMoney("1234.56")` → `123456`, `parseMoney("$1,234.56")` → `123456`, `parseMoney("12")` → `1200`, `parseMoney("-$1.23")` → `-123`
- `sumCents(list)` — sum an array of integer cents. `sumCents([5,10,-3])` → `12`, `sumCents([])` → `0`.

## `src/dates.js`
- `isValidDate(str)` — `true` only for a `"YYYY-MM-DD"` string that is a real calendar date. `isValidDate("2026-05-29")` → `true`; `isValidDate("2026-13-01")`, `isValidDate("2026-02-30")`, `isValidDate("nope")` → `false`.
- `monthKey(isoDate)` — `"YYYY-MM-DD"` (or longer ISO) → `"YYYY-MM"`. `monthKey("2026-05-29")` → `"2026-05"`, `monthKey("2026-12-01T10:00:00Z")` → `"2026-12"`.
- `compareDate(a, b)` — compare two ISO date strings, returning `-1`, `0`, or `1`. `compareDate("2026-01-05","2026-02-01")` → `-1`.

## `src/categories.js`
- `normalizeCategory(raw)` — produce a slug: lowercase, trim, collapse internal whitespace runs to a single `-`, remove any character that is not `a-z`, `0-9`, or `-`, collapse repeated `-`, and trim leading/trailing `-`. Empty/`null`/`undefined`/whitespace-only → `"uncategorized"`.
  - `normalizeCategory("  Food  Dining ")` → `"food-dining"`, `normalizeCategory("Transport!!!")` → `"transport"`, `normalizeCategory("")` → `"uncategorized"`

## `src/validate.js` (standalone — must NOT import other modules)
- `validateTransaction(tx)` — returns `{ ok, errors }`. Check, in this order: `date` (a valid `"YYYY-MM-DD"` calendar date), `amount` (a finite number, or a string of the form optional `-`, optional `$`, digits with optional commas and optional `.dd`), `category` (non-empty after trimming). `errors` is an array of stable strings in check order: `"invalid date"`, `"invalid amount"`, `"missing category"`. `ok` is `errors.length === 0`.
  - `validateTransaction({date:"2026-05-01", amount:12.5, category:"food"})` → `{ ok:true, errors:[] }`
  - `validateTransaction({date:"2026-05-01", amount:"$3.00", category:"food"})` → `{ ok:true, errors:[] }`
  - `validateTransaction({date:"bad", amount:"x", category:""})` → `{ ok:false, errors:["invalid date","invalid amount","missing category"] }`

## `src/csv.js`
- `parseCsv(text)` — first non-empty line is the comma-separated header; each subsequent non-empty line becomes an object mapping header → trimmed cell. Cells never contain commas. Blank lines are ignored.
  - `parseCsv("date,amount\n2026-05-01,12.50\n2026-05-02,3.00")` → `[{date:"2026-05-01",amount:"12.50"},{date:"2026-05-02",amount:"3.00"}]`
- `toCsv(rows, columns)` — header line is `columns.join(",")`; each row renders `columns` in order, missing values as empty string, joined by `,`. Lines joined by `\n` with no trailing newline.
  - `toCsv([{a:"1",b:"2"}], ["a","b"])` → `"a,b\n1,2"`; `toCsv([{a:"1"}], ["a","b"])` → `"a,b\n1,"`

## `src/transactions.js` (uses money, dates, categories, validate)
- `createTransaction(raw)` — validate with `validateTransaction`; if invalid, throw `Error("invalid transaction: " + errors.join(", "))`. Otherwise return `{ date, amountCents, category, description }` where `amountCents` is `Math.round(amount*100)` when `amount` is a number, else `parseMoney(amount)`; `category` is `normalizeCategory(raw.category)`; `description` is `raw.description || ""`.
  - `createTransaction({date:"2026-05-01", amount:12.5, category:"Food"})` → `{date:"2026-05-01", amountCents:1250, category:"food", description:""}`
  - `createTransaction({date:"2026-05-01", amount:"$3.00", category:"Dining Out"})` → `amountCents:300, category:"dining-out"`
- `filterByMonth(txs, "YYYY-MM")` — transactions whose `monthKey(date)` equals the given month.
- `filterByCategory(txs, cat)` — transactions whose `category` equals `normalizeCategory(cat)`.
- `sortByDate(txs)` — a new array sorted ascending by `date` (stable).

## `src/budget.js` (uses money, categories)
- `summarizeByCategory(txs)` — group transactions by `category`; return `[{ category, totalCents, count }]` sorted by `totalCents` descending, ties broken by `category` ascending.
  - `summarizeByCategory([{category:"food",amountCents:1250},{category:"food",amountCents:300},{category:"transport",amountCents:2000}])` → `[{category:"transport",totalCents:2000,count:1},{category:"food",totalCents:1550,count:2}]`
- `applyBudget(txs, limits)` — `limits` maps a category name to a dollar number. The category universe is the union of categories appearing in `txs` and (normalized) keys of `limits`. For each category, sorted ascending, return `{ category, spentCents, limitCents, remainingCents, overBudget }` where `spentCents` sums matching `amountCents`, `limitCents` is `Math.round(limitDollars*100)` (or `0` if absent), `remainingCents` is `limitCents - spentCents`, and `overBudget` is `spentCents > limitCents`.
  - `applyBudget([{category:"food",amountCents:1250}], {food:10})` → `[{category:"food", spentCents:1250, limitCents:1000, remainingCents:-250, overBudget:true}]`

## `src/report.js` (uses budget, transactions, money)
- `renderLedger(txs)` — `sortByDate`, then one line per transaction: `` `${date} ${category} ${formatMoney(amountCents)}` ``, joined by `\n`.
  - `renderLedger([{date:"2026-05-02",category:"food",amountCents:300},{date:"2026-05-01",category:"transport",amountCents:2000}])` → `"2026-05-01 transport $20.00\n2026-05-02 food $3.00"`
- `renderBudgetReport(txs, limits)` — one line per category from `applyBudget` (category ascending): `` `${category}: spent ${formatMoney(spentCents)} / ${formatMoney(limitCents)} (${overBudget ? "OVER" : "ok"})` ``, then a final line `` `TOTAL spent ${formatMoney(totalSpentCents)}` ``.

## `src/index.js`
- Re-export the full public API so `require("./src/index")` (or `require("./src")`) exposes: `formatMoney`, `parseMoney`, `sumCents`, `isValidDate`, `monthKey`, `compareDate`, `normalizeCategory`, `validateTransaction`, `parseCsv`, `toCsv`, `createTransaction`, `filterByMonth`, `filterByCategory`, `sortByDate`, `summarizeByCategory`, `applyBudget`, `renderLedger`, `renderBudgetReport`.

Keep everything in `src/`. Do not add dependencies or build tooling. Money is always stored as integer cents internally and only rendered as dollars in `money`/`report` output.
