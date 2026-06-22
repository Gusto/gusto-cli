---
name: cash-forecasting
description: Use when the user asks about payroll cash flow, runway, whether they can afford payroll, or how much they'll owe in upcoming pay periods. Projects upcoming payroll cash needs from processed-payroll totals + general-ledger data + pay-schedule cadence, and breaks the cash down into wages, taxes, employer benefits, and bank debits. Interactive and read-only.
---

# Forecast payroll cash needs

Projects how much cash a Gusto company needs to cover upcoming payroll **and** how that cash decomposes in accounting terms — wages, PTO, employer taxes by type, employer benefit contributions by plan, benefit liabilities, and the net-pay/tax bank debit — per check date. Read-only: it reads `gusto payroll list` totals, the `gusto pay-schedule show` cadence, and the `gusto ledger show` general ledger for each processed payroll, and never mutates anything.

It is **interactive**: it asks how much payroll history to base the forecast on and how far forward to project, and tells you how many processed payrolls are actually available when there aren't enough for the window you asked for.

## Preconditions

- Gusto CLI installed (`curl -fsSL https://raw.githubusercontent.com/Gusto/gusto-cli-public/main/install.sh | sh`) and authenticated (`gusto auth whoami`).
- The token must grant **payroll read scope** plus **both report scopes** (`payrolls:read`, `company_reports:read`, `company_reports:write`). The cash figures come from `gusto payroll list --include totals` (`payrolls:read`). The accounting decomposition comes from `gusto ledger show`, which is a generate-then-fetch flow against two endpoints with two scopes: `POST /v1/payrolls/{uuid}/reports/general_ledger` to generate (gated by `company_reports:write` — report _generation_ is modeled as a write even though it changes no business data) and `GET /v1/reports/{uuid}` to fetch (gated by `company_reports:read`). So the accounting layer needs **both** report scopes. Without them the respective call fails with an `insufficient_scope` error. Run `gusto auth whoami` — if `payrolls` isn't granted the skill can't run at all; if either `company_reports:read` or `company_reports:write` is missing, fall back to a cash-only forecast (the `totals` object carries the company-level cash split) and tell the user the per-account accounting layer is unavailable. Surface scope errors; never fabricate figures.
- The company has at least one pay schedule (`gusto pay-schedule show` returns a schedule). Without a schedule there's no cadence to project against.
- The company has **at least one processed payroll** — the only source of a real cash figure to baseline from. With zero processed payrolls, report the payday timeline from the pay schedule and say amounts are unavailable until a payroll has been processed.

## Interactive inputs

