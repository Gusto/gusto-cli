import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { type ConfigPaths, readConfig, writeConfig } from "../lib/config.ts";
import { ExitCode } from "../lib/exit-codes.ts";
import type { Environment, GlobalFlags } from "../lib/global-flags.ts";
import { memoryStore } from "../lib/oauth/test-support.ts";
import type { TokenStore } from "../lib/oauth/token-store.ts";
import { REQUIRED_SCOPES } from "../lib/oauth/required-scopes.ts";
import { TEST_CONTEXT as ctx, TEST_GLOBALS, captureSinks, stubGlobalFetch } from "../lib/test-support.ts";
import {
  CREDENTIAL_SOURCE_LABEL,
  type SkillInstallDeps,
  authLoginHandler,
  authLogoutHandler,
  authWhoamiHandler,
  buildSignInUrlEmitter,
  loginResultData,
  maybeInstallSkillsAfterLogin,
  noToolDetectedWarning,
  parseAutoInstallAnswer,
  performLogout,
  skillsInstallPromptText,
} from "./auth.ts";

// whoami's token resolution (explicit token first: --token-stdin > env > session)
// is covered by api-context.test.ts; the cases below cover the capabilities
// summary and credential-source label it layers on top.

describe("loginResultData", () => {
  test("maps token_info to identity + company_uuid + scope", () => {
    expect(
      loginResultData({
        scope: "public",
        resource: { type: "Company", uuid: "co-1" },
        resource_owner: { type: "CompanyAdmin", uuid: "u-1" },
      }),
    ).toEqual({ identity: { type: "CompanyAdmin", uuid: "u-1" }, company_uuid: "co-1", scope: "public" });
  });

  test("company_uuid is null when the token is not company-scoped", () => {
    expect(
      loginResultData({
        resource: { type: "Employee", uuid: "e-1" },
        resource_owner: { type: "Employee", uuid: "e-1" },
      }).company_uuid,
    ).toBeNull();
  });

  test("throws when token_info carries no identity", () => {
    expect(() => loginResultData({ resource: { type: "Company", uuid: "co-1" } })).toThrow(/no identity/);
  });
});

describe("performLogout", () => {
  test("no stored session -> cleared:false", async () => {
    expect(await performLogout(memoryStore(), "sandbox")).toEqual({ cleared: false });
  });

  test("clears the stored session and reports cleared:true", async () => {
    const store = memoryStore({ sandbox: { clientId: "c", clientSecret: "s", accessToken: "at" } });
    expect(await performLogout(store, "sandbox")).toEqual({ cleared: true });
    expect(store.data.sandbox).toBeUndefined();
  });
});

describe("buildSignInUrlEmitter", () => {
  const human: GlobalFlags = { ...TEST_GLOBALS, agent: false, human: true, json: false };

  test("returns undefined in human mode", () => {
    const { sinks } = captureSinks();
    expect(buildSignInUrlEmitter(human, sinks)).toBeUndefined();
  });

  test("explicit --agent writes a newline-terminated JSON line to stdout", () => {
    const { sinks, stdout } = captureSinks();
    const emit = buildSignInUrlEmitter({ ...human, agent: true, human: false }, sinks);
    expect(emit).toBeDefined();
    emit?.({ event: "sign_in_url", sign_in_url: "https://auth.test/x", state: "s1" });
    expect(stdout.buffer).toBe(
      `${JSON.stringify({ event: "sign_in_url", sign_in_url: "https://auth.test/x", state: "s1" })}\n`,
    );
  });

  // Auto-on agent mode (piped stdout) is what makes the event reachable
  // for harnesses that don't pass --agent explicitly. The flags carry agent=false
  // and human=false; resolveOutputMode reads the TTY to decide. Stub the TTY check
  // via the writable stream to assert the resolver routes piped runs to agent mode.
  test("piped stdout (auto-on agent mode) still emits", () => {
    const { sinks, stdout } = captureSinks();
    // Simulate the runner's resolveOutputMode by passing flags that leave the
    // decision to TTY-detection and stubbing process.stdout.isTTY = false.
    const originalIsTTY = process.stdout.isTTY;
    try {
      Object.defineProperty(process.stdout, "isTTY", { value: false, configurable: true });
      const piped: GlobalFlags = { ...TEST_GLOBALS, agent: false, human: false, json: false };
      const emit = buildSignInUrlEmitter(piped, sinks);
      expect(emit).toBeDefined();
      emit?.({ event: "sign_in_url", sign_in_url: "https://auth.test/y", state: "s2" });
      expect(stdout.buffer).toContain('"sign_in_url"');
    } finally {
      Object.defineProperty(process.stdout, "isTTY", { value: originalIsTTY, configurable: true });
    }
  });
});

