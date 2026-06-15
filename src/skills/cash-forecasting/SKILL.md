---
name: cash-forecasting
description: Forecast upcoming payroll cash needs for a Gusto company from processed-payroll history and the pay-schedule cadence. Read-only.
---

# Forecast payroll cash needs

Projects how much cash a Gusto company needs to cover upcoming payroll. Read-only: it stitches `gusto payroll list` totals together with the `gusto pay-schedule show` cadence, and never mutates anything. The output is a per-check-date cash timeline plus rolling totals.

## Preconditions

- Gusto CLI installed (`curl -fsSL https://raw.githubusercontent.com/Gusto/gusto-cli-public/main/install.sh | sh`) and authenticated (`gusto auth whoami`).
- The token must grant **payroll read scope**. The cash figures come from `gusto payroll list --include totals`; without that scope the call fails with an `insufficient_scope` error and no forecast is possible. Run `gusto auth whoami` to see granted scopes — if `payrolls` isn't listed, the token can't drive this skill. Surface that error to the user and have them obtain a payroll-scoped token; do not fabricate figures.
- The company has at least one pay schedule (`gusto pay-schedule show` returns a schedule). Without a schedule there's no cadence to project against.
- The company has **at least one processed payroll** — it is the only source of a real cash figure to baseline from. With zero processed payrolls, no dollar forecast is possible; report the payday timeline from the pay schedule and say amounts are unavailable until a payroll has been processed.

## Discovering commands

The command shapes below are a guide, not a spec. Confirm exact flags and the JSON field names with `gusto <command> --help` (e.g. `gusto payroll list --help`) and by reading the actual `--agent` envelope, rather than trusting hardcoded examples. `--help` is generated from the CLI and stays accurate as commands evolve; the `totals` object on a payroll is passed through from the Gusto API, so read the field names off a real response.

## Forecast method

Estimate cash needs from the company's **processed-payroll history**, projected forward over the pay-schedule cadence. A processed payroll is the only place a real cash figure exists, so the skill needs at least one to establish a baseline (see [Limitations](#limitations) for why upcoming/unprocessed payrolls can't be used).

1. Pull recent processed payrolls:
   ```
   gusto payroll list --processing-status processed --include totals --sort-order desc
   ```
   The headline cash figure is the **company debit** — the total Gusto pulls from the company's bank account for a payroll. In the Gusto API this is `totals.company_debit`; if that field isn't present, sum the debit components instead (e.g. `net_pay_debit + tax_debit + reimbursement_debit + child_support_debit` — confirm the actual keys from the response). Take the most recent processed payroll's company debit, or an average of the last few, as the **per-period baseline**. The same `totals` object also carries the cash split (`net_pay`, `employee_taxes`, `employer_taxes`, `benefits`, `tax_debit`, `net_pay_debit`, …) used to explain where the cash goes — no separate call is needed for the breakdown.
2. Read the cadence from `gusto pay-schedule show` (frequency + anchor/check dates) and walk future check dates forward to the requested horizon (default ~6 months), assigning the baseline debit to each. These rows are **estimates**: they assume hours, headcount, rates, and tax liabilities stay flat.

## Steps

