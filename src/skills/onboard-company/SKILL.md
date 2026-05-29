---
name: onboard-company
description: Onboard a new Gusto company end-to-end - provision, add first hire, set up pay schedule, finalize.
---

# Onboard a Gusto company

Walks the user through onboarding a new Gusto company. Drives the `gusto` CLI to provision the company, add their first W-2 employee, set up a pay schedule, and finalize. Interrupts the user only at the documented pause points.

## Preconditions

- Gusto CLI installed (`curl -fsSL https://cli.gusto.com/install.sh | sh`)
- User has their first hire's name and email (other PII is collected via self-onboard invite, not in chat)
- User is willing to verify their identity in a browser tab during the flow

## Steps

1. **Provision the company.** Run `gusto company provision`. The CLI will print a claim URL, open it in the user's browser, and wait. The user verifies identity (Google SSO is the magical path; email magic-link works too). When they return, the CLI mints an OAuth token and persists it.

2. **Check onboarding status.** Run `gusto company status`. Read the `blocked_on` field to know what's pending - federal tax setup, state tax setup, bank connection, signatory, etc. These plumbing steps are reached via `gusto api request` until they're promoted to first-class commands.

3. **Add the first W-2 employee.** Run `gusto employee add --first-name <X> --last-name <Y> --email <Z> --role <title> --comp <amount>`. The default sends an invite so the employee fills in their own PII / address / banking. The wedge cohort (founders adding first hires) rarely has the employee's SSN or banking on hand, so this is the right default.

4. **Set up a pay schedule.** Run `gusto pay-schedule create --frequency <weekly|bi-weekly|semi-monthly|monthly> --first-payday <YYYY-MM-DD>`. The CLI handles Gusto's date-math rules (pay-period alignment, weekend rollover).

5. **Finalize.** Run `gusto company finish`. Pre-checks status; refuses early with the structured `blocked_on` list if anything is still pending.

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
- `gusto company finish` is one-way; don't run it until `status` returns no blockers.

## Out of scope

- Multi-company management (Embedded partner-facing surface)
- Plan selection / pricing
- Production environment (V1 is sandbox-only until sec/legal/compliance review lands)
- Running actual payroll (`gusto api request` works for one-off operations but the full payroll lifecycle isn't in V1)
