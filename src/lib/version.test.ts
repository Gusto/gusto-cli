import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import pkg from "../../package.json" with { type: "json" };
import { USER_AGENT, VERSION } from "./version.ts";

describe("VERSION", () => {
  test("is the package.json version commander prints for --version", () => {
    expect(VERSION).toBe(pkg.version);
  });

  test("is a bare semver with no leading v or build metadata", () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/);
  });

  test("matches the version in the README status", () => {
    const readme = readFileSync(new URL("../../README.md", import.meta.url), "utf8");
    const statusLine = readme.match(/^> \*\*Status: v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\.\*\*/m);

    expect(statusLine).not.toBeNull();
    expect(statusLine![1]).toBe(pkg.version);
  });
});

describe("USER_AGENT", () => {
  // Pinned deliberately: this string is what version-adoption queries group on, so a
  // change to the grammar (extra field, reordered parts, free text) has to break a test
  // and get noticed rather than silently splitting one release into two buckets.
  test("matches the documented gusto-cli/<version> (<os>-<arch>) grammar", () => {
    expect(USER_AGENT).toMatch(/^gusto-cli\/\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)? \([A-Za-z0-9._-]+-[A-Za-z0-9._-]+\)$/);
  });

  test("carries exactly the version --version reports", () => {
    // Asserted on the parsed token, not via substring: `includes("0.1.0")` would also pass
    // for a UA of `gusto-cli/10.1.0`, so it wouldn't actually pin the two together.
    const product = USER_AGENT.split(" ")[0];
    expect(product).toBe(`gusto-cli/${VERSION}`);
  });

  test("reports the running platform and arch, matching release artifact naming", () => {
    expect(USER_AGENT).toContain(`(${process.platform}-${process.arch})`);
  });

  test("contains no header-injecting or grammar-breaking characters", () => {
    expect(USER_AGENT).not.toMatch(/[\r\n]/);
    // One space total - the separator before the platform comment.
    expect(USER_AGENT.split(" ")).toHaveLength(2);
  });
});
