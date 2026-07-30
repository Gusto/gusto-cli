import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  type ConfigPaths,
  getOrCreateInstallId,
  normalizeValue,
  readConfig,
  resetConfig,
  resolveInstallIdHeader,
  validateKey,
  validateValue,
  writeConfig,
} from "./config.ts";

let scratch: string;
let paths: ConfigPaths;

beforeEach(() => {
  scratch = mkdtempSync(path.join(tmpdir(), "gusto-cli-config-"));
  paths = { dir: scratch, file: path.join(scratch, "config.toml") };
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe("validateKey", () => {
  test("accepts known keys", () => {
    expect(validateKey("environment")).toBe("environment");
    expect(validateKey("format")).toBe("format");
    expect(validateKey("skills_auto_install")).toBe("skills_auto_install");
  });
  test("rejects unknown keys", () => {
    expect(validateKey("token")).toBeNull();
    expect(validateKey("")).toBeNull();
  });
});

describe("validateValue", () => {
  test("environment must be sandbox or production", () => {
    expect(validateValue("environment", "sandbox")).toBeNull();
    expect(validateValue("environment", "production")).toBeNull();
    expect(validateValue("environment", "staging")).not.toBeNull();
  });
  test("format accepts agent, human, and the json alias", () => {
    expect(validateValue("format", "agent")).toBeNull();
    expect(validateValue("format", "human")).toBeNull();
    expect(validateValue("format", "json")).toBeNull();
  });
  test("format rejects genuinely invalid values", () => {
    expect(validateValue("format", "bogus")).not.toBeNull();
  });
  test("format error message lists every accepted value including the json alias", () => {
    const msg = validateValue("format", "bogus");
    expect(msg).toContain("agent");
    expect(msg).toContain("human");
    expect(msg).toContain("json");
  });
  test("format rejects Object prototype property names", () => {
    expect(validateValue("format", "toString")).not.toBeNull();
    expect(validateValue("format", "constructor")).not.toBeNull();
    expect(validateValue("format", "hasOwnProperty")).not.toBeNull();
  });
});

describe("normalizeValue", () => {
  test("normalizes the json format alias to agent", () => {
    expect(normalizeValue("format", "json")).toBe("agent");
  });
  test("leaves agent and human untouched", () => {
    expect(normalizeValue("format", "agent")).toBe("agent");
    expect(normalizeValue("format", "human")).toBe("human");
  });
  test("leaves environment values untouched", () => {
    expect(normalizeValue("environment", "sandbox")).toBe("sandbox");
  });
  test("does not treat Object prototype property names as the json alias", () => {
    expect(normalizeValue("format", "toString")).toBe("toString");
  });
  test("skills_auto_install must be ask, always, or never", () => {
    expect(validateValue("skills_auto_install", "ask")).toBeNull();
    expect(validateValue("skills_auto_install", "always")).toBeNull();
    expect(validateValue("skills_auto_install", "never")).toBeNull();
    expect(validateValue("skills_auto_install", "sometimes")).not.toBeNull();
  });
});

describe("read/write/reset", () => {
  test("readConfig returns empty object when file is absent", async () => {
    expect(await readConfig(paths)).toEqual({});
  });

  test("writeConfig + readConfig round-trip", async () => {
    await writeConfig({ environment: "sandbox", format: "agent" }, paths);
    expect(await readConfig(paths)).toEqual({ environment: "sandbox", format: "agent" });
  });

  test("skills_auto_install round-trips and rejects invalid values from disk", async () => {
    await writeConfig({ skills_auto_install: "always" }, paths);
    expect(await readConfig(paths)).toEqual({ skills_auto_install: "always" });
    await Bun.write(paths.file, `skills_auto_install = "sometimes"\n`);
    expect(await readConfig(paths)).toEqual({});
  });

  test("readConfig ignores unknown keys + invalid values", async () => {
    await Bun.write(paths.file, `environment = "staging"\nformat = "agent"\nrogue = "nope"\n`);
    expect(await readConfig(paths)).toEqual({ format: "agent" });
  });

  test("readConfig throws an actionable error naming the file on malformed TOML", async () => {
    await Bun.write(paths.file, `environment = "sandbox\nformat =`);
    expect(readConfig(paths)).rejects.toThrow(/is not valid TOML.*gusto config reset/s);
    expect(readConfig(paths)).rejects.toThrow(paths.file);
  });

  test("writeConfig creates the directory if missing", async () => {
    const nested = { dir: path.join(scratch, "nested"), file: path.join(scratch, "nested", "config.toml") };
    await writeConfig({ environment: "sandbox" }, nested);
    expect(await readConfig(nested)).toEqual({ environment: "sandbox" });
  });

  test("resetConfig removes the file", async () => {
    await writeConfig({ environment: "sandbox" }, paths);
    expect(await readConfig(paths)).toEqual({ environment: "sandbox" });
    await resetConfig(paths);
    expect(await readConfig(paths)).toEqual({});
  });

  test("resetConfig on a missing file is a no-op", async () => {
    await resetConfig(paths);
    expect(await readConfig(paths)).toEqual({});
  });
});

describe("getOrCreateInstallId", () => {
  test("generates a v4-shaped UUID on first call and persists it", async () => {
    const id = await getOrCreateInstallId(paths);
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(await readConfig(paths)).toEqual({ install_id: id });
  });

  test("second call returns the same value without rewriting", async () => {
    const first = await getOrCreateInstallId(paths);
    const second = await getOrCreateInstallId(paths);
    expect(second).toBe(first);
  });

  test("preserves other config keys when generating", async () => {
    await writeConfig({ environment: "sandbox", format: "human" }, paths);
    const id = await getOrCreateInstallId(paths);
    expect(await readConfig(paths)).toEqual({ environment: "sandbox", format: "human", install_id: id });
  });

  test("regenerates after resetConfig", async () => {
    const first = await getOrCreateInstallId(paths);
    await resetConfig(paths);
    const second = await getOrCreateInstallId(paths);
    expect(second).not.toBe(first);
  });

  test("readConfig drops an empty-string install_id from disk", async () => {
    await Bun.write(paths.file, `install_id = ""\n`);
    expect(await readConfig(paths)).toEqual({});
  });

  test("readConfig drops a non-UUID install_id from disk", async () => {
    await Bun.write(paths.file, `install_id = "not-a-uuid"\nformat = "agent"\n`);
    // Invalid install_id is dropped; sibling valid keys are preserved.
    expect(await readConfig(paths)).toEqual({ format: "agent" });
  });

  test("corrupted install_id is regenerated on next getOrCreateInstallId", async () => {
    await Bun.write(paths.file, `install_id = "corrupted-value"\n`);
    const fresh = await getOrCreateInstallId(paths);
    expect(fresh).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect((await readConfig(paths)).install_id).toBe(fresh);
  });

  test("concurrent first-run calls each produce a valid install_id and the file converges to one", async () => {
    // Documented behavior: two racing callers can each generate + write their own UUID. The
    // file ends up with whichever wrote last, and any future caller sees that value. Formal
    // first-writer-wins would require a lock — accepted trade-off, since divergence is bounded
    // to one command per racing caller and self-heals on the next call.
    const [a, b] = await Promise.all([getOrCreateInstallId(paths), getOrCreateInstallId(paths)]);
    const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    expect(a).toMatch(uuidPattern);
    expect(b).toMatch(uuidPattern);
    const settled = await getOrCreateInstallId(paths);
    expect([a, b]).toContain(settled);
  });

  test("writeConfig cleans up its temp file on rename failure", async () => {
    // A file at paths.dir makes mkdir fail with ENOTDIR AND rename fail. Verify writeConfig
    // throws (propagated to caller) and doesn't leave a .tmp behind under the parent scratch dir.
    const badDir = path.join(scratch, "not-a-dir");
    await Bun.write(badDir, "");
    const broken: ConfigPaths = { dir: badDir, file: path.join(badDir, "config.toml") };
    await expect(writeConfig({ install_id: "x" }, broken)).rejects.toThrow();
    const { readdirSync } = await import("node:fs");
    // No `.tmp` sibling under scratch either — the write couldn't proceed past mkdir.
    for (const entry of readdirSync(scratch)) {
      expect(entry.endsWith(".tmp")).toBe(false);
    }
  });
});

describe("resolveInstallIdHeader", () => {
  test("returns a UUID when telemetry is enabled and the config path is writable", async () => {
    const id = await resolveInstallIdHeader(paths);
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  test("returns undefined without side-effects when GUSTO_TELEMETRY=0", async () => {
    const prev = process.env.GUSTO_TELEMETRY;
    process.env.GUSTO_TELEMETRY = "0";
    try {
      expect(await resolveInstallIdHeader(paths)).toBeUndefined();
      // No config file should have been written under opt-out.
      expect(await readConfig(paths)).toEqual({});
    } finally {
      if (prev === undefined) delete process.env.GUSTO_TELEMETRY;
      else process.env.GUSTO_TELEMETRY = prev;
    }
  });

  test("returns undefined (fail-open) when the config path is unwritable", async () => {
    // A regular file where the config dir should be: mkdir hits ENOTDIR, getOrCreateInstallId
    // throws, resolveInstallIdHeader must catch and silently degrade telemetry.
    const badDir = path.join(scratch, "config-blocked");
    await Bun.write(badDir, "");
    const broken: ConfigPaths = { dir: badDir, file: path.join(badDir, "config.toml") };
    expect(await resolveInstallIdHeader(broken)).toBeUndefined();
  });
});
