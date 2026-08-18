import path from "node:path";
import { parse, stringify } from "smol-toml";
import { type ConfigPaths, configPaths as defaultConfigPaths, readConfig } from "./config.ts";
import { ExitCode, type ExitCodeValue } from "./exit-codes.ts";
import type { GlobalFlags } from "./global-flags.ts";
import { outputOptionsFrom } from "./output.ts";
import type { CommandResult } from "./runner.ts";
import { VERSION } from "./version.ts";

/** Two moments worth routing an agent to `gusto feedback`:
 * - `escape_hatch`: the caller reached for `gusto api request`, the raw REST escape hatch — a signal
 *   that a first-class command was missing (→ feature_request).
 * - `friction`: the command failed in a way that isn't a working guardrail (→ bug). */
type Trigger = "friction" | "escape_hatch";

/** The `gusto feedback --category` value each trigger pre-fills. */
type NudgeCategory = "bug" | "feature_request";

const CATEGORY_FOR: Readonly<Record<Trigger, NudgeCategory>> = {
  friction: "bug",
  escape_hatch: "feature_request",
};

/** At most one nudge per category per 24h, so a run of failures (or repeated escape-hatch calls)
 * doesn't spam the same suggestion. Keyed per category so a `bug` nudge and a `feature_request`
 * nudge don't throttle each other. */
export const NUDGE_THROTTLE_MS = 24 * 60 * 60 * 1000;

/** Throttle bookkeeping lives beside `config.toml` but stays separate from it: this file is
 * machine-written state, not something a user hand-edits, and mixing the two would risk clobbering
 * user config on a best-effort write. */
const NUDGE_STATE_FILE = "nudge-state.toml";

export interface NudgeInputs {
  command: string;
  globals: GlobalFlags;
  code: ExitCodeValue;
  result: CommandResult;
}

export interface NudgeDeps {
  /** Injected clock, so tests can advance time across the throttle window. */
  now: () => number;
  /** Injected so tests can point throttle state at a temp dir. */
  configPaths: () => ConfigPaths;
}

/** Decide whether to nudge for this command, and return the ready-to-print stderr string (or null).
 *
 * Trigger + suppression + opt-out are all computed before any disk access, so the common case (no
 * nudge warranted) never touches the filesystem. Every disk operation is best-effort: throttle state
 * is a nicety, never a reason to fail or delay the command. */
export async function feedbackNudge(inputs: NudgeInputs, deps: NudgeDeps): Promise<string | null> {
  const classified = classify(inputs);
  if (!classified) return null;

  // Opt-out: `feedback_nudge = "never"` disables entirely. A missing/malformed config just means
  // "not opted out" — never let a bad config file suppress or crash the nudge path.
  if (await isOptedOut(deps)) return null;

  // Only now — with a nudge otherwise warranted — do we touch disk for the throttle.
  const allowed = await checkAndRecordThrottle(classified, deps);
  if (!allowed) return null;

  return render(inputs, classified);
}

/** `feedback_nudge = "never"` disables the nudge. A missing or malformed config reads as "not opted
 * out" rather than crashing or silently suppressing. */
async function isOptedOut(deps: NudgeDeps): Promise<boolean> {
  try {
    const cfg = await readConfig(deps.configPaths());
    return cfg.feedback_nudge === "never";
  } catch {
    return false;
  }
}

/** Classify the trigger for a finished command, or null when no nudge applies. Order matters:
 * surface-level and guardrail suppressions come before the trigger checks. */
function classify(inputs: NudgeInputs): Trigger | null {
  const { command, code, result } = inputs;
  const errorCode = result.ok ? undefined : result.error.code;

  // Never nudge from the feedback command itself, or from config/auth flows — those are either the
  // destination or setup steps where a nudge is noise.
  if (command === "gusto feedback") return null;
  if (command.startsWith("gusto config")) return null;
  if (command.startsWith("gusto auth login")) return null;

  // A confirmation prompt (exit 8) is the write guardrail doing its job, not friction.
  if (errorCode === "confirmation_required") return null;

  // A dry-run previewed a request without running it — nothing happened worth nudging about.
  if (result.ok && result.dryRun) return null;

  // The raw REST escape hatch signals a missing first-class command, whether it succeeded or failed.
  if (command === "gusto api request") return "escape_hatch";

  // Any genuine failure (an error envelope with a non-zero exit) is friction. Reads that succeed,
  // and non-zero exits without an error envelope (e.g. the `--fields` discovery usage helper), are
  // not — friction requires an actual error result.
  if (!result.ok && code !== ExitCode.Success) return "friction";

  return null;
}

