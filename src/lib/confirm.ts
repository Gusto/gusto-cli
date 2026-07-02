import { ExitCode } from "./exit-codes.ts";
import type { GlobalFlags } from "./global-flags.ts";
import { resolveOutputMode } from "./output.ts";
import type { CommandResult } from "./runner.ts";

/** HTTP verbs that mutate server state. A confirmation gate only ever applies to these;
 * GET (and any other read) passes through untouched. */
const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export interface ConfirmOpts {
  /** `--confirm` was passed: the operator approved this specific write. */
  confirm?: boolean;
  /** `--dry-run` was passed: build the request without sending, so nothing to gate. */
  dryRun?: boolean;
}

/** Human-in-the-loop gate for write operations driven by an agent.
 *
 * The CLI is built for LLM automation (piped JSON, SKILL.md playbooks), so a write can otherwise
 * fire with no human in the loop. In agent mode a write must carry an explicit `--confirm`; without
 * it this returns a Blocked envelope telling the caller to surface the action and re-run once the
 * operator approves. `--dry-run` previews freely (it never sends), and human/TTY mode is left alone
 * - the operator running interactively *is* the loop. Reads are never gated.
 *
 * Returns the Blocked result to emit, or null to let the write proceed. `stdoutIsTty` is injectable
 * for tests; it defaults to the real stream like resolveOutputMode. */
export function confirmationGate(
  globals: GlobalFlags,
  method: string,
  target: string,
  opts: ConfirmOpts,
  stdoutIsTty = process.stdout.isTTY === true,
): CommandResult<never> | null {
  if (opts.dryRun) return null;
  if (opts.confirm) return null;
  if (!WRITE_METHODS.has(method.toUpperCase())) return null;
  if (resolveOutputMode(globals, stdoutIsTty) !== "agent") return null;

  return {
    ok: false,
    exitCode: ExitCode.Blocked,
    error: {
      code: "confirmation_required",
      message:
        `${method} ${target} is a write running in agent mode. Surface it to the operator and ` +
        `re-run with --confirm once they approve. Preview the request first with --dry-run.`,
      details: { retry_with: ["--confirm"], preview_with: ["--dry-run"] },
    },
  };
}
