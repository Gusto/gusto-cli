---
name: timesheet-sync
description: Record tracked hours as Gusto time sheets and sync a pay period's hours into a draft payroll - create, sync, verify on the payroll.
---

# Sync time sheets to payroll

Drives the `gusto` CLI to take a pay period's worth of tracked hours, record them as approved time sheets for each worker, sync them into the draft (unprocessed) payroll for that pay period, and verify the hours landed on that payroll. Use this when the user says "log hours", "enter timesheets", "sync hours to payroll", or "pull timesheets into this payroll". This skill stops at a populated, prepared **draft** payroll - it never processes or submits payroll.

## Preconditions

- Gusto CLI installed and authenticated (`gusto auth login`); company set via `GUSTO_COMPANY_UUID` or `--company-uuid`.
- The company is **payroll-ready** - onboarding is finished and it has a pay schedule plus at least one fully set-up employee/contractor. Confirm with `gusto company onboarding-status` (`payroll_ready: true`, empty `payroll_blockers`). If it isn't, drive the `onboard-company` skill first. A company that hasn't finished onboarding rejects the sync with `422 invalid_operation: "Payroll is currently blocked for your account and cannot be modified."`
- The user knows the **actual hours** each worker logged for the pay period. Never fabricate hours - they flow straight into a real (draft) payroll.

## Discovering commands

The command shapes below are a guide, not a spec. Confirm exact flags with `gusto <command> --help` (e.g. `gusto timesheet create --help`) - `--help` is generated from the CLI and stays accurate as commands evolve. Preview any mutating call with `--dry-run` (prints the request body without sending) and see a canned payload with `--example`.

## What syncs into what

- `timesheet create` writes one **time sheet** = a single shift for one worker, carrying classified hours (`Regular` / `Overtime` / `Double overtime`). Time sheets are created **approved** - creating one is consequential, not a draft.
- A **draft payroll** for a pay period reports its per-worker hours through `employee_compensations`, which are only materialized when you run `payroll prepare <payroll_uuid>`. That's how you read the synced hours back off the payroll - you don't need to prepare _before_ syncing (the sync handles an unprepared draft on its own); you prepare _after_ to verify.
- `timesheet sync` is the bridge: it tells Time Tracking to pull every approved time sheet whose shift falls in `[pay_period_start_date, pay_period_end_date]` into the draft payroll for that pay period on the given pay schedule. It is **async** - the response is a `PayrollSync` with `status: pending`, not a finished payroll. Only `kind: "regular"` is supported (the CLI hard-codes it). Off-cycle payrolls are out of scope.

## Steps

1. **Confirm payroll readiness.** Run `gusto company onboarding-status`. Require `payroll_ready: true` and an empty `payroll_blockers`. If onboarding isn't finished, the sync is blocked (see Preconditions) - resolve the blockers (or hand to `onboard-company`) first.

2. **Find the draft payroll and the pay period.** Run `gusto payroll list --processing-status unprocessed` (add `--include payroll_status_meta` for check dates). Pick the draft payroll whose pay period you're logging hours for, and note three things from it: its **`payroll_uuid`**, the **`pay_schedule_uuid`**, and the **pay-period start/end dates** (`pay_period.start_date` / `.end_date`, both `YYYY-MM-DD`). Don't guess these - read them off the payroll.

3. **Gather the workers.** `gusto employee list` (employees) and `gusto contractor list` (contractors) give the entity UUIDs. For each employee you need a **`job_uuid`**: read it off the employee's record (`gusto employee show <employee_uuid>` -> the `jobs` array). Employee time sheets _require_ a job; contractor time sheets must _not_ carry one. If `jobs` has **more than one entry**, there's no safe default - **pause and ask the user which job the hours were worked under**. Attaching hours to the wrong `job_uuid` silently mis-routes them.

4. **Confirm the hours with the user.** For each worker, get real `--regular` (and any `--overtime` / `--double-overtime`) hours, plus the shift window and time zone. Don't invent hours or shift times.

5. **Create the time sheets.** One `gusto timesheet create` per shift. Preview with `--dry-run` first.
   - **Employee:** `gusto timesheet create --employee-uuid <uuid> --job-uuid <uuid> --start <ISO8601> --end <ISO8601> --time-zone <tz> --regular <hours> [--overtime <hours>] [--double-overtime <hours>]`
   - **Contractor:** same, but `--contractor-uuid <uuid>` and **no** `--job-uuid`.
   - `--start` / `--end` are ISO 8601 timestamps. `shift_started_at` must be **in the past** (the API rejects future shifts). Keep every shift inside the pay-period window from step 2, or the sync won't pick it up. `--time-zone` is required; at least one hour flag is required.

6. **Sync the pay period.** `gusto timesheet sync --pay-schedule-uuid <uuid> --pay-period-start <YYYY-MM-DD> --pay-period-end <YYYY-MM-DD>`. Preview with `--dry-run` first. The sync needs a payroll-ready company (step 1) and approved time sheets in the period - you do **not** need to prepare the payroll first. The response is a `PayrollSync` with `status: pending` (or `in_progress`); it runs asynchronously.

7. **Verify the hours landed on the payroll.** Run `gusto payroll prepare <payroll_uuid>` (the uuid from step 2) and read the worker's `employee_compensations` -> `hourly_compensations`. Confirm the `Regular` / `Overtime` / `Double overtime` hours match what you synced. Because the sync is async, if the hours still read zero it may not have finished - wait briefly and re-run `payroll prepare`. Report the hours to the user; stop here.

## Pause points (user input required)

- **Actual hours per worker** (step 4) - regular/overtime/double-overtime, shift window, and time zone. Never fabricate; they flow into a real draft payroll.
- **Which job** (step 3) - only when an employee has more than one job. Ask which one the hours were worked under; don't guess.

Everything else - the draft payroll, pay schedule, pay-period dates, entity UUIDs, and a single-job employee's `job_uuid` - is discoverable from the CLI and should be looked up, not asked.

## Output mode

Pass `--agent` to every call for parseable JSON (`{ "ok": true, "data": {...} }`). It's auto-on when stdout is piped, but be explicit for safety. Missing/invalid args come back as a `blocked_on` envelope (exit 7) listing exactly what to retry with.

## Risk and rollback

- **Time sheets are created approved**, not as drafts - `timesheet create` is a mutating call. Preview with `--dry-run` and confirm hours with the user first.
- **`timesheet sync` is async.** A `pending` / `in_progress` response is not confirmation; always verify with step 7 (prepare + read the hours) before telling the user the hours are in.
- **The target payroll stays a draft (unprocessed).** The sync only populates the draft; it doesn't submit or process payroll, and the draft is reversible until someone processes it. Processing/submitting payroll is out of scope for this skill.
- Shifts whose start/end fall outside `[pay_period_start, pay_period_end]` are silently not picked up - mismatched windows look like "nothing synced." Re-check the dates if the hours don't move.

## Out of scope

- Processing or submitting payroll (this skill stops at a populated, prepared draft).
- Off-cycle payrolls (`sync` only supports `kind: regular`).
- Editing or deleting existing time sheets (use `gusto api request` for one-off corrections).