describe("parseAutoInstallAnswer", () => {
  test("empty input (just hitting Enter on the default) opts in", () => {
    expect(parseAutoInstallAnswer("")).toBe("always");
    expect(parseAutoInstallAnswer("   ")).toBe("always");
    expect(parseAutoInstallAnswer("\n")).toBe("always");
  });

  test("y / yes opt in regardless of case", () => {
    expect(parseAutoInstallAnswer("y")).toBe("always");
    expect(parseAutoInstallAnswer("Y")).toBe("always");
    expect(parseAutoInstallAnswer("yes")).toBe("always");
    expect(parseAutoInstallAnswer("YES")).toBe("always");
    expect(parseAutoInstallAnswer("  Yes  ")).toBe("always");
  });

  test("anything else opts out", () => {
    expect(parseAutoInstallAnswer("n")).toBe("never");
    expect(parseAutoInstallAnswer("NO")).toBe("never");
    expect(parseAutoInstallAnswer("nope")).toBe("never");
    expect(parseAutoInstallAnswer("yes please")).toBe("never");
    expect(parseAutoInstallAnswer("garbage")).toBe("never");
  });
});

describe("maybeInstallSkillsAfterLogin", () => {
  const human: GlobalFlags = { ...TEST_GLOBALS, agent: false, human: true, json: false };
  const agent: GlobalFlags = { ...TEST_GLOBALS, agent: true, human: false, json: true };
  let scratch: string;
  let configPaths: ConfigPaths;
  let home: string;

  beforeEach(() => {
    scratch = mkdtempSync(path.join(tmpdir(), "gusto-cli-auth-skills-"));
    configPaths = { dir: path.join(scratch, "config"), file: path.join(scratch, "config", "config.toml") };
    home = path.join(scratch, "home");
    // A detectable Claude install so the auto-detect fan-out has a target to install into.
    mkdirSync(path.join(home, ".claude"), { recursive: true });
  });

  afterEach(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  test("skips entirely when persisted preference is 'never'", async () => {
    await writeConfig({ skills_auto_install: "never" }, configPaths);
    const { sinks } = captureSinks();
    const result = await maybeInstallSkillsAfterLogin(human, sinks, { configPaths, home });
    expect(result).toBeUndefined();
  });

  test("auto-installs without prompting when persisted preference is 'always'", async () => {
    await writeConfig({ skills_auto_install: "always" }, configPaths);
    const { sinks } = captureSinks();
    const result = await maybeInstallSkillsAfterLogin(human, sinks, {
      configPaths,
      home,
      prompt: async () => {
        throw new Error("prompt should not be called when preference is persisted");
      },
    });
    expect(result).toBeDefined();
    expect(result!.length).toBeGreaterThan(0);
  });

  test("prompts on first run in TTY mode and persists the answer", async () => {
    const { sinks } = captureSinks();
    const result = await maybeInstallSkillsAfterLogin(human, sinks, {
      configPaths,
      home,
      stdinIsTty: true,
      prompt: async () => "always",
    });
    expect(result).toBeDefined();
    expect((await readConfig(configPaths)).skills_auto_install).toBe("always");
  });

  test("persists 'never' when the user declines the prompt", async () => {
    const { sinks } = captureSinks();
    const result = await maybeInstallSkillsAfterLogin(human, sinks, {
      configPaths,
      home,
      stdinIsTty: true,
      prompt: async () => "never",
    });
    expect(result).toBeUndefined();
    expect((await readConfig(configPaths)).skills_auto_install).toBe("never");
  });

  test("auto-installs in agent mode without prompting or persisting", async () => {
    const { sinks } = captureSinks();
    const result = await maybeInstallSkillsAfterLogin(agent, sinks, {
      configPaths,
      home,
      stdinIsTty: true,
      prompt: async () => {
        throw new Error("prompt should not be called in agent mode");
      },
    });
    expect(result).toBeDefined();
    expect(result!.length).toBeGreaterThan(0);
    // Future TTY run on the same machine should still see the prompt.
    expect((await readConfig(configPaths)).skills_auto_install).toBeUndefined();
  });

  // Regression: stdout TTY + stdin redirected (e.g. `gusto auth login </dev/null`
  // from a CI runner) would previously enter the prompt path and hang on EOF stdin
  // since `rl.question()` neither resolves nor throws. Treat it as implicit consent.
  test("falls back to implicit-consent when stdin is not a TTY even if stdout is", async () => {
    const { sinks } = captureSinks();
    const result = await maybeInstallSkillsAfterLogin(human, sinks, {
      configPaths,
      home,
      stdinIsTty: false,
      prompt: async () => {
        throw new Error("prompt should not be called when stdin is not a TTY");
      },
    });
    expect(result).toBeDefined();
    expect(result!.length).toBeGreaterThan(0);
    expect((await readConfig(configPaths)).skills_auto_install).toBeUndefined();
  });

  test("fans out into every detected tool's global dir", async () => {
    mkdirSync(path.join(home, ".cursor"), { recursive: true });
    await writeConfig({ skills_auto_install: "always" }, configPaths);
    const { sinks } = captureSinks();
    const result = await maybeInstallSkillsAfterLogin(human, sinks, { configPaths, home });
    expect(result).toBeDefined();
    const kinds = new Set(result!.map((r) => r.kind));
    expect(kinds.has("claude")).toBe(true);
    expect(kinds.has("cursor")).toBe(true);
  });

  test("no supported tool detected: installs nothing and warns where it looked", async () => {
    const emptyHome = path.join(scratch, "empty-home");
    mkdirSync(emptyHome, { recursive: true });
    await writeConfig({ skills_auto_install: "always" }, configPaths);
    const { sinks, stderr } = captureSinks();
    const result = await maybeInstallSkillsAfterLogin(human, sinks, { configPaths, home: emptyHome });
    expect(result).toEqual([]);
    expect(stderr.buffer).toContain("no supported agent tool");
    expect(stderr.buffer).toContain("--target");
    expect(stderr.buffer).toContain("~/.claude");
  });

  test("'never' is honored over the no-detect warning (no nagging when the user opted out)", async () => {
    const emptyHome = path.join(scratch, "empty-home-2");
    mkdirSync(emptyHome, { recursive: true });
    await writeConfig({ skills_auto_install: "never" }, configPaths);
    const { sinks, stderr } = captureSinks();
    const result = await maybeInstallSkillsAfterLogin(human, sinks, { configPaths, home: emptyHome });
    expect(result).toBeUndefined();
    expect(stderr.buffer).toBe("");
  });

  test("an explicit --target flag (force) installs regardless of a persisted 'never', no prompt", async () => {
    await writeConfig({ skills_auto_install: "never" }, configPaths);
    const dirs = [
      { path: path.join(scratch, "forced", "cursor", "skills"), kind: "cursor" as const, scope: "global" as const },
    ];
    const { sinks } = captureSinks();
    const result = await maybeInstallSkillsAfterLogin(human, sinks, {
      configPaths,
      dirs,
      force: true,
      prompt: async () => {
        throw new Error("prompt should not be called for an explicit --target");
      },
    });
    expect(result).toBeDefined();
    expect(result!.every((r) => r.kind === "cursor")).toBe(true);
  });

  test("an ambient env target (no force) still honors a persisted 'never'", async () => {
    await writeConfig({ skills_auto_install: "never" }, configPaths);
    const dirs = [
      { path: path.join(scratch, "env", "cursor", "skills"), kind: "cursor" as const, scope: "global" as const },
    ];
    const { sinks } = captureSinks();
    const result = await maybeInstallSkillsAfterLogin(human, sinks, { configPaths, dirs });
    expect(result).toBeUndefined();
  });

  test("an env target (no force) installs into the given dirs when not opted out", async () => {
    await writeConfig({ skills_auto_install: "always" }, configPaths);
    const dirs = [
      { path: path.join(scratch, "env2", "cursor", "skills"), kind: "cursor" as const, scope: "global" as const },
    ];
    const { sinks } = captureSinks();
    const result = await maybeInstallSkillsAfterLogin(human, sinks, { configPaths, dirs });
    expect(result).toBeDefined();
    expect(result!.every((r) => r.kind === "cursor")).toBe(true);
  });

  test("surfaces a per-tool install failure as a warning but still reports the successes", async () => {
    const okDir = {
      path: path.join(scratch, "ok", ".claude", "skills"),
      kind: "claude" as const,
      scope: "global" as const,
    };
    const badRoot = path.join(scratch, "bad", ".cursor", "skills");
    mkdirSync(badRoot, { recursive: true });
    const elsewhere = path.join(scratch, "bad-elsewhere");
    mkdirSync(elsewhere, { recursive: true });
    symlinkSync(elsewhere, path.join(badRoot, "cash-forecasting"));
    const badDir = { path: badRoot, kind: "cursor" as const, scope: "global" as const };
    const { sinks, stderr } = captureSinks();
    const result = await maybeInstallSkillsAfterLogin(human, sinks, { dirs: [okDir, badDir], force: true });
    expect(result!.some((r) => r.kind === "claude")).toBe(true);
    expect(stderr.buffer).toContain("cursor");
    // The warning names the failed tool but does not claim other tools were "updated" - the
    // surviving results may be no-ops (already up to date), so that phrasing was inaccurate.
    expect(stderr.buffer).not.toContain("other tools were still updated");
  });

  test("a failing skill warns without falsely claiming other tools were updated", async () => {
    const badRoot = path.join(scratch, "lone", ".cursor", "skills");
    mkdirSync(badRoot, { recursive: true });
    const elsewhere = path.join(scratch, "lone-elsewhere");
    mkdirSync(elsewhere, { recursive: true });
    symlinkSync(elsewhere, path.join(badRoot, "cash-forecasting"));
    const badDir = { path: badRoot, kind: "cursor" as const, scope: "global" as const };
    const { sinks, stderr } = captureSinks();
    const result = await maybeInstallSkillsAfterLogin(human, sinks, { dirs: [badDir], force: true });
    // The escaping skill is reported; the other cursor skills still install (per-skill resilience).
    expect(result!.some((r) => r.skill === "cash-forecasting")).toBe(false);
    expect(stderr.buffer).toContain("cursor");
    expect(stderr.buffer).not.toContain("other tools were still updated");
  });

  test("emits a threaded env-target warning once consent is established", async () => {
    await writeConfig({ skills_auto_install: "always" }, configPaths);
    const { sinks, stderr } = captureSinks();
    await maybeInstallSkillsAfterLogin(human, sinks, {
      configPaths,
      home,
      warning: "ignoring invalid GUSTO_SKILLS_TARGET",
    });
    expect(stderr.buffer).toContain("ignoring invalid GUSTO_SKILLS_TARGET");
  });

  test("suppresses a threaded warning when the user opted out via 'never'", async () => {
    await writeConfig({ skills_auto_install: "never" }, configPaths);
    const { sinks, stderr } = captureSinks();
    const result = await maybeInstallSkillsAfterLogin(human, sinks, {
      configPaths,
      home,
      warning: "ignoring invalid GUSTO_SKILLS_TARGET",
    });
    expect(result).toBeUndefined();
    expect(stderr.buffer).toBe("");
  });
});

describe("skillsInstallPromptText", () => {
  test("is tool-agnostic and names the detected target dirs", () => {
    const text = skillsInstallPromptText([
      { path: "/h/.claude/skills", kind: "claude", scope: "global" },
      { path: "/h/.cursor/skills", kind: "cursor", scope: "global" },
    ]);
    expect(text).not.toContain("for Claude Code");
    // Not "detected": the dirs may come from an explicit env target, not detection (finding #4).
    expect(text).not.toContain("detected");
    expect(text).toContain("/h/.claude/skills");
    expect(text).toContain("/h/.cursor/skills");
    expect(text).toContain("[Y/n]");
  });
});

describe("noToolDetectedWarning", () => {
  test("names every supported tool's home marker and points at the escape hatches", () => {
    const text = noToolDetectedWarning();
    expect(text.toLowerCase()).toContain("no supported agent tool");
    expect(text).toContain("~/.claude");
    expect(text).toContain("~/.codeium");
    expect(text).toContain("--target");
    expect(text).toContain("GUSTO_SKILLS_TARGET");
    // Documents its own off-switch (finding #4) and drops the misleading `skill install --all`
    // advice that would re-land skills in ~/.claude (finding #6).
    expect(text).toContain("skills_auto_install never");
    expect(text).not.toContain("skill install --all");
  });
});

describe("authLoginHandler - --target / GUSTO_SKILLS_TARGET override", () => {
  const tokenInfo = {
    resource_owner: { type: "CompanyAdmin" as const, uuid: "u-1" },
    resource: { type: "Company" as const, uuid: "co-1" },
  };
  const fakeLogin = () => Promise.resolve(tokenInfo);

  test("an unknown --target value returns a Validation envelope and does not log in", async () => {
    const { sinks } = captureSinks();
    let loggedIn = false;
    const result = await authLoginHandler(
      { target: "cursor,emacs" },
      {
        login: () => {
          loggedIn = true;
          return Promise.resolve(tokenInfo);
        },
        installSkills: async () => undefined,
      },
    )({ ...ctx, sinks });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.exitCode).toBe(ExitCode.Validation);
    expect(result.error.message).toContain("emacs");
    expect(loggedIn).toBe(false);
  });

  const captureDeps = () => {
    let received: SkillInstallDeps | undefined;
    const installSkills = async (_g: GlobalFlags, _s: unknown, deps?: SkillInstallDeps) => {
      received = deps;
      return [{ skill: "cash-forecasting", installedAt: "/p", kind: "cursor" as const, action: "installed" as const }];
    };
    return { get: () => received, installSkills };
  };

  test("a valid --target flag is resolved to dirs and marked force (overrides opt-out)", async () => {
    const { sinks } = captureSinks();
    const cap = captureDeps();
    const result = await authLoginHandler(
      { target: "cursor" },
      { login: fakeLogin, installSkills: cap.installSkills },
    )({ ...ctx, sinks });
    expect(result.ok).toBe(true);
    expect(cap.get()?.dirs?.map((d) => d.kind)).toEqual(["cursor"]);
    expect(cap.get()?.force).toBe(true);
  });

  describe("GUSTO_SKILLS_TARGET env var", () => {
    let saved: string | undefined;
    beforeEach(() => {
      saved = process.env.GUSTO_SKILLS_TARGET;
    });
    afterEach(() => {
      if (saved === undefined) delete process.env.GUSTO_SKILLS_TARGET;
      else process.env.GUSTO_SKILLS_TARGET = saved;
    });

    test("resolves the target but does not force (env is ambient, not a per-run opt-in)", async () => {
      process.env.GUSTO_SKILLS_TARGET = "codex";
      const { sinks } = captureSinks();
      const cap = captureDeps();
      await authLoginHandler({}, { login: fakeLogin, installSkills: cap.installSkills })({ ...ctx, sinks });
      expect(cap.get()?.dirs?.map((d) => d.kind)).toEqual(["codex"]);
      expect(cap.get()?.force).toBeFalsy();
    });

    test("--target flag beats GUSTO_SKILLS_TARGET", async () => {
      process.env.GUSTO_SKILLS_TARGET = "codex";
      const { sinks } = captureSinks();
      const cap = captureDeps();
      await authLoginHandler(
        { target: "cursor" },
        { login: fakeLogin, installSkills: cap.installSkills },
      )({
        ...ctx,
        sinks,
      });
      expect(cap.get()?.dirs?.map((d) => d.kind)).toEqual(["cursor"]);
      expect(cap.get()?.force).toBe(true);
    });

    test("an empty --target does not shadow GUSTO_SKILLS_TARGET", async () => {
      process.env.GUSTO_SKILLS_TARGET = "codex";
      const { sinks } = captureSinks();
      const cap = captureDeps();
      await authLoginHandler(
        { target: "   " },
        { login: fakeLogin, installSkills: cap.installSkills },
      )({
        ...ctx,
        sinks,
      });
      expect(cap.get()?.dirs?.map((d) => d.kind)).toEqual(["codex"]);
    });

    test("an invalid ambient env value does NOT block login; it warns and falls back to auto-detect", async () => {
      process.env.GUSTO_SKILLS_TARGET = "emacs";
      const { sinks } = captureSinks();
      const cap = captureDeps();
      const result = await authLoginHandler(
        {},
        { login: fakeLogin, installSkills: cap.installSkills },
      )({
        ...ctx,
        sinks,
      });
      expect(result.ok).toBe(true);
      // The warning is threaded through deps so it can honor `never`; not emitted eagerly here.
      expect(cap.get()?.warning).toContain("GUSTO_SKILLS_TARGET");
      expect(cap.get()?.warning).toContain("emacs");
      expect(cap.get()?.dirs).toBeUndefined();
    });

    test("an invalid --target flag names --target (not the env var) in the error", async () => {
      process.env.GUSTO_SKILLS_TARGET = "codex";
      const { sinks } = captureSinks();
      const result = await authLoginHandler(
        { target: "emacs" },
        { login: fakeLogin, installSkills: async () => undefined },
      )({ ...ctx, sinks });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.error.message).toContain("--target");
      expect(result.error.message).toContain("emacs");
    });
  });
});

