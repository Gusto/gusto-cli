---
name: payroll-prep
description: Prep a draft payroll from an owner's per-cycle inputs - map hours, tips, commission, bonus, and reimbursement from a spreadsheet/POS export onto the open draft, then surface a review. Stops at a reviewable draft; the owner approves in-app.
---

# Prep payroll from file inputs

Drives the `gusto` CLI to take the per-cycle inputs an owner assembles by hand - hours, tips, commission, bonus, reimbursement - and land them on the open draft payroll for that pay period, ready to review. Use this when the user says "prep this period's inputs", "prep payroll", "import my tips/commission/bonus", "load my POS export into payroll", or "get this payroll ready to review". This skill stops at a populated, prepared **draft** payroll - it never processes or submits payroll. The owner reviews and approves the run in the Gusto dashboard.

## Preconditions

- Gusto CLI installed and authenticated (`gusto auth login`); company set via `GUSTO_COMPANY_UUID` or `--company-uuid`.
- The company is **payroll-ready** - it has a pay schedule, at least one fully set-up employee, and is approved to run payroll. There's no CLI readiness check; an unready company rejects writes with `422 invalid_operation`. Company-level setup (taxes, bank, forms, approval) happens in the Gusto dashboard.
- There is an **open (unprocessed) draft payroll** for the pay period you're prepping. The CLI prepares an existing draft; it doesn't create payrolls.
- The user has the **actual inputs** for the period ready as a file - typically a CSV (or a spreadsheet/POS export) of real hours and dollar amounts they've already assembled. Never fabricate them; they flow straight into a real (draft) payroll.

## Discovering commands

The command shapes below are a guide, not a spec. Confirm exact flags with `gusto <command> --help` (e.g. `gusto payroll update --help`) - `--help` is generated from the CLI and stays accurate as commands evolve. Run `gusto payroll update --example` to print the exact CSV columns and request shape (no uuid or auth needed). Preview any write with `--dry-run` (prints the request body without sending).

## What writes into what

- A **draft payroll** for a pay period reports its per-worker inputs through `employee_compensations`, which are only materialized when you run `gusto payroll prepare <payroll_uuid>`. Prepare the draft first so those compensations - and each one's optimistic-lock `version` - can be read back to build your write.
- `payroll update` writes per-employee inputs from a **CSV** onto the draft. The CSV is Gusto-shaped, one row per employee-job. Columns (case-insensitive); a header outside this set fails the whole file, so use these names exactly:
  - `employee_uuid` (**required**), `version` (optional), `job_uuid`
  - `regular_hours`, `overtime_hours`, `double_overtime_hours`
  - `bonus`, `commission`, `paycheck_tips`, `cash_tips`, `reimbursement`
  - The header must include `employee_uuid` plus **at least one input column**, or the whole file is rejected; every row must carry an `employee_uuid`.
- **Repeat `employee_uuid` across rows** to split hours over multiple jobs; the rows merge into one compensation.
- **Blank cell = leave untouched. Explicit `0` = override to zero.** A row with no input values is skipped and listed under `skipped_employees`, not failed. All input values must be **non-negative numbers**; a negative or non-numeric cell fails the whole file with a `blocked_on` error.
- **Hours (regular/overtime/double-overtime) and fixed comp (bonus/commission/tips) are replaced by name+job** on each run, so re-running with corrected values is safe. **Reimbursements are added on each run, not replaced** - set a reimbursement only once per cycle or you'll duplicate it.
- **`cash_tips` vs `paycheck_tips`** are two distinct built-in earning types (both supported). `cash_tips` are tips the employee already received in cash (reported for taxes, not paid out again); `paycheck_tips` are tips owed to the employee **through this paycheck**. If the owner's export just says "tips" without saying which, **pause and ask** - the choice changes net pay.
- `overtime_hours` / `double_overtime_hours` map to Gusto's built-in `Overtime` / `Double overtime` pay types, matched by their fixed seeded names. A pay type that isn't valid for a particular employee or job is **rejected by the API** (a `422`), not silently dropped - resolve it interactively with the user (step 6). Hour types beyond regular/OT/double-OT aren't supported here.
- **The write is all-or-nothing.** If any row is invalid, the API rejects the **entire** file with a `422` and writes nothing - one bad line blocks every employee. Resolve the error with the user and retry (step 6).
- **`skipped_employees` is not the same as "employee not in the file."** A `skipped_employees` entry is the benign case of a row that **is** in the CSV but carries **no input values** - the CLI drops just that row from the write and reports it. An employee with **no row at all** isn't skipped; the CLI never sees them, they're left untouched, and they won't appear in `skipped_employees` - the agent surfaces that gap itself in step 5.

## Steps

1. **Know the readiness bar.** There's no CLI readiness check - if the company isn't payroll-ready, the write in step 5 comes back with the `422` from Preconditions. If you hit it, finish setup in the Gusto dashboard, then retry.

2. **Find the draft payroll and the pay period.** Run `gusto payroll list --processing-status unprocessed` (add `--include payroll_status_meta` for check dates). Pick the draft whose pay period you're prepping and note its **`payroll_uuid`** and the **pay-period start/end dates**. Don't guess these - read them off the payroll. **If more than one unprocessed draft comes back** (common - several open periods at once), don't assume the latest: list the candidate pay periods and **confirm with the user which one** to prep.

