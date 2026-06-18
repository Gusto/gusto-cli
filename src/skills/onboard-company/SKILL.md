---
name: onboard-company
description: Use when the user wants to set up a new Gusto company, get a company onto payroll, or onboard their business end-to-end. Drives provisioning, federal/state tax setup, bank linkage, pay schedule, first W-2 hire, and signing company forms.
---

# Onboard a Gusto company

Walks the user through onboarding a new Gusto company. Drives the `gusto` CLI to provision the company, set up federal/state tax, bank, and pay schedule, add their first W-2 employee, and sign company forms. Interrupts the user only at the documented pause points.

## Preconditions

- Gusto CLI installed (`curl -fsSL https://raw.githubusercontent.com/Gusto/gusto-cli-public/main/install.sh | sh`)
- User has the company's details for the provision payload: company name, primary work address, and the admin user's name/email (see step 1 - `provision` has no default payload). Do **not** ask for EIN here; that's collected later at the federal-tax setup step.
- User has their first hire's name and email (other PII is collected via self-onboard invite, not in chat)
- User is willing to verify their identity in a browser tab during the flow

## Who is the user onboarding?

Before driving the flow, figure out which persona the user is. This determines whether to use invite-based or admin-driven paths for the signatory (step 6) and the first employee (step 5).

- **Multi-person team** - admin, signatory, and first employee are different people (or at least different inboxes). Default to the invite flow throughout: the CLI sends an email to each person and they self-complete their own PII / SSN / banking. This is the lowest-friction path when the admin doesn't have everyone's SSN on hand.
- **Sole owner / single-member LLC** - the user is the admin AND the intended signatory AND the only employee (very common founder case). The invite path dead-ends here: signatory-by-invite rejects the admin's own email, and employee-by-invite blocks waiting for the user to "accept" their own invite. **Branch into the admin-driven path** for both signatory and employee: the user supplies their own SSN / DOB / address up front. Steps 5 and 6 below describe both paths; pick the right branch.

If you're not sure, ask: _"Are you onboarding yourself as the only employee (sole owner / single-member LLC), or onboarding a team where the signatory and first employee are other people?"_

## Discovering commands

The command shapes below are a guide, not a spec. Confirm exact flags with `gusto <command> --help` (e.g. `gusto company setup bank-account --help`) rather than trusting hardcoded examples - `--help` is generated from the CLI and stays accurate as commands evolve.

## Steps

1. **Provision the company.** Run `gusto company provision --input <file.json>`, where the file holds a `{user, company}` payload. There is no default payload: bare `gusto company provision` errors with exit 7 (`invalid_input`) demanding `--input` or `--example`. Get the exact shape from `gusto company provision --help`, and preview the request body with `gusto company provision --dry-run --input <file>` before sending. `--example` fills in a canned sample payload (Ada Lovelace / Analytical Engines LLC) - but it _sends_, creating a real company, so it's only for throwaway test runs; `--dry-run` is the only non-mutating preview. **Don't collect or pass EIN at this step** - EIN is asked for at the federal-tax setup blocker (step 4), not at provision. On success it creates the company, returns an `account_claim_url`, and exits - it does not open a browser or log you in. The response's `next_command` points at the login step. Surface the `account_claim_url` to the user.

2. **Claim the account, then log in.** The user opens the `account_claim_url` and verifies identity (Google SSO is the magical path; email magic-link works too). Once they've claimed it, run `gusto auth login`. It auto-detects whether this machine can open a browser - it opens one when there's a GUI, and just prints the sign-in URL when it's headless (SSH/CI/no display). Either way, in agent mode it emits the sign-in URL as a `{"event":"sign_in_url",...}` line on stdout, so you can surface the URL to the user regardless of whether a browser opened. Pass `--no-browser` only to force print-only. `auth login` mints and persists the OAuth token, and the company UUID becomes available from that token (not from `provision`).

3. **Check onboarding status.** Run `gusto company onboarding-status`. Read the `blocked_on` array - each entry carries a `suggested_action` with the exact command (and flags) that resolves it. `next_command` is the first step to run.

