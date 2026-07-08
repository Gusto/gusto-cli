import { describe, expect, test } from "bun:test";
import { kvLines, table } from "./human.ts";

describe("kvLines", () => {
  test("aligns values to the widest key with a two-space gutter", () => {
    expect(
      kvLines([
        ["Name", "Acme"],
        ["Tier", "plus"],
      ]),
    ).toBe("Name  Acme\nTier  plus");
  });

  test("drops pairs whose value is null or undefined", () => {
    expect(
      kvLines([
        ["Name", "Acme"],
        ["EIN", null],
        ["Entity", undefined],
      ]),
    ).toBe("Name  Acme");
  });

  test("widens the gutter only against the keys that are actually shown", () => {
    // "Entity type" is dropped, so alignment is computed from "Name" alone.
    expect(
      kvLines([
        ["Name", "Acme"],
        ["Entity type", null],
      ]),
    ).toBe("Name  Acme");
  });

  test("returns an empty string when every value is missing", () => {
    expect(
      kvLines([
        ["Name", null],
        ["EIN", undefined],
      ]),
    ).toBe("");
  });
});

describe("table", () => {
  test("renders a header row and pads columns to their widest cell", () => {
    expect(
      table(
        ["UUID", "Frequency"],
        [
          ["ps-1", "every_other_week"],
          ["ps-2", "monthly"],
        ],
      ),
    ).toBe(["UUID  Frequency", "ps-1  every_other_week", "ps-2  monthly"].join("\n"));
  });

  test("renders null/undefined cells as blanks and trims trailing space", () => {
    expect(table(["UUID", "Anchor"], [["ps-1", null]])).toBe("UUID  Anchor\nps-1");
  });

  test("returns an empty string when there are no rows", () => {
    expect(table(["UUID", "Frequency"], [])).toBe("");
  });
});
