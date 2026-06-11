---
name: onboard-company
description: Onboard a new Gusto company end-to-end - provision, set up taxes/bank/pay-schedule, add first hire, sign forms.
---

# Onboard a Gusto company

Walks the user through onboarding a new Gusto company. Drives the `gusto` CLI to provision the company, set up federal/state tax, bank, and pay schedule, add their first W-2 employee, and sign company forms. Interrupts the user only at the documented pause points.

## Preconditions

- Gusto CLI installed (`curl -fsSL https://raw.githubusercontent.com/Gusto/gusto-cli-public/main/install.sh | sh`)
- User has the company's details for the provision payload: company name, EIN, primary work address, and the admin user's name/email (see step 1 - `provision` has no default payload)
- User has their first hire's name and email (other PII is collected via self-onboard invite, not in chat)
- User is willing to verify their identity in a browser tab during the flow

## Discovering commands

The command shapes below are a guide, not a spec. Confirm exact flags with `gusto <command> --help` (e.g. `gusto company setup bank-account --help`) rather than trusting hardcoded examples - `--help` is generated from the CLI and stays accurate as commands evolve.

## Steps

1. **Provision the company.** Run `gusto company provision --input <file.json>`, where the file holds a `{user, company}` payload. There is no default payload: bare `gusto company provision` errors with exit 7 (`invalid_input`) demanding `--input` or `--example`. Get the exact shape from `gusto company provision --help`, and preview the request body with `gusto company provision --dry-run --input <file>` before sending. `--example` fills in a canned sample payload (Ada Lovelace / Analytical Engines LLC) - but it _sends_, creating a real company, so it's only for throwaway test runs; `--dry-run` is the only non-mutating preview. On success it creates the company, returns an `account_claim_url`, and exits - it does not open a browser or log you in. The response's `next_command` points at the login step. Surface the `account_claim_url` to the user.

2. **Claim the account, then log in.** The user opens the `account_claim_url` and verifies identity (Google SSO is the magical path; email magic-link works too). Once they've claimed it, run `gusto auth login --no-browser` - that prints the sign-in URL for you to surface instead of trying to open a browser on the machine the agent runs on. `auth login` mints and persists the OAuth token; the company UUID becomes available here (off the Mode 2 token), not from `provision`.

3. **Check onboarding status.** Run `gusto company onboarding-status`. Read the `blocked_on` array - each entry carries a `suggested_action` with the exact command (and flags) that resolves it. `next_command` is the first step to run.

4. **Clear the blockers.** Work the `blocked_on` list. Most steps map to a `gusto company setup <domain>` command:
   - `gusto company setup federal-tax --ein <ein> --tax-payer-type <type> --filing-form <941|944> --legal-name <name>`
   - `gusto company setup bank-account --routing <num> --account-number <num> --account-type <Checking|Savings>` (connects + verifies in one shot)
   - `gusto company setup state-tax` (run _after_ step 5 - it reads states off employee work addresses, so it needs employees first; opts into new-employer default rates for CA/TX/FL)
   - `gusto company setup pay-schedule --frequency <weekly|biweekly|semi-monthly|monthly> --first-payday <YYYY-MM-DD> --anchor-end-of-pay-period <YYYY-MM-DD>` (all frequencies need `--anchor-end-of-pay-period`; monthly also needs `--day-1 <n>`, semi-monthly needs `--day-1 <n> --day-2 <n>`)
   - Note: signatory assignment is its own step (step 6) because it has to come before `company forms`. `onboarding-status` will list `assign_signatory` as a blocker; don't try to clear it here.

5. **Add the first W-2 employee.** Run `gusto employee add personal-details --first-name … --last-name … --email …` to create the employee, then configure sub-domains with `gusto employee add <domain> <employee_uuid>` (see `gusto employee add --help`). The default sends an invite so the employee fills in their own PII / address / banking. The wedge cohort (founders adding first hires) rarely has the employee's SSN or banking on hand, so this is the right default. Add employees before `setup state-tax` - it reads states off their work addresses.

6. **Assign the signatory.** Run `gusto company setup signatory --first-name <name> --last-name <name> --email <email>` (add `--title` if known). This is the person who signs the company's payroll forms; the form-signing flow signs _on their behalf_, so they must exist first. `onboarding-status` surfaces this as an `assign_signatory` blocker ahead of `sign_all_forms`, and `gusto company forms` refuses to start until a signatory is assigned. The invite lets the signatory complete their own PII.

7. **Sign forms.** Run `gusto company forms`. With a signatory already assigned, this opens the hosted gws-flows signing URL (8655 + state agreements) straight into signing - no signatory setup inside the flow. Surface the URL to the signatory to click; don't sign on their behalf.

8. **Re-check.** Run `gusto company onboarding-status` again - when `blocked_on` is empty, `stage` is `ready_to_finish`. There's no separate finish command in V1: at `ready_to_finish` every required step is done and the company is set up. Gusto marks `onboarding_completed` on its side once it processes the final steps (re-run onboarding-status to see `stage: done`). Running actual payroll is out of V1 scope.

## Pause points (user input required)

These are the only times the agent should stop and wait for the user:

- **Account claim + sign-in** (step 2 - the user claims the company in the browser, then `gusto auth login` needs them to finish signing in)
- **ACH e-signature** for the bank-connection step (legally binding)
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

- Multi-company management (Embedded partner-facing surface)
- Plan selection / pricing
- Production environment (V1 is sandbox-only until sec/legal/compliance review lands)
- Running actual payroll (`gusto api request` works for one-off operations but the full payroll lifecycle isn't in V1)