This skill is interactive: it asks for its two parameters up front rather than guessing. When a user is present, **ask before forecasting** — use the `AskUserQuestion` tool (or a plain question if that tool isn't available) to collect:

1. **History window** — how many months of processed payroll to base the forecast on. Offer **3 months as the recommended default**; more history makes the per-account trajectories more robust, and a single payroll can only support a flat baseline.
2. **Forecast horizon** — how many months forward to project. Offer **6 months as the recommended default**.

Ask even though defaults exist — surfacing the choice is the point. Skip the question only when the user already gave both values in their request, or when **no user can answer** (a headless / subagent run): then use the defaults and **state that you did**.

Then **check availability and report it** before going further: list processed payrolls on/after `today − history_months` and count them. If fewer are available than the window implies — or the company hasn't been on Gusto that long — say so explicitly, e.g. "You asked for 6 months (~13 biweekly payrolls); only 5 processed payrolls exist, earliest 2026-05-08. Forecasting from those 5." Never silently use less data than requested. With only one processed payroll a trajectory can't be fit — fall back to a flat baseline and state that.

## Discovering commands

The command shapes below are a guide, not a spec. Confirm exact flags and the JSON field names with `gusto <command> --help` (e.g. `gusto payroll list --help`) and by reading the actual `--agent` envelope, rather than trusting hardcoded examples. `--help` is generated from the CLI and stays accurate as commands evolve; the `totals` object on a payroll and the general-ledger JSON behind `ledger show` are passed through from the Gusto API, so read the field names off a real response.

## Approach

Two layers, both **data-driven — no external tax or wage-base tables**:

- **Cash baseline** — the per-period **company debit** (`totals.company_debit`) from processed payrolls: the actual amount Gusto pulls from the company's bank account.
- **Accounting decomposition** — for each processed payroll in the history window, the general ledger (`ledger show`) split by account. Each account gets its own **trajectory** across the history and is extrapolated forward on that trajectory rather than held flat. The processed history _is_ the year-to-date signal, expressed as a trend: employer Social Security tax easing as earners approach the annual wage base, FUTA/SUI already floored mid-year, wages and health/dental/vision flat. That is why no wage-base table is needed — the decline that a table would predict is already visible in the ledger series. The one thing this cannot do is anticipate a cap-out that has **not yet** begun bending the numbers (see [Accuracy and caveats](#accuracy-and-caveats)).

A processed payroll is the only place real figures exist, so the skill needs at least one (see [Limitations](#limitations)). Projected rows are estimates — they assume hours, headcount, and rates stay on their observed trajectory.

## Steps

1. **Cadence.** `gusto pay-schedule show` — record each active schedule's frequency and its check dates.
2. **Inputs + availability (pause point).** Ask the user for the history window and horizon before forecasting — see [Interactive inputs](#interactive-inputs) and [Pause points](#pause-points). Then list processed payrolls in the window — filtering by `check_date` (see step 3, so off-cycle/bonus runs aren't missed) — and report how many are actually available before going further.
3. **Cash baseline.** `gusto payroll list --processing-status processed --payroll-type regular,off_cycle --include totals --date-filter-by check_date --start-date <window-start> --end-date <~3 months ahead> --sort-order desc` — one call returns both regular and off-cycle runs in the window; partition on each row's `off_cycle` boolean (and read `off_cycle_reason`, e.g. `Bonus`). **Filter by `check_date`, not the default pay-period date** — this is load-bearing: cash leaves the account on the check date, and off-cycle/bonus runs have pay periods that don't line up with the cadence, so the API's default window (pay period, ending _today_) silently drops them and an off-cycle run can be missed entirely (verified: a Bonus run with check date 2026-06-17 is absent under the default filter, present under `check_date`). Set `--end-date` a few months out (the max is ~3 months in the future) to also catch already-processed runs with future check dates. The baseline figure is the **company debit** (`totals.company_debit`); if absent, sum the debit components (`net_pay_debit + tax_debit + reimbursement_debit + child_support_debit` — confirm the keys from the response). Take the most recent regular run's company debit, or an average of the last few, as the **per-period baseline**. Mark processed rows as source `actual`.
   - **If any off-cycle (non-regularly-scheduled) runs came back, stop and ask the user before including them — this is a pause point.** Off-cycle runs (bonus/commission/correction runs that don't follow the cadence) are irregular, so folding them into the per-period baseline inflates _every_ projected period. Offer the choice — exclude from the baseline (the safe default; they may still appear as one-off historical `actual` rows) or include. Don't decide silently; only when no user can answer, default to excluding and say so.
   - This prompt is about `off_cycle` payrolls only. A _regular_ run carrying a one-off bonus/commission is still on-cadence; handle that with the soft baseline-exclusion judgment in step 8.
4. **Ledger per payroll.** For each processed payroll in the window, `gusto ledger show <payroll_uuid>` → take one entry from `data.report_urls` and fetch it (the URLs are **presigned and expire in ~10 minutes** — fetch promptly after each call; re-request if one expires) → parse the general-ledger JSON. Its `data` array holds two blocks of `{headers, rows}` where each row is `[account_type, account_description, debit, credit]` (amounts are strings, one of debit/credit is null): **block 0** is company-aggregated by account type, **block 1** is per-employee. Collect both for every payroll in the window. Skip this step (and the accounting layer) only if report scope is missing.
5. **Company-level trajectories.** From the block-0 series across the window, build a per-account-type time series and extrapolate each forward over the cadence:
   - Stable accounts (regular wages, health/dental/vision benefit contributions, Medicare employer tax) → hold at the recent average.
   - Declining accounts (employer Social Security, 401(k) match, anything trending down) → continue the observed trend toward its floor; never below zero.
   - Already-floored accounts (FUTA / state SUI / ETT once near zero) → hold at floor.
     This is a trajectory heuristic, not a tax engine — state that.
6. **Per-employee trajectories.** From the block-1 series, project per-employee employer cost using the same trajectory logic. Only **gross wages** and **employer benefit contributions** are name-tagged in block 1 (the description ends in `… for <Name>`); **employer taxes are listed unlabeled** (e.g. `Social Security - employer tax`, no name) and so can be attributed to an employee only positionally/pro-rata, not reliably by name — keep employer tax at the company level or flag any per-employee tax split as an estimate. Block 1 also does **not** carry per-employee net pay or employee withholding (those appear only as company-level `DebitNetPay` / `DebitTax`), so per-employee figures are employer cost, not take-home.
7. **Reconcile + extrapolate.** Per projected period: **Gusto bank debit** = projected `DebitNetPay + DebitTax` (this is `company_debit`); **total employer cost** = projected debit-side accounts (wages + PTO + employer taxes + employer benefit contributions); **benefit-liability outflow** = projected `BenefitLiability` (employer contributions + employee deductions remitted to carriers/401(k) — separate from the Gusto debit). Walk the pay-schedule check dates forward from today to the horizon, source `projected`.
8. **Present.**
   - **Cash timeline** — a table `check_date | source (actual|projected) | company_debit`, sorted by check date, flagging clearly where `projected` rows begin.
   - **Accounting decomposition** — for the projected periods (and rolled up per month/quarter), the split: wages, PTO, employer tax by type, employer benefit contributions by plan, benefit liabilities, net-pay debit, tax debit. Show **total employer cost** and the **Gusto-debit portion** distinctly, since they differ by the benefit-liability outflow.
   - **Per-employee projection** — projected employer cost per named employee (label it as excluding net pay / withholding).
   - **Rolling totals** — per month and per quarter for the cash debit.
9. **Disclose the baseline provenance — without re-listing the payrolls.** The processed payrolls already appear as `actual` rows in the cash timeline, so don't print a second table repeating their `check_date`/`company_debit`. Instead, mark baseline membership inline on those `actual` rows (a `baseline` column or `✓`/`—`) and state the resulting baseline in one line: how many runs were averaged and the per-period figure (e.g. "baseline = avg of 4 regular runs = $27,524.38"). For any processed payroll excluded from the average (off-cycle, or a regular run carrying a one-off bonus/commission), mark it excluded and give the reason once. Never average payrolls silently.

## Pause points

These are the only times the skill should stop and wait for the user. Everything else — the cadence, which payrolls exist, how each account trends — is read or inferred from the data and should be narrated, not interrogated.

- **History window + forecast horizon** (up front) — ask before forecasting; see [Interactive inputs](#interactive-inputs).
- **Off-cycle payroll inclusion** (step 3) — if any processed off-cycle runs exist in the window, stop and ask whether to fold them into the baseline; they materially change every projected period.

When no user is present (a headless or subagent run), don't block at either pause point: use the documented defaults and state which you used.

## Output mode

Always pass `--agent` to every CLI call so the output is parseable JSON (`{ "ok": true, "data": {...} }`). The CLI auto-detects piped stdout and emits agent JSON by default, but be explicit for safety. (The fetched general-ledger report is plain JSON from S3, not a CLI envelope.)

## Accuracy and caveats

- `actual` rows are real Gusto figures (processed payrolls). `projected` rows are heuristic and will drift from reality as hours, new hires, terminations, off-cycle payrolls, bonuses, and tax/benefit rate changes occur. Always label projected rows and state the assumption.
- The accounting projection extrapolates each account's **observed trajectory**. It captures declines already in progress (e.g. employer Social Security easing as earners near the annual wage base, FUTA/SUI floored mid-year) but **cannot foresee a cap-out that hasn't started bending the numbers** — e.g. a high earner who will hit the Social Security wage base later in the year but whose per-period tax still looks flat today. Call this out; it is the deliberate trade-off for not maintaining wage-base tables.
- The company debit can vary between otherwise-identical pay periods (e.g. quarterly tax true-ups, benefit enrollment changes). Averaging the last few processed payrolls is more robust than using one.
- Per-employee output is **employer cost, not take-home** (wages + employer benefit contributions by name; employer tax stays company-level) — see step 6.

## Limitations

- **Upcoming/unprocessed payrolls are not used as a cash source.** `gusto payroll list --processing-status unprocessed --include totals` returns the scheduled paydates but **no `totals`** until a payroll has been _calculated_ (`calculated_at` is null on a freshly created payroll), and the V1 CLI has no command to calculate or run a payroll. So an unprocessed payroll yields a check date with no dollar amount. The forecast therefore baselines off processed history and projects over the cadence, rather than reading upcoming-payroll totals directly. If a future CLI version adds a calculate/run command (so unprocessed payrolls expose `totals`), those calculated amounts could be used as exact near-term figures in place of the projected baseline.

## Risk and rollback

- This skill makes no change to business data. It calls `pay-schedule show`, `payroll list`, and (optionally) `employee list` (all reads), and `ledger show`, which POSTs to _generate_ a general-ledger report (a write in API terms, requiring `company_reports:write`) and then fetches it — but a report is a transient artifact, not company/payroll state, so there is nothing to roll back.

## Out of scope

- Running or scheduling payroll (this only forecasts; use the onboarding/payroll commands to act).
- Wage-base / tax-rate **table-driven** modeling — the accounting forecast is trajectory-driven from observed ledger history by design, with no maintained threshold tables.
- Modeling raises or planned hires — projections follow observed trajectories, not future events.
- Multi-company / partner-level aggregation (single company per run).
