import type { Command } from "commander";
import { createInterface } from "node:readline/promises";
import { type StdinReader, type TokenSource, fetchAtPath, resolveApiContext } from "../lib/api-context.ts";
import { TOKEN_STDIN_OPT } from "../lib/cli-options.ts";
import { type ConfigPaths, readConfig, type SkillsAutoInstall, writeConfig } from "../lib/config.ts";
import { defaultEnv, getAccessToken } from "../lib/env.ts";
import { ExitCode } from "../lib/exit-codes.ts";
import { type Environment, type GlobalFlags, readGlobalFlags } from "../lib/global-flags.ts";
import { toResult } from "../lib/handle-api-error.ts";
import { oauthHttp } from "../lib/oauth/context.ts";
import { type SignInUrlEvent, type TokenInfo, companyUuidFromTokenInfo, login } from "../lib/oauth/login.ts";
import { findMissingScopes } from "../lib/oauth/required-scopes.ts";
import { parseScopes, summarizeGrantedScopes } from "../lib/oauth/scopes.ts";
import { type StreamSinks, resolveOutputMode } from "../lib/output.ts";
import { type TokenStore, resolveStore } from "../lib/oauth/token-store.ts";
import {
  type AutoInstallResult,
  SKILL_TARGET_KINDS,
  type SkillsDir,
  autoInstallTargets,
  installBundledSkillsInto,
  listSkills,
  resolveSkillTargets,
  supportedToolHomeLabels,
} from "../lib/skills.ts";
import { type CommandHandler, runCommand, runReadCommand } from "../lib/runner.ts";

interface AuthOpts {
  tokenStdin?: boolean;
}

// commander negatable flags: `--no-browser` sets `browser: false` (default true);
// `--no-skills` sets `skills: false` (default true).
interface LoginOpts {
  browser?: boolean;
  skills?: boolean;
  target?: string;
}

export function registerAuthCommand(parent: Command): void {
  const cmd = parent.command("auth").description("OAuth identity (login, logout, whoami)");

  cmd
    .command("login")
    .description("Open the browser for OAuth PKCE login and store the token")
    .option(
      "--no-browser",
      "Don't auto-open the browser - print the sign-in URL for the user to open manually. You still need a browser running on this machine to complete sign-in; the OAuth callback returns to 127.0.0.1 here. Use when the agent is driving the CLI, on a headless box, or when auto-open is unreliable.",
    )
    .option(
      "--no-skills",
      "Skip the bundled-skills install (one-shot). To opt out permanently: `gusto config set skills_auto_install never`.",
    )
    .option(
      "--target <tools>",
      "Install bundled skills into specific agent tools instead of auto-detecting from what is on this machine. Comma-separated list of claude, cursor, codex, cline, windsurf (or `all`). Also settable via GUSTO_SKILLS_TARGET. Overrides detection and a persisted `never` for this run.",
    )
    .action((opts: LoginOpts) =>
      runCommand(
        "gusto auth login",
        readGlobalFlags(parent.opts()),
        authLoginHandler({ noBrowser: opts.browser === false, noSkills: opts.skills === false, target: opts.target }),
      ),
    );

  cmd
    .command("logout")
    .description("Clear the locally stored OAuth session")
    .action(() => runCommand("gusto auth logout", readGlobalFlags(parent.opts()), authLogoutHandler()));

  cmd
    .command("whoami")
    .description("Show token identity + granted scopes via /v1/token_info")
    .option(...TOKEN_STDIN_OPT)
    .action((opts: AuthOpts) =>
      runReadCommand("gusto auth whoami", readGlobalFlags(parent.opts()), authWhoamiHandler(opts)),
    );
}

export interface LoginData {
  identity: NonNullable<TokenInfo["resource_owner"]>;
  company_uuid: string | null;
  scope?: string;
  skills_installed?: AutoInstallResult[];
}

export function loginResultData(info: TokenInfo): LoginData {
  if (!info.resource_owner) throw new Error("login succeeded but token_info returned no identity");
  return { identity: info.resource_owner, company_uuid: companyUuidFromTokenInfo(info) ?? null, scope: info.scope };
}

