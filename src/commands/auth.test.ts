import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { type ConfigPaths, readConfig, writeConfig } from "../lib/config.ts";
import type { GlobalFlags } from "../lib/global-flags.ts";
import { memoryStore } from "../lib/oauth/test-support.ts";
import type { SkillsDir } from "../lib/skills.ts";
import { TEST_CONTEXT as ctx, TEST_GLOBALS, captureSinks, stubGlobalFetch } from "../lib/test-support.ts";
import {
  authLoginHandler,
  authWhoamiHandler,
  buildSignInUrlEmitter,
  loginResultData,
  maybeInstallSkillsAfterLogin,
  parseAutoInstallAnswer,
  performLogout,
} from "./auth.ts";

// whoami's token resolution (session > env > --token-stdin) is delegated to
// fetchResource and covered by api-context.test.ts; the cases below cover the
// capabilities summary it layers on top. (AINT-588 dropped the --token override.)

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

  // Auto-on agent mode (piped stdout) is what makes the AINT-644 event reachable
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
  let skillsDir: SkillsDir;

  beforeEach(() => {
    scratch = mkdtempSync(path.join(tmpdir(), "gusto-cli-auth-skills-"));
    configPaths = { dir: path.join(scratch, "config"), file: path.join(scratch, "config", "config.toml") };
    skillsDir = { path: path.join(scratch, "skills"), kind: "claude", scope: "global" };
  });

  afterEach(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  test("skips entirely when persisted preference is 'never'", async () => {
    await writeConfig({ skills_auto_install: "never" }, configPaths);
    const { sinks } = captureSinks();
    const result = await maybeInstallSkillsAfterLogin(human, sinks, { configPaths, skillsDir });
    expect(result).toBeUndefined();
  });

  test("auto-installs without prompting when persisted preference is 'always'", async () => {
    await writeConfig({ skills_auto_install: "always" }, configPaths);
    const { sinks } = captureSinks();
    const result = await maybeInstallSkillsAfterLogin(human, sinks, {
      configPaths,
      skillsDir,
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
      skillsDir,
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
      skillsDir,
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
      skillsDir,
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
      skillsDir,
      stdinIsTty: false,
      prompt: async () => {
        throw new Error("prompt should not be called when stdin is not a TTY");
      },
    });
    expect(result).toBeDefined();
    expect(result!.length).toBeGreaterThan(0);
    expect((await readConfig(configPaths)).skills_auto_install).toBeUndefined();
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

  test("propagates a token_info error and skips the capabilities summary", async () => {
    restore = stubGlobalFetch([{ status: 401, body: { error: "invalid_token" } }]).restore;
    const result = await authWhoamiHandler({})(ctx);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.code).toBe("api_client_error");
    expect("data" in result).toBe(false);
  });
});
