/** Commander option tuples shared across command groups so their flag text can't drift.
 * Spread into `.option(...)`: `cmd.option(...DRY_RUN_OPT)`. */

/** `--dry-run`: build (but don't send) the request(s). `(s)` covers multi-request commands
 * like `employee add job` (job + compensation) and `payment-method` (bank account + method). */
export const DRY_RUN_OPT = ["--dry-run", "Build the request(s) without sending"] as const;

/** `--example`: print a canned sample payload without calling the API. */
export const EXAMPLE_OPT = ["--example", "Print a canned sample payload without calling the API"] as const;

/** `--token-stdin`: read one access token piped on stdin (the gh/docker pattern) - a
 * piped secret stays out of argv, shell history, and audit logs. Highest-priority
 * source: an explicit token overrides GUSTO_ACCESS_TOKEN and the stored login
 * session, and is never replaced by the session even if invalid. */
export const TOKEN_STDIN_OPT = [
  "--token-stdin",
  "Read the access token from stdin (one line); for automation",
] as const;