1. **Cadence.** `gusto pay-schedule show` — record each active schedule's frequency and its check dates.
2. **Headcount context.** `gusto employee list` — note `data.summary.total` and the active/onboarding/terminated breakdown. Compensation is _not_ in this response, so the forecast is driven by payroll totals, not by summing per-employee pay; call this out so the user knows headcount is context, not an input.
3. **Baseline + breakdown.** `gusto payroll list --processing-status processed --include totals --sort-order desc` for the baseline debit _and_ the cash split — the `totals` object already contains `net_pay`, `employee_taxes`, `employer_taxes`, `benefits`, etc. Mark processed rows as source `actual`.
   - **Note `--payroll-type` defaults to `regular`**, so the call above excludes off-cycle (non-regularly-scheduled) payrolls by definition. Run a second query with `--payroll-type off_cycle` to detect whether any processed off-cycle runs exist in the window.
   - **If off-cycle payrolls exist, prompt the user before including them**, and spell out the implication: off-cycle runs (bonus/commission/correction runs that don't follow the pay-schedule cadence) are irregular and unpredictable, so folding them into the per-period baseline inflates *every* projected period. Offer the choice explicitly — exclude them from the baseline (the safe default; they may still be shown as one-off historical `actual` rows), or include them in the averaged baseline. Do not silently decide; if the user gives no preference, default to excluding and say so.
   - This prompt is about `off_cycle` payrolls only. A *regular* run that merely carries a one-off bonus/commission line item is still on-cadence; handle that with the soft baseline-exclusion judgment in step 6, not this prompt.
4. **Extrapolate.** Walk the pay-schedule check dates forward from today out to the horizon (default ~6 months); assign the baseline debit to each, source `projected`.
5. **Present.** A table sorted by check date — `check_date | source (actual|projected) | cash_needed` — followed by rolling totals (per month and per quarter) and the `totals`-derived split (net pay / taxes / benefits) for the baseline. Flag clearly where `projected` rows begin.
6. **Disclose the baseline provenance — without re-listing the payrolls.** The processed payrolls already appear as `actual` rows in the table from step 5, so don't print a second table that repeats their `check_date`/`cash_needed`. Instead, mark baseline membership inline on those `actual` rows (e.g. a `baseline` column or a `✓`/`—` marker) and add one line stating the resulting baseline: how many runs were averaged and the per-period figure (e.g. "baseline = avg of 4 regular runs = $27,524.38"). For any processed payroll excluded from the average (off-cycle, or a regular run carrying a one-off bonus/commission that would skew it), mark it excluded in that same column and give the reason once. Never average payrolls silently.

## Output mode

Always pass `--agent` to every CLI call so the output is parseable JSON (`{ "ok": true, "data": {...} }`). The CLI auto-detects piped stdout and emits agent JSON by default, but be explicit for safety.

## Accuracy and caveats

- `actual` rows are real Gusto figures (processed payrolls). `projected` rows are a flat-baseline heuristic and will drift from reality as hours, new hires, terminations, off-cycle payrolls, bonuses, and tax/benefit rate changes occur. Always label projected rows and state the assumption.
- The company debit can vary between otherwise-identical pay periods (e.g. quarterly tax true-ups, benefit enrollment changes). Treat a single baseline as an estimate; averaging the last few processed payrolls is more robust than using one.

## Limitations

- **Upcoming/unprocessed payrolls are not used as a cash source.** `gusto payroll list --processing-status unprocessed --include totals` returns the scheduled paydates but **no `totals`** until a payroll has been _calculated_ (`calculated_at` is null on a freshly created payroll), and the V1 CLI has no command to calculate or run a payroll. So an unprocessed payroll yields a check date with no dollar amount. The forecast therefore baselines off processed history and projects over the cadence, rather than reading upcoming-payroll totals directly. If a future CLI version adds a calculate/run command (so unprocessed payrolls expose `totals`), those calculated amounts could be used as exact near-term figures in place of the projected baseline.

## Risk and rollback

- This skill is strictly read-only. It calls `pay-schedule show`, `payroll list`, and `employee list` — none of which create or modify server-side state. There is nothing to roll back.

## Out of scope

- Running or scheduling payroll (this only forecasts; use the onboarding/payroll commands to act).
- Modeling benefit or tax-rate changes, raises, or planned hires — the projection holds the baseline flat.
- Multi-company / partner-level aggregation (single company per run).
- Account-level general-ledger reconciliation. The `totals` object provides the net-pay/taxes/benefits cash split the forecast needs; if you want the full GL postings for a processed payroll, use `gusto ledger show <payroll_uuid>` separately (it returns presigned `report_urls` to a GL JSON, not an inline breakdown).
