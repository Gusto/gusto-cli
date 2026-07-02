/** Commander option tuples shared across command groups so their flag text can't drift.
 * Spread into `.option(...)`: `cmd.option(...DRY_RUN_OPT)`. */

import type { Command } from "commander";

/** `--dry-run`: build (but don't send) the request(s); `(s)` covers any command that issues
 * more than one request. */
export const DRY_RUN_OPT = ["--dry-run", "Build the request(s) without sending"] as const;

/** `--example`: print a canned sample payload without calling the API. */
export const EXAMPLE_OPT = ["--example", "Print a canned sample payload without calling the API"] as const;

/** `--confirm`: approve a write so it runs in agent mode. Without it, a write driven by an agent
 * (piped/`--agent`/`--json`) is blocked with a `confirmation_required` envelope so a human stays in
 * the loop. No effect on reads, `--dry-run`, or interactive (TTY) runs. */
export const CONFIRM_OPT = ["--confirm", "Approve this write so it runs in agent mode"] as const;

/** `--token-stdin`: read one access token piped on stdin (the gh/docker pattern) - a
 * piped secret stays out of argv, shell history, and audit logs. Highest-priority
 * source: an explicit token overrides GUSTO_ACCESS_TOKEN and the stored login
 * session, and is never replaced by the session even if invalid. */
export const TOKEN_STDIN_OPT = [
  "--token-stdin",
  "Read the access token from stdin (one line); for automation",
] as const;

/** `--cursor`: resume paging from a prior response's `next` value. */
export const CURSOR_OPT = ["--cursor <token>", "Pagination cursor from a previous response's next value"] as const;

/** `--all`: walk every page, issuing as many requests as it takes. */
export const ALL_OPT = ["--all", "Fetch every page (may issue multiple requests)"] as const;

/** Add the company-context options (`--company-uuid` + `--token-stdin`) every company-scoped
 * command shares, so a single command can resolve which company to act on and how to auth. */
export function withContextOptions(cmd: Command): Command {
  return cmd.option("--company-uuid <uuid>", "Company UUID (overrides GUSTO_COMPANY_UUID)").option(...TOKEN_STDIN_OPT);
}