/** The two values the prompt can resolve to. `"ask"` is the unresolved/initial state in
 * `SkillsAutoInstall`; it must not be the *answer*, since persisting `"ask"` would cause
 * an infinite re-prompt loop on every subsequent login. Narrowing here makes that
 * invariant a compile error rather than a runtime hazard. */
export type SkillInstallChoice = Exclude<SkillsAutoInstall, "ask">;

export interface SkillInstallDeps {
  configPaths?: ConfigPaths;
  // Explicit destination from --target / GUSTO_SKILLS_TARGET; overrides auto-detection.
  dirs?: SkillsDir[];
  // Set by the deliberate --target flag: bypass consent and a persisted `never`. Env targets do not.
  force?: boolean;
  // Base directory for auto-detecting installed agent tools (tests inject a tmp home).
  home?: string;
  // Best-effort warning (e.g. an invalid ambient env target) emitted only once consent is established, so `never` stays silent.
  warning?: string;
  prompt?: () => Promise<SkillInstallChoice>;
  // Override the stdin-TTY check (tests). When omitted, reads `process.stdin.isTTY`.
  stdinIsTty?: boolean;
}

// Install into each dir; a per-tool failure becomes a warning while the other tools' results stand.
async function fanOutInstall(dirs: SkillsDir[], sinks: StreamSinks): Promise<AutoInstallResult[]> {
  const { results, errors } = await installBundledSkillsInto(dirs);
  // Report each failed tool plainly; successes are carried in the returned results / login envelope.
  for (const e of errors) {
    sinks.stderr.write(`warning: could not install bundled skills into ${e.kind} (${e.message}).\n`);
  }
  return results;
}

// Install bundled skills after login: a --target flag (force) overrides consent/`never`; env + auto-detect honor them.
export async function maybeInstallSkillsAfterLogin(
  globals: GlobalFlags,
  sinks: StreamSinks,
  deps: SkillInstallDeps = {},
): Promise<AutoInstallResult[] | undefined> {
  // A deliberate --target flag implies consent and overrides `never` for this run.
  if (deps.force && deps.dirs !== undefined) return fanOutInstall(deps.dirs, sinks);

  const cfg = await readConfig(deps.configPaths);
  let pref: SkillsAutoInstall = cfg.skills_auto_install ?? "ask";
  // Honored even when an ambient GUSTO_SKILLS_TARGET is set, and before any warning fires.
  if (pref === "never") return undefined;

  // Past the opt-out gate: safe to surface a threaded best-effort warning without nagging opted-out users.
  if (deps.warning) sinks.stderr.write(`warning: ${deps.warning}\n`);

  // An env target names where to install; otherwise fan out to every detected tool.
  const dirs = deps.dirs ?? autoInstallTargets(deps.home);
  if (dirs.length === 0) {
    // Hardcoding a default here is the original bug; make the no-op legible instead.
    sinks.stderr.write(noToolDetectedWarning());
    return [];
  }

  if (pref === "ask") {
    // Prompt only when both streams are interactive; agent/piped or EOF-stdin implies consent.
    const stdinTty = deps.stdinIsTty ?? Boolean(process.stdin.isTTY);
    if (resolveOutputMode(globals) === "agent" || !stdinTty) {
      pref = "always"; // implicit consent; do not persist so a later human run still prompts
    } else {
      pref = await (deps.prompt ?? (() => promptForSkillsAutoInstall(dirs, sinks)))();
      await writeConfig({ ...cfg, skills_auto_install: pref }, deps.configPaths);
    }
  }
  if (pref === "never") return undefined;
  return fanOutInstall(dirs, sinks);
}

// Tool-agnostic `[Y/n]` copy naming the skills and detected target dirs. Pure + exported for tests.
export function skillsInstallPromptText(dirs: SkillsDir[]): string {
  const names = listSkills()
    .map((s) => s.name)
    .join(", ");
  const targets = dirs.map((d) => d.path).join(", ");
  return `Install bundled Gusto skills (${names}) into these agent tools (${targets})? [Y/n] `;
}