4. **Clear the blockers.** Work the `blocked_on` list. Most steps map to a `gusto company setup <domain>` command:
   - `gusto company setup address --street-1 <street> --city <city> --state <CA> --zip <zip> --phone <phone>` (the company's primary location; `--phone` is required by the locations API). Run this _first_: it clears `add_addresses`, and because the location defaults to the company's filing address it also unblocks `federal_tax_setup` (which requires a filing address, not just the EIN). Pass `--no-filing-address` / `--no-mailing-address` to opt out.
   - `gusto company setup federal-tax --ein <ein> --tax-payer-type <type> --filing-form <941|944> --legal-name <name>` (run _after_ `setup address` - the step won't complete without a company filing address on file)
   - `gusto company setup industry --naics-code <code>` (add `--title`/`--sic-code` if known; both are derived from the NAICS code otherwise)
   - `gusto company setup bank-account --routing <num> --account-number <num> --account-type <Checking|Savings>` (connects + verifies in one shot). **Stop and ask the user for the real routing and account numbers - this is a pause point. Never invent or use dummy/example values here; the API connects the account immediately and a wrong number creates a real broken connection in demo.** Demo testers often don't have a real account on hand - in that case, pause and ask them to either provide one or skip the bank step for now (they can add it from the Gusto dashboard later).
   - `gusto company setup state-tax` (run _after_ step 5 - it reads states off employee work addresses, so it needs employees first; opts into new-employer default rates for CA/TX/FL)
   - `gusto company setup pay-schedule --frequency <weekly|biweekly|semi-monthly|monthly> --first-payday <YYYY-MM-DD> --anchor-end-of-pay-period <YYYY-MM-DD>` (all frequencies need `--anchor-end-of-pay-period`; monthly also needs `--day-1 <n>`, semi-monthly needs `--day-1 <n> --day-2 <n>`)
   - Note: signatory assignment is its own step (step 6) because it has to come before `company forms`. `onboarding-status` will list `assign_signatory` as a blocker; don't try to clear it here.

5. **Add the first W-2 employee.** Branch on persona:

   **Multi-person team (default).** Run `gusto employee add personal-details --first-name … --last-name … --email …` and let the CLI send a self-onboarding invite. The employee fills in their own SSN / address / banking. Don't ask the admin for the new hire's PII - they likely don't have it. After the invite is sent, the rest of step 5 is "wait for them to accept" (which can happen out of band; you can move on and re-check `onboarding-status` later).

   **Sole owner.** Add `--admin-driven` to bypass the invite and create the employee with the user's own data in one pass. Ask the user for SSN and date of birth before calling - you'll need both: `gusto employee add personal-details --first-name … --last-name … --email … --admin-driven --ssn <ssn> --date-of-birth YYYY-MM-DD`. Then run the rest of the sub-domains (`home-address`, `work-address`, `job`, `federal-tax`, `state-tax`, `payment-method`) with the user's own values - they have the data; don't wait on an invite.

   Add employees before `setup state-tax` - it reads states off their work addresses.

   **Sub-domain papercuts to know about:**
   - `employee add work-address` requires both `--location-uuid` and `--effective-date YYYY-MM-DD` (now marked `(required)` in `--help`). Default the effective date to today if you don't have a better one.
   - `employee add federal-tax` 422s if optional W-4 numeric flags (e.g. `--dependents-amount`, `--other-income`, `--deductions`) are omitted. Pass `0` for each unless the user provides actual values.
   - Always run `gusto employee add <subdomain> --help` before invoking a sub-domain - the help is the source of truth for what flags are accepted right now. If a command returns `exit 7` with a `blocked_on` envelope, that's the CLI telling you exactly which flags it still needs.

6. **Assign the signatory.** Branch on persona:

   **Multi-person team (default).** Run `gusto company setup signatory --first-name <name> --last-name <name> --email <email>` (add `--title` if known). This invites the signatory by email; they complete their own PII through the invite. The form-signing flow signs _on their behalf_, so the signatory must exist before `gusto company forms`.

   **Sole owner.** `setup signatory` is invite-only and rejects the admin's own email, so it can't self-assign. Use the raw API endpoint to create the signatory directly with the user's own data: `gusto api request POST /v1/companies/{company_uuid}/signatories --data '{"first_name":"…","last_name":"…","email":"…","title":"…"}'`. Get `{company_uuid}` from `gusto auth whoami` (it's on the token's resource). The endpoint accepts the admin's own email; the invite endpoint is the one that rejects it. After the POST, `onboarding-status` will move past the `assign_signatory` blocker and `gusto company forms` will work.

   `onboarding-status` surfaces signatory as an `assign_signatory` blocker ahead of `sign_all_forms`, and `gusto company forms` refuses to start until a signatory exists. Don't try to clear `assign_signatory` from inside step 4.

7. **Sign forms.** Run `gusto company forms`. With a signatory already assigned, this opens the hosted Gusto signing URL (Form 8655 + state agreements) straight into signing - no signatory setup inside the flow. Surface the URL to the signatory to click; don't sign on their behalf.

8. **Re-check.** Run `gusto company onboarding-status` again. A few things to know:
   - Blockers can be briefly stale right after a step completes. The `add_employees` blocker in particular sometimes stays in `blocked_on` for a moment after `employee add` succeeds. If a blocker you just cleared still appears, re-run `onboarding-status` once more before deciding it actually failed.
   - When `blocked_on` is empty, `stage` is `ready_to_finish` and `next_command` is `gusto company finish`. `onboarding_completed` does _not_ flip on its own - an explicit finish step is required.
   - **`ready_to_finish` / `onboarding_completed: true` is not the same as payroll-ready**, and the status now tells you the difference. Two fields track payroll readiness independently of onboarding: `payroll_ready` (boolean; `null` if the readiness check couldn't run) and `payroll_blockers` (the reasons the company still can't run payroll, from `/payrolls/blockers`). Each payroll blocker carries a `suggested_action` with the command that resolves it (or `null` for wait-states like `needs_approval` that you can only wait on). These show up _throughout_ onboarding, so you can see e.g. `missing_employee_setup` early rather than being surprised by it after finishing - dedup against the onboarding `blocked_on` means the section lists only the _additional_ payroll gates, not the steps you're already working.

9. **Finish onboarding.** Run `gusto company finish`. This calls `finish_onboarding`, which flips `onboarding_completed` to `true`. The company does _not_ need to be separately approved for anything the CLI does at this step. After finishing, `stage` moves to `done` **only if `payroll_ready` is `true`**; if payroll blockers remain, `stage` is `not_payroll_ready` and `next_command` drives the first one that has a resolving command. Keep working the `payroll_blockers` list (just like `blocked_on`) until `payroll_ready` is `true`. Some blockers are produced by Gusto's post-onboarding review (`needs_approval`, `pending_payroll_review`, `pending_recovery_case`) and have no CLI command - report them to the user and wait; they clear out of band. Only report "ready to run payroll" once `payroll_ready` is `true` (`stage: done`); otherwise say "onboarding complete - <N> payroll blocker(s) remaining."

## Pause points (user input required)

These are the only times the agent should stop and wait for the user:

- **Account claim + sign-in** (step 2 - the user claims the company in the browser, then `gusto auth login` needs them to finish signing in)
- **Bank account routing + account numbers** (step 4 bank-account - ask the user for real values; never use dummy/example numbers, the API connects immediately)
- **ACH e-signature** for the bank-connection step (legally binding)
- **Employee SSN and date of birth** (step 5, sole-owner branch only - the admin-driven path needs both up front; pause and ask, don't fabricate)
- **Signatory attestation** (the person who signs payroll forms must confirm in person)
- **Form 8655 + state agreements** (multi-page e-signatures)

Everything else - tax setup, location, industry, plan selection - is inferable from the user's earlier answers and should narrate, not interrogate.

## Output mode

Always pass `--agent` to every CLI call so the output is parseable JSON. The CLI auto-detects piped stdout and emits agent JSON by default, but be explicit for safety.

## Risk and rollback

- `gusto company provision` creates server-side state before the user has logged in (it returns the `account_claim_url` and exits). Both `--input` and `--example` send; only `--dry-run` is non-mutating, so preview there first. If `auth login` fails or is interrupted after provision, just rerun `gusto auth login` once the account is claimed - no need to re-provision (re-running provision, or running `--example` to "see what it does", creates a second company).
- Employee invites are reversible - the user can cancel an invite in the dashboard if they sent it to the wrong address.
- Pay-schedule creation is reversible until the first pay run.
- Form signing is a legally-binding attestation; the signatory must complete it in the hosted flow. Don't auto-sign.

## Out of scope

- Managing multiple companies from a single CLI session (out of scope for this skill)
- Plan selection / pricing
- Production environment (the CLI is sandbox-only today until sec/legal/compliance review lands)
- Running actual payroll (`gusto api request` works for one-off operations but the full payroll lifecycle isn't covered by this skill)