3. **Prepare the draft to read the roster and versions.** Run `gusto payroll prepare <payroll_uuid>` and read back, for each employee, the **`employee_uuid`**, the optimistic-lock **`version`**, the employee **name** (for matching the owner's export), and the **`job_uuid`(s)**. `version` is the optimistic-lock token that keeps a write from clobbering a concurrent edit; it's optional on each CSV row, but include the freshest one you read here so the write is guarded. A successful write bumps an employee's `version`, so re-prepare to re-read it before any further write to that same employee. For a **single-job** employee, `job_uuid` is optional on the CSV row (inputs attach to the sole job); include it only to disambiguate. If an employee has **more than one job**, there's no safe default - **pause and ask the user which job** the hours/inputs belong to. Attaching inputs to the wrong `job_uuid` silently mis-routes them.

4. **Build the Gusto CSV from the owner's inputs.** Take the owner's spreadsheet/POS export (arbitrary columns) and produce the Gusto-shaped CSV directly: map each source column to `regular_hours` / `overtime_hours` / `double_overtime_hours` / `bonus` / `commission` / `paycheck_tips` / `cash_tips` / `reimbursement`, and resolve each worker's name to the `employee_uuid` and `version` from step 3. Leave a cell blank to leave that input untouched; use an explicit `0` only when you mean "set this to zero." Don't invent values. When a name doesn't match a roster entry cleanly (nicknames or abbreviations like "Alex" for "Alexander"), treat it as a **low-confidence match** and surface it in step 5 rather than writing it silently.

5. **Review the mapping with the user before writing.** Echo back, in plain terms: (a) the **column mapping** you inferred (which source column became which Gusto input), (b) the **per-employee values** you're about to write, and (c) a **needs-attention** section that flags (i) export rows you could **not** resolve to a Gusto employee, (ii) Gusto employees with **no row** in the export, and (iii) **low-confidence name matches** (nicknames/abbreviations) that resolved but warrant a human check. Write only the confidently-matched rows; never silently drop a row. **Get the user's confirmation**, then run `gusto payroll update <payroll_uuid> --input <csv>` - preview with `--dry-run` first.

6. **Resolve any write error with the user.** A failed `payroll update` comes back as a non-`ok` envelope - a `422` from the API (for example, a pay type that isn't valid for a given employee, or a value the server rejects) or a `blocked_on` validation error. The write is **all-or-nothing**, so nothing landed. Don't guess a fix or silently drop fields: surface the error verbatim - it names the offending **employee**, **field**, and **reason** - and **ask the user how to resolve it** (typically: confirm removing that field for that employee, or correcting its value). Apply only what the user confirms, rebuild the CSV, re-read `version`s if an earlier attempt changed anything, and re-run. Repeat until the write succeeds (or the user stops).

7. **Re-prepare and surface the review.** Run `gusto payroll prepare <payroll_uuid>` again and read back `employee_compensations`. Confirm the written inputs landed as expected. Present a per-employee review summary plus any `skipped_employees` and the unmatched rows from step 5. Stop here; the owner reviews and approves the run in the Gusto dashboard.

## Pause points (user input required)

- **The actual input values** (step 4) - hours and dollar amounts per worker. Never fabricate; they flow into a real draft payroll.
- **Confirm the mapping and values** (step 5) - the owner must approve the inferred column mapping and per-employee values before any write.
- **Which job** (step 3) - only when an employee has more than one job. Ask which one the inputs belong to; don't guess.
- **A write error** (step 6) - when the API rejects the write (a `422` or validation error), confirm the fix with the user (for example, removing a field for an employee) before retrying; never auto-resolve or silently drop fields.

Everything else - the draft payroll, pay-period dates, employee UUIDs, versions, and a single-job employee's `job_uuid` - is discoverable from the CLI and should be looked up, not asked.

## Output mode

Pass `--agent` to every call for parseable JSON (`{ "ok": true, "data": {...} }`). It's auto-on when stdout is piped, but be explicit for safety. Missing/invalid args come back as a `blocked_on` envelope (exit 7) listing exactly what to retry with.

## Risk and rollback

- **`payroll update` writes to a real draft payroll.** Preview with `--dry-run` and confirm the mapping and values with the user (step 5) before writing.
- **`version` guards against clobbering a concurrent edit.** It's the optimistic-lock token read off the prepared draft - optional on each CSV row, but include it. A successful write bumps an employee's `version`, so re-prepare to read the current value before writing to that same employee again.
- **Reimbursements are added, not replaced.** Re-running the update duplicates any reimbursement - set each reimbursement only once per cycle. Hours and bonus/commission/tips are replaced by name+job, so those are safe to re-run.
- **One invalid row fails the whole write.** The update is all-or-nothing: any value or pay type the server rejects returns a `422` and writes nothing for anyone. Don't auto-resolve - surface the `details.errors` (offending employee, field, reason) and confirm the fix with the user (step 6) before retrying.
- **The target payroll stays a draft (unprocessed).** This skill only populates and prepares the draft; it never submits or processes payroll, and the draft is reversible until someone processes it.

## Out of scope

- Processing or submitting payroll (this skill stops at a populated, prepared draft; the owner approves in-app).
- Hour types beyond regular/overtime/double-overtime.
- Off-cycle payrolls.
- Server-side Smart Import mapping and live POS connectors - inputs come from the owner's spreadsheet/export, written directly via `payroll update`.