/** Best-effort per-category throttle. Returns true when a nudge may fire (and records the timestamp),
 * false when one fired for this category inside the window. A disk error never blocks the nudge. */
async function checkAndRecordThrottle(trigger: Trigger, deps: NudgeDeps): Promise<boolean> {
  const category = CATEGORY_FOR[trigger];
  const dir = deps.configPaths().dir;
  const now = deps.now();

  const state = await readNudgeState(dir);
  const last = state[category];
  if (typeof last === "string") {
    const lastMs = Date.parse(last);
    if (!Number.isNaN(lastMs) && now - lastMs < NUDGE_THROTTLE_MS) return false;
  }

  state[category] = new Date(now).toISOString();
  await writeNudgeState(dir, state);
  return true;
}

async function readNudgeState(dir: string): Promise<Record<string, string>> {
  try {
    const file = Bun.file(path.join(dir, NUDGE_STATE_FILE));
    if (!(await file.exists())) return {};
    const text = await file.text();
    if (text.trim().length === 0) return {};
    const parsed = parse(text) as Record<string, unknown>;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === "string") out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

// Write 0600 to a temp file then atomically rename over the target, mirroring the credentials store,
// so a concurrent reader never sees a half-written file. Wrapped so a write failure is swallowed.
async function writeNudgeState(dir: string, state: Record<string, string>): Promise<void> {
  try {
    const { mkdir, writeFile, rename } = await import("node:fs/promises");
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const target = path.join(dir, NUDGE_STATE_FILE);
    const tmp = `${target}.${process.pid}.tmp`;
    await writeFile(tmp, stringify(state), { mode: 0o600 });
    await rename(tmp, target);
  } catch {
    // Best-effort: losing a throttle write only risks an extra nudge later, never a failed command.
  }
}

/** The stderr nudge string. Agent mode gets a ready-to-run, pre-filled invocation with a JSON
 * context payload; human mode gets one short pointer line. */
function render(inputs: NudgeInputs, trigger: Trigger): string {
  const category = CATEGORY_FOR[trigger];
  const mode = outputOptionsFrom(inputs.globals).mode;

  if (mode === "agent") {
    const context = JSON.stringify(buildContext(inputs, trigger));
    return (
      `Was this the right call? Send feedback to Gusto:\n` +
      `gusto feedback --category ${category} --message "<what you were trying to do>" --context '${context}'\n`
    );
  }
  return `Was this the right call? Tell Gusto with \`gusto feedback --category ${category} --message "..."\`\n`;
}

/** The `--context` payload. ALLOWLIST ONLY — no response body, no `error.details`, no employee or
 * admin identifier. Every key here is non-PII operational metadata. */
function buildContext(inputs: NudgeInputs, trigger: Trigger): Record<string, unknown> {
  const { command, globals, code, result } = inputs;
  const errorCode = result.ok ? undefined : result.error.code;
  const requestId = result.ok ? undefined : result.error.request_id;

  const context: Record<string, unknown> = {
    command: commandSlug(command),
    exit_code: code,
  };
  if (errorCode !== undefined) context.error_code = errorCode;
  if (requestId !== undefined) context.request_id = requestId;
  context.cli_version = VERSION;
  context.environment = globals.env ?? "production";
  context.trigger = trigger;
  return context;
}

/** `"gusto api request"` → `"api-request"`. Strip the leading `gusto `, lowercase, spaces → dashes. */
function commandSlug(command: string): string {
  return command
    .replace(/^gusto /, "")
    .toLowerCase()
    .replace(/\s+/g, "-");
}

/** Convenience wrapper using the real config paths. Runner passes explicit deps; this exists for
 * callers that want the default clock/paths. */
export function feedbackNudgeWithDefaults(inputs: NudgeInputs): Promise<string | null> {
  return feedbackNudge(inputs, { now: Date.now, configPaths: () => defaultConfigPaths() });
}
