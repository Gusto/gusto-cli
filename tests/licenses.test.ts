import { describe, expect, test } from "bun:test";
import { isAllowed, isPackageRoot, licenseOf } from "../scripts/licenses.ts";

describe("licenseOf", () => {
  test("reads a plain SPDX string", () => {
    expect(licenseOf({ license: "MIT" })).toBe("MIT");
  });

  test("reads the deprecated { type } object form", () => {
    expect(licenseOf({ license: { type: "BSD-3-Clause" } })).toBe("BSD-3-Clause");
  });

  test("joins the deprecated licenses[] array as an OR expression", () => {
    expect(licenseOf({ licenses: [{ type: "MIT" }, { type: "Apache-2.0" }] })).toBe("MIT OR Apache-2.0");
  });

  test("returns UNKNOWN when no license field is present", () => {
    expect(licenseOf({ name: "x" })).toBe("UNKNOWN");
  });

  test("returns UNKNOWN for an empty object license", () => {
    expect(licenseOf({ license: {} })).toBe("UNKNOWN");
  });
});

describe("isAllowed", () => {
  test("accepts allowlisted licenses regardless of case", () => {
    expect(isAllowed("MIT")).toBe(true);
    expect(isAllowed("apache-2.0")).toBe(true);
    expect(isAllowed("BlueOak-1.0.0")).toBe(true);
  });

  test("rejects copyleft licenses", () => {
    expect(isAllowed("GPL-3.0-only")).toBe(false);
    expect(isAllowed("LGPL-2.1")).toBe(false);
    expect(isAllowed("MPL-2.0")).toBe(false);
  });

  test("OR passes when any operand is allowed", () => {
    expect(isAllowed("(GPL-2.0-only OR MIT)")).toBe(true);
    expect(isAllowed("GPL-2.0-only OR LGPL-3.0")).toBe(false);
  });

  test("AND passes only when every operand is allowed", () => {
    expect(isAllowed("MIT AND Apache-2.0")).toBe(true);
    expect(isAllowed("MIT AND GPL-3.0-only")).toBe(false);
  });

  test("strips parentheses and a trailing + from the version", () => {
    expect(isAllowed("(MIT)")).toBe(true);
    expect(isAllowed("Apache-2.0+")).toBe(true);
  });

  test("rejects unknown, unlicensed, and non-SPDX strings", () => {
    expect(isAllowed("UNKNOWN")).toBe(false);
    expect(isAllowed("UNLICENSED")).toBe(false);
    expect(isAllowed("SEE LICENSE IN COPYING")).toBe(false);
    expect(isAllowed("")).toBe(false);
  });
});

describe("isPackageRoot", () => {
  test("accepts an unscoped package manifest", () => {
    expect(isPackageRoot("node_modules/commander/package.json")).toBe(true);
  });

  test("accepts a scoped package manifest", () => {
    expect(isPackageRoot("node_modules/@eslint/js/package.json")).toBe(true);
  });

  test("accepts a nested (non-hoisted) dependency manifest", () => {
    expect(isPackageRoot("node_modules/a/node_modules/b/package.json")).toBe(true);
  });

  test("rejects a sub-manifest inside a package", () => {
    expect(isPackageRoot("node_modules/foo/dist/package.json")).toBe(false);
  });
});
