/** Shared bank-account helpers for the commands that create employee/company bank accounts. */
import { createdWithoutUuidError } from "./handle-api-error.ts";
import type { CommandResult } from "./runner.ts";

/** The failure returned when a bank-account create succeeds but the response carries no uuid.
 * Shared by `company setup payment-method` and `employee add payment-method` so the error code,
 * message, and shape stay in lockstep. `bank` is echoed back as `details` for debugging. */
export function bankCreateNoUuidError(bank: unknown): CommandResult<never> {
  return createdWithoutUuidError({
    code: "bank_create_no_uuid",
    message: "bank account create returned no uuid",
    details: bank,
  });
}
