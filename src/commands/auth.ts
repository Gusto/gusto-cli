import type { Command } from "commander";
import { createInterface } from "node:readline/promises";
import { type StdinReader, type TokenSource, fetchAtPath, resolveApiContext } from "../lib/api-context.ts";
import { TOKEN_STDIN_OPT } from "../lib/cli-options.ts";
import { type ConfigPaths, readConfig, type SkillsAutoInstall, writeConfig } from "../lib/config.ts";
import { defaultEnv, getAccessToken } from "../lib/env.ts";
import { type Environment, type GlobalFlags, readGlobalFlags } from "../lib/global-flags.ts";
import { toResult } from "../lib/handle-api-error.ts";
import { oauthHttp } from "../lib/oauth/context.ts";
import { type SignInUrlEvent, type TokenInfo, companyUuidFromTokenInfo, login } from "../lib/oauth/login.ts";
import { findMissingScopes } from "../lib/oauth/required-scopes.ts";
import { parseScopes, summarizeGrantedScopes } from "../lib/oauth/scopes.ts";
import { type StreamSinks, resolveOutputMode } from "../lib/output.ts";
import { type TokenStore, resolveStore } from "../lib/oauth/token-store.ts";
import { type AutoInstallResult, type SkillsDir, installBundledSkills, listSkills } from "../lib/skills.ts";
import { type CommandHandler, runCommand, runReadCommand } from "../lib/runner.ts";

interface AuthOpts {
  tokenStdin?: boolean;
}

// commander negatable flags: `--no-browser` sets `browser: false` (default true);
// `--no-skills` sets `skills: false` (default true).
interface LoginOpts {
  browser?: boolean;
  skills?: boolean;
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
    .action((opts: LoginOpts) =>
      runCommand(
        "gusto auth login",
        readGlobalFlags(parent.opts()),
        authLoginHandler({ noBrowser: opts.browser === false, noSkills: opts.skills === false }),
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
  skillsDir?: SkillsDir;
  prompt?: () => Promise<SkillInstallChoice>;
  /** Override the stdin-TTY check (tests). When omitted, reads `process.stdin.isTTY`. */
  stdinIsTty?: boolean;
}

/** Decide whether to install bundled skills after a successful login, prompting in TTY mode
 * if the user hasn't answered before and auto-installing in agent/piped mode (an agent
 * driving the CLI can't see a prompt). The persisted
 * answer lives in `~/.config/gusto/config.toml` so subsequent logins are non-interactive. */
export async function maybeInstallSkillsAfterLogin(
  globals: GlobalFlags,
  sinks: StreamSinks,
  deps: SkillInstallDeps = {},
): Promise<AutoInstallResult[] | undefined> {
  const cfg = await readConfig(deps.configPaths);
  let pref: SkillsAutoInstall = cfg.skills_auto_install ?? "ask";
  if (pref === "never") return undefined;
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
      pref = await (deps.prompt ?? (() => promptForSkillsAutoInstall(sinks)))();
      await writeConfig({ ...cfg, skills_auto_install: pref }, deps.configPaths);
    }
  }
  if (pref === "never") return undefined;
  return installBundledSkills(deps.skillsDir);
}

/** Map a raw answer to the `[Y/n]` prompt to a persisted preference. Empty / y / yes
 * (case-insensitive, trimmed) opt in; anything else opts out. Extracted so the boundary
 * cases (Y, YES, whitespace, "no", garbage) are unit-testable without driving readline. */
export function parseAutoInstallAnswer(raw: string): SkillInstallChoice {
  const norm = raw.trim().toLowerCase();
  return norm === "" || norm === "y" || norm === "yes" ? "always" : "never";
}

async function promptForSkillsAutoInstall(sinks: StreamSinks): Promise<SkillInstallChoice> {
  const names = listSkills()
    .map((s) => s.name)
    .join(", ");
  const rl = createInterface({ input: process.stdin, output: sinks.stderr });
  try {
    const raw = await rl.question(
      `Install bundled Gusto skills (${names}) to ~/.claude/skills for Claude Code? [Y/n] `,
    );
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
  opts: { noBrowser?: boolean; noSkills?: boolean } = {},
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
        const skills = await doInstallSkills(globals, sinks);
        if (skills) data.skills_installed = skills;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        sinks.stderr.write(`warning: signed in but skipped bundled skill install: ${message}\n`);
      }
    }
    return { ok: true, data };
  };
}

function authLogoutHandler(): CommandHandler {
  return async ({ globals }) => {
    try {
      const data = await performLogout(resolveStore(), defaultEnv(globals.env));
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