// Warning when no supported tool is found; lists the probed home dirs and its own off-switch.
export function noToolDetectedWarning(): string {
  const rows = supportedToolHomeLabels()
    .map((t) => `  ${t.kind.padEnd(10)} ${t.label}`)
    .join("\n");
  return [
    "warning: signed in, but found no supported agent tool, so no skills were installed.",
    "Checked for these tools by their home directory:",
    rows,
    "Install or launch one and run `gusto auth login` again, or force a target now with --target <tool[,...]> or GUSTO_SKILLS_TARGET.",
    "To stop seeing this, opt out with `gusto config set skills_auto_install never`.",
    "",
  ].join("\n");
}

/** Map a raw answer to the `[Y/n]` prompt to a persisted preference. Empty / y / yes
 * (case-insensitive, trimmed) opt in; anything else opts out. Extracted so the boundary
 * cases (Y, YES, whitespace, "no", garbage) are unit-testable without driving readline. */
export function parseAutoInstallAnswer(raw: string): SkillInstallChoice {
  const norm = raw.trim().toLowerCase();
  return norm === "" || norm === "y" || norm === "yes" ? "always" : "never";
}

async function promptForSkillsAutoInstall(dirs: SkillsDir[], sinks: StreamSinks): Promise<SkillInstallChoice> {
  const rl = createInterface({ input: process.stdin, output: sinks.stderr });
  try {
    const raw = await rl.question(skillsInstallPromptText(dirs));
    return parseAutoInstallAnswer(raw);
  } finally {
    rl.close();
  }
}

export async function performLogout(store: TokenStore, env: Environment): Promise<{ cleared: boolean }> {
  const session = await store.load(env);
  if (!session) return { cleared: false };
  await store.clear(env);
  return { cleared: true };
}

/** Agent mode (explicit --agent/--json OR auto-on when stdout is piped) gets a callback
 * that writes a JSON line for `login` to fire the moment the loopback server binds, before
 * blocking on the OAuth callback. Returns undefined in human mode so the URL is only printed. */
export function buildSignInUrlEmitter(
  globals: GlobalFlags,
  sinks: StreamSinks,
): ((event: SignInUrlEvent) => void) | undefined {
  if (resolveOutputMode(globals) !== "agent") return undefined;
  return (event) => sinks.stdout.write(`${JSON.stringify(event)}\n`);
}

/** Injectable transports so handler tests can drive the env-warning, login, and
 * post-login skill-install branches without standing up a real OAuth flow or
 * filesystem. Production callers omit `deps`; each field falls back to the real
 * implementation. */
type LoginFn = (env: Environment, deps: Parameters<typeof login>[1]) => Promise<TokenInfo>;
export interface AuthLoginDeps {
  login?: LoginFn;
  installSkills?: typeof maybeInstallSkillsAfterLogin;
}

export function authLoginHandler(
  opts: { noBrowser?: boolean; noSkills?: boolean; target?: string } = {},
  deps: AuthLoginDeps = {},
): CommandHandler {
  const doLogin = deps.login ?? login;
  const doInstallSkills = deps.installSkills ?? maybeInstallSkillsAfterLogin;
  return async ({ globals, sinks }) => {
    // A set GUSTO_ACCESS_TOKEN outranks the session we're about to store, so every
    // later command would run as the env token's identity, not this login's. Warn
    // (gh refuses `--with-token` under GITHUB_TOKEN for the same reason) so the user
    // isn't misled about which identity is active.
    if (getAccessToken()) {
      sinks.stderr.write(
        "warning: GUSTO_ACCESS_TOKEN is set and overrides the stored login. Commands will use that token, not this session. Unset it to use the logged-in identity.\n",
      );
    }
    // Resolve target. An explicit --target flag forces and, if invalid, halts before sign-in. An
    // ambient GUSTO_SKILLS_TARGET must never block login (skills are best-effort): an invalid value
    // just warns and falls back to auto-detection. A blank --target does not shadow the env var.
    const validSkillTargets = `Valid: ${SKILL_TARGET_KINDS.join(", ")}, or all.`;
    let targetDirs: SkillsDir[] | undefined;
    let targetForced = false;
    let envTargetWarning: string | undefined;
    if (!opts.noSkills) {
      const flag = opts.target && opts.target.trim().length > 0 ? opts.target : undefined;
      if (flag !== undefined) {
        const resolved = resolveSkillTargets(flag);
        if (!resolved.ok) {
          return {
            ok: false,
            exitCode: ExitCode.Validation,
            error: {
              code: "invalid_skill_target",
              message: `Unknown --target value(s): ${resolved.invalid.join(", ")}. ${validSkillTargets}`,
            },
          };
        }
        targetDirs = resolved.dirs;
        targetForced = true;
      } else {
        const env = process.env.GUSTO_SKILLS_TARGET;
        if (env && env.trim().length > 0) {
          const resolved = resolveSkillTargets(env);
          if (resolved.ok) targetDirs = resolved.dirs;
          else
            envTargetWarning = `ignoring invalid GUSTO_SKILLS_TARGET value(s): ${resolved.invalid.join(", ")}. ${validSkillTargets} Falling back to auto-detection.`;
        }
      }
    }
    let data: LoginData;
    try {
      const info = await doLogin(defaultEnv(globals.env), {
        store: resolveStore(),
        http: oauthHttp(globals),
        noBrowser: opts.noBrowser,
        emitEvent: buildSignInUrlEmitter(globals, sinks),
      });
      data = loginResultData(info);
    } catch (err) {
      return toResult(err);
    }
    // Login succeeded and the token is persisted; the bundled-skills install is a
    // best-effort side-effect. An fs error, prompt EOF/Ctrl+C, or readonly config
    // dir mustn't flip a successful login into an error envelope - the user is
    // already signed in and will be confused if we say otherwise.
    if (!opts.noSkills) {
      const installDeps: SkillInstallDeps = { warning: envTargetWarning };
      if (targetDirs) {
        installDeps.dirs = targetDirs;
        installDeps.force = targetForced;
      }
      try {
        const skills = await doInstallSkills(globals, sinks, installDeps);
        if (skills) data.skills_installed = skills;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        sinks.stderr.write(`warning: signed in but skipped bundled skill install: ${message}\n`);
      }
    }
    return { ok: true, data };
  };
}

