import type { Command } from "commander";
import { createInterface } from "node:readline/promises";
import { fetchResource } from "../lib/api-context.ts";
import { TOKEN_STDIN_OPT } from "../lib/cli-options.ts";
import { type ConfigPaths, readConfig, type SkillsAutoInstall, writeConfig } from "../lib/config.ts";
import { type Environment, type GlobalFlags, readGlobalFlags } from "../lib/global-flags.ts";
import { toResult } from "../lib/handle-api-error.ts";
import { oauthHttp, resolveEnv } from "../lib/oauth/context.ts";
import { type SignInUrlEvent, type TokenInfo, companyUuidFromTokenInfo, login } from "../lib/oauth/login.ts";
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

export interface SkillInstallDeps {
  configPaths?: ConfigPaths;
  skillsDir?: SkillsDir;
  prompt?: () => Promise<SkillsAutoInstall>;
  /** Override the stdin-TTY check (tests). When omitted, reads `process.stdin.isTTY`. */
  stdinIsTty?: boolean;
}

/** Decide whether to install bundled skills after a successful login, prompting in TTY mode
 * if the user hasn't answered before and auto-installing in agent/piped mode (since that's
 * the case AINT-680 is fixing - an agent driving the CLI can't see a prompt). The persisted
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
export function parseAutoInstallAnswer(raw: string): SkillsAutoInstall {
  const norm = raw.trim().toLowerCase();
  return norm === "" || norm === "y" || norm === "yes" ? "always" : "never";
}

async function promptForSkillsAutoInstall(sinks: StreamSinks): Promise<SkillsAutoInstall> {
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

export function authLoginHandler(opts: { noBrowser?: boolean; noSkills?: boolean } = {}): CommandHandler {
  return async ({ globals, sinks }) => {
    let data: LoginData;
    try {
      const info = await login(resolveEnv(globals), {
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
        const skills = await maybeInstallSkillsAfterLogin(globals, sinks);
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
      const data = await performLogout(resolveStore(), resolveEnv(globals));
      return { ok: true, data };
    } catch (err) {
      return toResult(err);
    }
  };
}

export function authWhoamiHandler(opts: AuthOpts): CommandHandler {
  // Token resolution (session > env > --token-stdin) is handled by fetchResource.
  return async ({ globals }) => {
    const result = await fetchResource<TokenInfo>(globals, { tokenStdin: opts.tokenStdin }, () => "/v1/token_info");
    if (!result.ok) return result;

    const info = result.data;
    return {
      ok: true,
      data: { ...info, capabilities: summarizeGrantedScopes(parseScopes(info?.scope)) },
    };
  };
}