describe("authLoginHandler - skill-install failure must not negate a successful login", () => {
  const tokenInfo = {
    resource_owner: { type: "CompanyAdmin" as const, uuid: "u-1" },
    resource: { type: "Company" as const, uuid: "co-1" },
  };
  const fakeLogin = () => Promise.resolve(tokenInfo);

  test("an installSkills throw surfaces as a stderr warning, not an error envelope", async () => {
    const { sinks, stderr } = captureSinks();
    const result = await authLoginHandler(
      {},
      {
        login: fakeLogin,
        installSkills: async () => {
          throw new Error("EACCES: ~/.claude/skills is read-only");
        },
      },
    )({ ...ctx, sinks });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect((result.data as Record<string, unknown>).identity).toEqual(tokenInfo.resource_owner);
    expect(stderr.buffer.toLowerCase()).toContain("warning");
    expect(stderr.buffer).toContain("EACCES");
  });

  test("--no-skills skips the installer entirely (the throwing stub is never reached)", async () => {
    const { sinks, stderr } = captureSinks();
    const installSkills = async () => {
      throw new Error("installer should not run with --no-skills");
    };
    const result = await authLoginHandler({ noSkills: true }, { login: fakeLogin, installSkills })({ ...ctx, sinks });
    expect(result.ok).toBe(true);
    // env warning may fire from the ambient GUSTO_ACCESS_TOKEN in tests/preload.ts;
    // what matters here is that the installer didn't run, so its error message is absent.
    expect(stderr.buffer).not.toContain("installer should not run");
  });

  test("happy path: installSkills's results are attached to the login envelope", async () => {
    const { sinks } = captureSinks();
    const stubInstall = [
      {
        skill: "cash-forecasting",
        installedAt: "/p/cash-forecasting/SKILL.md",
        kind: "claude" as const,
        action: "installed" as const,
      },
    ];
    const result = await authLoginHandler(
      {},
      { login: fakeLogin, installSkills: async () => stubInstall },
    )({ ...ctx, sinks });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect((result.data as Record<string, unknown>).skills_installed).toEqual(stubInstall);
  });
});

