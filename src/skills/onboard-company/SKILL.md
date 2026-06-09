---
name: onboard-company
description: Onboard a new Gusto company end-to-end - provision, set up taxes/bank/pay-schedule, add first hire, sign forms.
---

# Onboard a Gusto company

Walks the user through onboarding a new Gusto company. Drives the `gusto` CLI to provision the company, set up federal/state tax, bank, and pay schedule, add their first W-2 employee, and sign company forms. Interrupts the user only at the documented pause points.

## Preconditions

- Gusto CLI installed (`curl -fsSL https://raw.githubusercontent.com/Gusto/gusto-cli-public/main/install.sh | sh`)
- User has their first hire's name and email (other PII is collected via self-onboard invite, not in chat)
- User is willing to verify their identity in a browser tab during the flow

## Steps

1. **Provision the company.** Run `gusto company provision`. The CLI will print a claim URL, open it in the user's browser, and wait. The user verifies identity (Google SSO is the magical path; email magic-link works too). When they return, the CLI mints an OAuth token and persists it.

2. **Check onboarding status.** Run `gusto company onboarding-status`. Read the `blocked_on` array - each entry carries a `suggested_action` with the exact command (and flags) that resolves it. `next_command` is the first step to run.

3. **Clear the blockers.** Work the `blocked_on` list. Most steps map to a `gusto company setup <domain>` command:
   - `gusto company setup federal-tax --ein <ein> --tax-payer-type <type> --filing-form <941|944> --legal-name <name>`
   - `gusto company setup bank-account --routing <num> --account-number <num> --account-type <Checking|Savings>` (connects + verifies in one shot)
   - `gusto company setup state-tax` (run _after_ step 4 - it reads states off employee work addresses, so it needs employees first; opts into new-employer default rates for CA/TX/FL)
   - `gusto company setup pay-schedule --frequency <weekly|biweekly|semi-monthly|monthly> --first-payday <YYYY-MM-DD>` (add `--anchor-end-of-pay-period <YYYY-MM-DD>` for weekly/biweekly)

4. **Add the first W-2 employee.** Run `gusto employee add ...` (see `gusto employee add --help`). The default sends an invite so the employee fills in their own PII / address / banking. The wedge cohort (founders adding first hires) rarely has the employee's SSN or banking on hand, so this is the right default. Add employees before `setup state-tax` - it reads states off their work addresses.

5. **Sign forms.** Run `gusto company forms`. This opens the hosted gws-flows signing URL (8655 + state agreements) for the signatory to click. Surface the URL to the user; don't sign on their behalf.

6. **Re-check.** Run `gusto company onboarding-status` again - when `blocked_on` is empty, `stage` is `ready_to_finish`. There's no separate finish command in V1: at `ready_to_finish` every required step is done and the company is set up. Gusto marks `onboarding_completed` on its side once it processes the final steps (re-run onboarding-status to see `stage: done`). Running actual payroll is out of V1 scope.

## Pause points (user input required)

These are the only times the agent should stop and wait for the user:

- **ACH e-signature** for the bank-connection step (legally binding)
- **Signatory attestation** (the person who signs payroll forms must confirm in person)
- **Form 8655 + state agreements** (multi-page e-signatures)

Everything else - tax setup, location, industry, plan selection - is inferable from the user's earlier answers and should narrate, not interrogate.

## Output mode

Always pass `--agent` to every CLI call so the output is parseable JSON. The CLI auto-detects piped stdout and emits agent JSON by default, but be explicit for safety.

## Risk and rollback

- `gusto company provision` is the only step that creates server-side state before the user has logged in. If anything fails after provision, the user can still claim the account in the browser and continue from there.
- Employee invites are reversible - the user can cancel an invite in the dashboard if they sent it to the wrong address.
- Pay-schedule creation is reversible until the first pay run.
- Form signing is a legally-binding attestation; the signatory must complete it in the hosted flow. Don't auto-sign.

## Out of scope

- Multi-company management (Embedded partner-facing surface)
- Plan selection / pricing
- Production environment (V1 is sandbox-only until sec/legal/compliance review lands)
- Running actual payroll (`gusto api request` works for one-off operations but the full payroll lifecycle isn't in V1)
