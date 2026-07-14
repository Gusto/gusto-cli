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
  /** Explicit resolved targets from `--target` / GUSTO_SKILLS_TARGET. When set, install into exactly
   * these dirs: implicit consent, bypassing both auto-detection and a persisted `never` for this run. */
  dirs?: SkillsDir[];
  /** Base directory for auto-detecting installed agent tools (tests inject a tmp home). */
  home?: string;
  prompt?: () => Promise<SkillInstallChoice>;
  /** Override the stdin-TTY check (tests). When omitted, reads `process.stdin.isTTY`. */
  stdinIsTty?: boolean;
}

/** Decide whether (and where) to install bundled skills after a successful login.
 *
 * - Explicit target (`--target`/env, passed as `deps.dirs`): install there, no prompt, ignore a
 *   persisted `never`. The user named the destination, so consent is implied.
 * - Otherwise: honor a persisted `never`; then fan out to every agent tool detected on the machine
 *   (`autoInstallTargets`). Prompt in fully-interactive TTY mode; auto-consent in agent/piped mode.
 *   If no supported tool is present, install nothing and warn where we looked.
 *
 * The persisted answer lives in `~/.config/gusto/config.toml` so subsequent logins are
 * non-interactive. */
export async function maybeInstallSkillsAfterLogin(
  globals: GlobalFlags,
  sinks: StreamSinks,
  deps: SkillInstallDeps = {},
): Promise<AutoInstallResult[] | undefined> {
  if (deps.dirs !== undefined) {
    return installBundledSkillsInto(deps.dirs);
  }

  const cfg = await readConfig(deps.configPaths);
  let pref: SkillsAutoInstall = cfg.skills_auto_install ?? "ask";
  // Honor an explicit opt-out before anything else, so a user who set `never` is never nagged -
  // not even by the no-tool-detected warning below.
  if (pref === "never") return undefined;

  const dirs = autoInstallTargets(deps.home);
  if (dirs.length === 0) {
    // No agent tool on this machine. Installing to a hardcoded default is what caused the original
    // bug (skills landing where the driving tool never reads them); make the no-op legible instead.
    sinks.stderr.write(noToolDetectedWarning());
    return [];
  }

  if (pref === "ask") {
    // Prompt only when *both* sides of the conversation are interactive. Agent mode
    // (piped stdout) is the obvious case, but stdout-TTY-but-stdin-redirected
    // (`gusto auth login </dev/null` from a CI runner) would hang on `rl.question`
    // since EOF stdin neither resolves nor throws. Treat that as implicit consent.
    const stdinTty = deps.stdinIsTty ?? Boolean(process.stdin.isTTY);
    if (resolveOutputMode(globals) === "agent" || !stdinTty) {
      // Non-interactive: implicit consent. Don't persist - a future human run on the
      // same machine should still get the prompt.
      pref = "always";
    } else {
      pref = await (deps.prompt ?? (() => promptForSkillsAutoInstall(dirs, sinks)))();
      await writeConfig({ ...cfg, skills_auto_install: pref }, deps.configPaths);
    }
  }
  if (pref === "never") return undefined;
  return installBundledSkillsInto(dirs);
}

/** The `[Y/n]` prompt copy for the interactive first-run install. Tool-agnostic: it names the
 * skills and the detected target dirs rather than assuming Claude. Pure + exported so the copy is
 * unit-testable without driving readline. */
export function skillsInstallPromptText(dirs: SkillsDir[]): string {
  const names = listSkills()
    .map((s) => s.name)
    .join(", ");
  const targets = dirs.map((d) => d.path).join(", ");
  return `Install bundled Gusto skills (${names}) into detected agent tools (${targets})? [Y/n] `;
}

/** Warning shown when a login auto-install finds no supported agent tool. Self-documenting: it
 * lists the tools and the home dirs we probed (from the same registry detection uses, so it can't
 * drift) and points at the `--target`/env override and the explicit-install fallback. */
export function noToolDetectedWarning(): string {
  const rows = supportedToolHomeLabels()
    .map((t) => `  ${t.kind.padEnd(10)} ${t.label}`)
    .join("\n");
  return [
    "warning: signed in, but found no supported agent tool, so no skills were installed.",
    "Checked for these tools by their home directory:",
    rows,
    "To install anyway, re-run with --target <tool[,...]> or set GUSTO_SKILLS_TARGET,",
    "or run `gusto skill install --all` from your project directory.",
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
    // Resolve an explicit skills target (`--target` beats GUSTO_SKILLS_TARGET). A bad value is a
    // usage error, surfaced before we make the user sign in only to fail afterward.
    let targetDirs: SkillsDir[] | undefined;
    if (!opts.noSkills) {
      const raw = opts.target ?? process.env.GUSTO_SKILLS_TARGET;
      const spec = raw && raw.trim().length > 0 ? raw : undefined;
      if (spec !== undefined) {
        const resolved = resolveSkillTargets(spec);
        if (!resolved.ok) {
          return {
            ok: false,
            exitCode: ExitCode.Validation,
            error: {
              code: "invalid_skill_target",
              message: `Unknown --target value(s): ${resolved.invalid.join(", ")}. Valid: ${SKILL_TARGET_KINDS.join(", ")}, or all.`,
            },
          };
        }
        targetDirs = resolved.dirs;
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
      try {
        const skills = await doInstallSkills(globals, sinks, targetDirs ? { dirs: targetDirs } : {});
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