describe("authLoginHandler - GUSTO_ACCESS_TOKEN override warning", () => {
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env.GUSTO_ACCESS_TOKEN;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.GUSTO_ACCESS_TOKEN;
    else process.env.GUSTO_ACCESS_TOKEN = saved;
  });

  const fakeLogin = () =>
    Promise.resolve({
      resource_owner: { type: "CompanyAdmin" as const, uuid: "u-1" },
      resource: { type: "Company" as const, uuid: "co-1" },
    });
  const skipSkills = async () => undefined;

  test("warns on stderr when GUSTO_ACCESS_TOKEN is set - login won't change the active identity", async () => {
    process.env.GUSTO_ACCESS_TOKEN = "env-tok";
    const { sinks, stderr } = captureSinks();
    const result = await authLoginHandler({}, { login: fakeLogin, installSkills: skipSkills })({ ...ctx, sinks });
    expect(result.ok).toBe(true);
    expect(stderr.buffer).toContain("GUSTO_ACCESS_TOKEN");
    expect(stderr.buffer.toLowerCase()).toContain("warning");
  });

  test("no warning when GUSTO_ACCESS_TOKEN is unset", async () => {
    delete process.env.GUSTO_ACCESS_TOKEN;
    const { sinks, stderr } = captureSinks();
    const result = await authLoginHandler({}, { login: fakeLogin, installSkills: skipSkills })({ ...ctx, sinks });
    expect(result.ok).toBe(true);
    expect(stderr.buffer).not.toContain("GUSTO_ACCESS_TOKEN");
  });
});

