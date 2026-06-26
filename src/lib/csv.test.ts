import { describe, expect, test } from "bun:test";
import { CsvError, parseCsv } from "./csv.ts";

describe("parseCsv", () => {
  test("parses a simple header + rows", () => {
    expect(parseCsv("a,b,c\n1,2,3\n4,5,6")).toEqual([
      ["a", "b", "c"],
      ["1", "2", "3"],
      ["4", "5", "6"],
    ]);
  });

  test("handles CRLF line endings", () => {
    expect(parseCsv("a,b\r\n1,2\r\n")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  test("does not emit a phantom row for a trailing newline", () => {
    expect(parseCsv("a\n1\n")).toEqual([["a"], ["1"]]);
  });

  test("flushes the final row when there is no trailing newline", () => {
    expect(parseCsv("a\n1")).toEqual([["a"], ["1"]]);
  });

  test("keeps empty cells", () => {
    expect(parseCsv("a,,c")).toEqual([["a", "", "c"]]);
  });

  test("respects quotes around a comma", () => {
    expect(parseCsv('name,note\nAda,"hello, world"')).toEqual([
      ["name", "note"],
      ["Ada", "hello, world"],
    ]);
  });

  test("unescapes a doubled quote inside a quoted field", () => {
    expect(parseCsv('q\n"she said ""hi"""')).toEqual([["q"], ['she said "hi"']]);
  });

  test("allows a newline inside a quoted field", () => {
    expect(parseCsv('q\n"line1\nline2"')).toEqual([["q"], ["line1\nline2"]]);
  });

  test("strips a leading UTF-8 BOM", () => {
    expect(parseCsv("﻿a,b\n1,2")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  test("returns an empty array for empty input", () => {
    expect(parseCsv("")).toEqual([]);
  });

  test("throws CsvError on an unterminated quoted field", () => {
    expect(() => parseCsv('a\n"oops')).toThrow(CsvError);
  });
});
