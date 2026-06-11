---
name: cash-forecasting
description: Forecast upcoming payroll cash needs for a Gusto company from scheduled payrolls, processed-payroll history, and ledger data. Read-only.
---

# Forecast payroll cash needs

Projects how much cash a Gusto company needs to cover upcoming payroll. Read-only: it stitches `gusto payroll list` totals together with `gusto ledger show` breakdowns and the `gusto pay-schedule show` cadence, and never mutates anything. The output is a per-check-date cash timeline plus rolling totals.

## Preconditions

- Gusto CLI installed (`curl -fsSL https://raw.githubusercontent.com/Gusto/gusto-cli-public/main/install.sh | sh`) and authenticated (`gusto auth status`).
- The company has at least one pay schedule (`gusto pay-schedule show` returns a schedule). Without a schedule there's no cadence to project against.
- For the projection method to have a baseline, the company ideally has **at least one processed payroll**. With zero processed payrolls, only scheduled (upcoming) payrolls can be forecast.

## Discovering commands

The command shapes below are a guide, not a spec. Confirm exact flags and the JSON field names with `gusto <command> --help` (e.g. `gusto payroll list --help`) and by reading the actual `--agent` envelope, rather than trusting hardcoded examples. `--help` is generated from the CLI and stays accurate as commands evolve; the `totals` object on a payroll is passed through from the Gusto API, so read the field names off a real response.

## Forecast methods

There are two ways to estimate cash needs. They use different data and have different confidence. Pick based on what the user asked for; default to **both**.

### Method A — Scheduled actuals (high confidence, near-term only)

Forecast directly from payrolls Gusto has already computed but not yet debited:

```
gusto payroll list --processing-status unprocessed --include totals --sort-order asc
```

Each returned payroll carries a `totals` object and a check date. The headline cash figure is the **company debit** — the total Gusto pulls from the company's bank account for that payroll. In the Gusto API this is `totals.company_debit`; if that field isn't present, sum the debit components instead (e.g. `net_pay_debit + tax_debit + reimbursement_debit + child_support_debit` — confirm the actual keys from the response). These rows are the ground truth for cash needs, but they only exist inside the API window (`end-date` is capped at ~3 months out), and only for payrolls that have been created.

### Method B — Historical baseline + extrapolation (lower confidence, any horizon)

When the user wants to project further out than the scheduled payrolls reach, build a baseline from history and repeat it over the pay-schedule cadence:

1. Pull recent processed payrolls:
   ```
   gusto payroll list --processing-status processed --include totals --sort-order desc
   ```
   Take the most recent one (or an average of the last few) company-debit total as the **per-period baseline**.
2. Get the ledger breakdown for that payroll so the forecast can explain where the cash goes (net pay vs. employee/employer taxes vs. benefits):
   ```
   gusto ledger show <payroll_uuid>
   ```
   Use the `payroll_uuid` from the processed-payroll list. This generates the general-ledger report and polls until it's ready.
3. Read the cadence from `gusto pay-schedule show` (frequency + anchor/check dates) and walk future check dates forward to the requested horizon, assigning the baseline debit to each. These rows are **estimates**: they assume hours, headcount, rates, and tax liabilities stay flat.

## Modes

- **A only** — "what's my upcoming / scheduled payroll cash need?" Run Method A and report the scheduled debits. No projection past the window.
- **B only** — "project my payroll cash out N months." Run Method B from the historical baseline over the cadence for the horizon.
- **Both (default)** — Run A for every check date the API actually returns, then B to extend past the window. Where the two overlap (e.g. the most recent processed payroll), surface the **actual debit alongside what B would have projected** as a sanity-check on the baseline. Label every row by source.

## Steps (both mode)

1. **Cadence.** `gusto pay-schedule show` — record each schedule's frequency and its check dates.
2. **Headcount context.** `gusto employee list` — note `data.summary.total` and the active/onboarding/terminated breakdown. Compensation is _not_ in this response, so the forecast is driven by payroll totals, not by summing per-employee pay; call this out so the user knows headcount is context, not an input.
3. **Scheduled actuals (Method A).** `gusto payroll list --processing-status unprocessed --include totals` — one row per upcoming payroll, `cash_needed = totals.company_debit`, source `scheduled`.
4. **Baseline + breakdown (Method B).** `gusto payroll list --processing-status processed --include totals --sort-order desc` for the baseline debit; `gusto ledger show <payroll_uuid>` on the most recent processed payroll for the GL split. Mark processed rows as source `actual`.
5. **Extrapolate (Method B).** Walk the pay-schedule check dates past the last scheduled payroll out to the horizon (default ~6 months); assign the baseline debit to each, source `projected`.
6. **Present.** A table sorted by check date — `check_date | source (actual|scheduled|projected) | cash_needed` — followed by rolling totals (per month and per quarter) and the ledger-derived split (net pay / taxes / benefits) for the baseline. Flag clearly where `projected` rows begin.

## Output mode

Always pass `--agent` to every CLI call so the output is parseable JSON (`{ "ok": true, "data": {...} }`). The CLI auto-detects piped stdout and emits agent JSON by default, but be explicit for safety.

## Accuracy and caveats

- `scheduled` and `actual` rows are real Gusto figures. `projected` rows are a flat-baseline heuristic and will drift from reality as hours, new hires, terminations, off-cycle payrolls, bonuses, and tax/benefit rate changes occur. Always label projected rows and state the assumption.
- The company debit can vary between otherwise-identical pay periods (e.g. quarterly tax true-ups, benefit enrollment changes). Treat a single baseline as an estimate; averaging the last few processed payrolls is more robust than using one.
- `gusto ledger show` reports a _processed_ payroll's general ledger — it's historical, used here for the cash breakdown, not for future periods.

## Risk and rollback

- This skill is strictly read-only. It calls `pay-schedule show`, `payroll list`, `ledger show`, and `employee list` — none of which create or modify server-side state. There is nothing to roll back.

## Out of scope

- Running or scheduling payroll (this only forecasts; use the onboarding/payroll commands to act).
- Modeling benefit or tax-rate changes, raises, or planned hires — the projection holds the baseline flat.
- Multi-company / partner-level aggregation (single company per run).