export function authLogoutHandler(deps: { store?: TokenStore } = {}): CommandHandler {
  return async ({ globals, sinks }) => {
    try {
      const store = deps.store ?? resolveStore();
      const env = defaultEnv(globals.env);
      const data = await performLogout(store, env);
      // The default flip means `gusto auth logout` (no --env) targets production. A
      // session under the other env stays on disk and the user may think they're fully
      // logged out - point them at it. Fires even when this env was cleared, so a
      // stranded session is never left silently. Best-effort: a failed read of the
      // other env must not fail a logout that already did its job.
      try {
        const other: Environment = env === "production" ? "sandbox" : "production";
        if (await store.load(other)) {
          sinks.stderr.write(
            `warning: a ${other} session is still stored. Run \`gusto auth logout --env ${other}\` to remove it.\n`,
          );
        }
      } catch {
        // the stranded-session hint is best-effort; ignore read failures
      }
      return { ok: true, data };
    } catch (err) {
      return toResult(err);
    }
  };
}

/** Human-facing name for each credential source, matching how a user supplies it.
 * Exported so the label table itself is unit-testable - whoami's integration test
 * can't easily reach the `session` branch without a real session file, and the
 * concern is "label typo slipped through", which a direct const-map test catches. */
export const CREDENTIAL_SOURCE_LABEL: Record<TokenSource, string> = {
  stdin: "--token-stdin",
  env: "GUSTO_ACCESS_TOKEN",
  session: "stored session",
};

export function authWhoamiHandler(opts: AuthOpts, readStdin?: StdinReader): CommandHandler {
  return async ({ globals }) => {
    // Resolve the context ourselves (rather than going through `fetchResource`) so the
    // response body can be decorated with the `tokenSource` that won.
    const resolved = await resolveApiContext(globals, {
      requireCompany: false,
      tokenStdin: opts.tokenStdin,
      readStdin,
    });
    if (!resolved.ok) return resolved.result;
    const result = await fetchAtPath<TokenInfo>(resolved.ctx.client, "/v1/token_info");
    if (!result.ok) return result;
    const granted = parseScopes(result.data?.scope);
    const missing = findMissingScopes(granted);
    return {
      ok: true,
      data: {
        ...result.data,
        credential_source: CREDENTIAL_SOURCE_LABEL[resolved.ctx.tokenSource],
        capabilities: summarizeGrantedScopes(granted),
        ...(missing.length > 0 ? { missing_scopes: missing } : {}),
      },
    };
  };
}
