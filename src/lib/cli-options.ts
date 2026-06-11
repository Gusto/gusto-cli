/** Commander option tuples shared across command groups so their flag text can't drift.
 * Spread into `.option(...)`: `cmd.option(...DRY_RUN_OPT)`. */

/** `--dry-run`: build (but don't send) the request(s). `(s)` covers multi-request commands
 * like `employee add job` (job + compensation) and `payment-method` (bank account + method). */
export const DRY_RUN_OPT = ["--dry-run", "Build the request(s) without sending"] as const;

/** `--example`: print a canned sample payload without calling the API. */
export const EXAMPLE_OPT = ["--example", "Print a canned sample payload without calling the API"] as const;

/** `--token`: per-command access token override (falls back to GUSTO_ACCESS_TOKEN). */
export const TOKEN_OPT = ["--token <token>", "Access token (overrides GUSTO_ACCESS_TOKEN)"] as const;
