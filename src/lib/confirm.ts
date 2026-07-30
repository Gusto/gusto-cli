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
  if (!WRITE_METHODS.has(method.toUpperCase())) return null;
  return agentWriteGate(globals, `${method} ${target}`, opts, stdoutIsTty);
}

/** The gate itself, over a free-form description of the write rather than an HTTP verb and path.
 *
 * Not every write this CLI performs is an API call - `gusto upgrade` replaces the binary the agent
 * is currently executing, which wants the same human-in-the-loop treatment and the same
 * `confirmation_required` contract, but has no method or endpoint to name. `confirmationGate` is
 * the HTTP-shaped caller; this is the shared decision. `description` is dropped into the message as
 * the subject of "is a write running in agent mode", so phrase it as a noun (`POST /v1/...`,
 * `replacing the gusto binary at ...`). */
export function agentWriteGate(
  globals: GlobalFlags,
  description: string,
  opts: ConfirmOpts,
  stdoutIsTty = process.stdout.isTTY === true,
): CommandResult<never> | null {
  if (opts.dryRun) return null;
  if (opts.confirm) return null;
  if (resolveOutputMode(globals, stdoutIsTty) !== "agent") return null;

  return {
    ok: false,
    exitCode: ExitCode.Blocked,
    error: {
      code: "confirmation_required",
      message:
        `${description} is a write running in agent mode. Surface it to the operator and ` +
        `re-run with --confirm once they approve. Preview it first with --dry-run.`,
      details: { retry_with: ["--confirm"], preview_with: ["--dry-run"] },
    },
  };
}