describe("authLoginHandler - environment passed to login", () => {
  const skipSkills = async () => undefined;
  const tokenInfo = {
    resource_owner: { type: "CompanyAdmin" as const, uuid: "u-1" },
    resource: { type: "Company" as const, uuid: "co-1" },
  };
  // Capture the env the handler hands to `login`, then run the handler with the
  // given --env flag. `undefined` is the no-flag case this PR's default flip turns on.
  const envFor = async (env: GlobalFlags["env"]): Promise<Environment> => {
    let seen: Environment | undefined;
    const captureLogin = (e: Environment) => {
      seen = e;
      return Promise.resolve(tokenInfo);
    };
    const { sinks } = captureSinks();
    await authLoginHandler(
      {},
      { login: captureLogin, installSkills: skipSkills },
    )({
      ...ctx,
      globals: { ...TEST_GLOBALS, env },
      sinks,
    });
    if (seen === undefined) throw new Error("login was not called");
    return seen;
  };

  test("defaults to production when no --env is passed", async () => {
    expect(await envFor(undefined)).toBe("production");
  });
  test("passes sandbox through when --env sandbox is explicit", async () => {
    expect(await envFor("sandbox")).toBe("sandbox");
  });
});

describe("authLogoutHandler - default env and stranded-session hint", () => {
  const session = { clientId: "c", clientSecret: "s", accessToken: "at" };
  const runLogout = async (store: TokenStore, env: GlobalFlags["env"]) => {
    const { sinks, stderr } = captureSinks();
    const result = await authLogoutHandler({ store })({ ...ctx, globals: { ...TEST_GLOBALS, env }, sinks });
    return { result, stderr };
  };

  test("no --env clears the production session by default", async () => {
    const store = memoryStore({ production: { ...session } });
    const { result, stderr } = await runLogout(store, undefined);
    expect(result.ok && result.data).toEqual({ cleared: true });
    expect(store.data.production).toBeUndefined();
    expect(stderr.buffer).toBe("");
  });

  test("warns when a sandbox session is stranded after a default (production) logout", async () => {
    const store = memoryStore({ sandbox: { ...session } });
    const { result, stderr } = await runLogout(store, undefined);
    expect(result.ok && result.data).toEqual({ cleared: false });
    expect(store.data.sandbox).toBeDefined();
    expect(stderr.buffer).toContain("gusto auth logout --env sandbox");
  });

  test("warns about a stranded production session when --env sandbox is explicit", async () => {
    const store = memoryStore({ production: { ...session } });
    const { result, stderr } = await runLogout(store, "sandbox");
    expect(result.ok && result.data).toEqual({ cleared: false });
    expect(stderr.buffer).toContain("gusto auth logout --env production");
  });

  test("still warns about the other env even when this env was cleared", async () => {
    const store = memoryStore({ production: { ...session }, sandbox: { ...session } });
    const { result, stderr } = await runLogout(store, undefined);
    expect(result.ok && result.data).toEqual({ cleared: true });
    expect(store.data.sandbox).toBeDefined();
    expect(stderr.buffer).toContain("gusto auth logout --env sandbox");
  });

  test("warns for any stored session under the other env, even without an access token", async () => {
    const store = memoryStore({ sandbox: { clientId: "c", clientSecret: "s" } });
    const { stderr } = await runLogout(store, undefined);
    expect(stderr.buffer).toContain("gusto auth logout --env sandbox");
  });

  test("a failed read of the other env doesn't fail the logout", async () => {
    const store: TokenStore = {
      load: async (e) => {
        if (e === "sandbox") throw new Error("corrupt session file");
        return null;
      },
      save: async () => {},
      clear: async () => {},
    };
    const { result, stderr } = await runLogout(store, undefined);
    expect(result.ok && result.data).toEqual({ cleared: false });
    expect(stderr.buffer).toBe("");
  });

  test("no hint when nothing is stored under either env", async () => {
    const { result, stderr } = await runLogout(memoryStore(), undefined);
    expect(result.ok && result.data).toEqual({ cleared: false });
    expect(stderr.buffer).toBe("");
  });
});

