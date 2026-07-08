import { describe, expect, test } from "bun:test";
import { readString } from "./read-string.ts";

describe("readString", () => {
  test("returns the value for a present non-empty string field", () => {
    expect(readString({ uuid: "ctr-1" }, "uuid")).toBe("ctr-1");
  });

  test("returns undefined for a missing field", () => {
    expect(readString({ other: "x" }, "uuid")).toBeUndefined();
  });

  test("returns undefined for an empty string", () => {
    expect(readString({ uuid: "" }, "uuid")).toBeUndefined();
  });

  test("returns undefined when the field isn't a string", () => {
    expect(readString({ uuid: 12345 }, "uuid")).toBeUndefined();
  });

  test("returns undefined for non-object bodies (null, array, string)", () => {
    expect(readString(null, "uuid")).toBeUndefined();
    expect(readString([{ uuid: "ctr-1" }], "uuid")).toBeUndefined();
    expect(readString("ctr-1", "uuid")).toBeUndefined();
  });
});