describe("authWhoamiHandler", () => {
  let restore: () => void = () => {};
  afterEach(() => restore());

  test("augments token_info with a capabilities summary derived from scope", async () => {
    const tokenInfo = {
      scope: "employees:read employees:write pay_schedules:read",
      resource_owner: { type: "CompanyAdmin", uuid: "u-1" },
      resource: { type: "Company", uuid: "co-1" },
    };
    restore = stubGlobalFetch([{ status: 200, body: tokenInfo }]).restore;
    const result = await authWhoamiHandler({})(ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    const data = result.data as Record<string, unknown>;
    const capabilities = data.capabilities as Array<{ resource: string; access: string[] }>;
    expect(capabilities).toContainEqual({ resource: "employees", access: ["read", "write"] });
    expect(capabilities).toContainEqual({ resource: "pay_schedules", access: ["read"] });
  });

  test("surfaces missing_scopes when the token's grant is narrower than the CLI surface needs", async () => {
    const tokenInfo = {
      scope: "companies:read public",
      resource_owner: { type: "CompanyAdmin", uuid: "u-1" },
    };
    restore = stubGlobalFetch([{ status: 200, body: tokenInfo }]).restore;
    const result = await authWhoamiHandler({})(ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    const { missing_scopes: missing } = result.data as { missing_scopes?: string[] };
    expect(Array.isArray(missing)).toBe(true);
    // A granted scope is never reported missing; a required-but-ungranted one is.
    expect(missing).not.toContain("companies:read");
    expect(missing).toContain("payrolls:write");
  });

  test("omits missing_scopes entirely when every required scope is granted", async () => {
    const tokenInfo = {
      scope: REQUIRED_SCOPES.map((r) => r.scope).join(" "),
      resource_owner: { type: "CompanyAdmin", uuid: "u-1" },
    };
    restore = stubGlobalFetch([{ status: 200, body: tokenInfo }]).restore;
    const result = await authWhoamiHandler({})(ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect((result.data as { missing_scopes?: string[] }).missing_scopes).toBeUndefined();
  });

  test("propagates a token_info error and skips the capabilities summary", async () => {
    restore = stubGlobalFetch([{ status: 401, body: { error: "invalid_token" } }]).restore;
    const result = await authWhoamiHandler({})(ctx);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.code).toBe("api_client_error");
    expect("data" in result).toBe(false);
  });

  test("labels the credential source - GUSTO_ACCESS_TOKEN wins via the ambient env token", async () => {
    // tests/preload.ts sets GUSTO_ACCESS_TOKEN, so with no session the env token
    // is the resolved source; whoami should say so.
    const tokenInfo = { scope: "public", resource_owner: { type: "CompanyAdmin", uuid: "u-1" } };
    restore = stubGlobalFetch([{ status: 200, body: tokenInfo }]).restore;
    const result = await authWhoamiHandler({})(ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect((result.data as Record<string, unknown>).credential_source).toBe("GUSTO_ACCESS_TOKEN");
  });

  test("labels --token-stdin as the credential source when a token is piped", async () => {
    const tokenInfo = { scope: "public", resource_owner: { type: "CompanyAdmin", uuid: "u-1" } };
    restore = stubGlobalFetch([{ status: 200, body: tokenInfo }]).restore;
    const result = await authWhoamiHandler({ tokenStdin: true }, () => Promise.resolve("piped-tok"))(ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect((result.data as Record<string, unknown>).credential_source).toBe("--token-stdin");
  });
});

// The `session` branch is hard to drive through whoami without standing up a real
// session file; the underlying concern (a label typo slipping through) is captured
// by asserting the const map directly. `Record<TokenSource, string>` enforces
// exhaustive keys at compile time; this pins the values.
describe("CREDENTIAL_SOURCE_LABEL", () => {
  test("each TokenSource maps to the expected user-facing label", () => {
    expect(CREDENTIAL_SOURCE_LABEL.stdin).toBe("--token-stdin");
    expect(CREDENTIAL_SOURCE_LABEL.env).toBe("GUSTO_ACCESS_TOKEN");
    expect(CREDENTIAL_SOURCE_LABEL.session).toBe("stored session");
  });
});
