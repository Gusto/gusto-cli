import { describe, expect, test } from "bun:test";
import { Readable } from "node:stream";
import { readAllFromStdin, readTokenFromStdin } from "./stdin.ts";

describe("readTokenFromStdin", () => {
  test("returns the piped token with the trailing newline stripped", async () => {
    expect(await readTokenFromStdin(Readable.from([Buffer.from("my-secret-token\n")]))).toBe("my-secret-token");
  });

  test("trims surrounding whitespace", async () => {
    expect(await readTokenFromStdin(Readable.from(["  tok  \n"]))).toBe("tok");
  });

  test("reassembles a token split across chunks", async () => {
    expect(await readTokenFromStdin(Readable.from(["abc", "def\n"]))).toBe("abcdef");
  });

  test("uses only the first line when several are piped", async () => {
    expect(await readTokenFromStdin(Readable.from(["real-token\nextra-junk\n"]))).toBe("real-token");
  });

  test("ignores leading blank lines", async () => {
    expect(await readTokenFromStdin(Readable.from(["\n\nreal-token\n"]))).toBe("real-token");
  });

  test("fast-fails to null on an interactive TTY without blocking on stdin", async () => {
    // isTTY set + an iterator that throws if touched: proves we never start reading.
    const tty = {
      isTTY: true,
      async *[Symbol.asyncIterator]() {
        throw new Error("stdin must not be read on a TTY");
        yield Buffer.from(""); // unreachable; satisfies the generator signature
      },
    } as unknown as AsyncIterable<Buffer | string>;
    expect(await readTokenFromStdin(tty)).toBeNull();
  });

  test("returns null for empty input", async () => {
    expect(await readTokenFromStdin(Readable.from([]))).toBeNull();
  });

  test("returns null for whitespace-only input", async () => {
    expect(await readTokenFromStdin(Readable.from(["\n"]))).toBeNull();
  });
});

describe("readAllFromStdin", () => {
  test("preserves interior newlines across multiple chunks", async () => {
    expect(await readAllFromStdin(Readable.from(["line one\n", "line two\n"]))).toBe("line one\nline two");
  });

  test("trims only trailing whitespace and newlines, not interior newlines", async () => {
    expect(await readAllFromStdin(Readable.from(["first\nsecond\nthird\n\n"]))).toBe("first\nsecond\nthird");
  });

  test("returns null for empty input", async () => {
    expect(await readAllFromStdin(Readable.from([]))).toBeNull();
  });

  test("returns null for whitespace-only input", async () => {
    expect(await readAllFromStdin(Readable.from(["\n\n   \n"]))).toBeNull();
  });

  test("fast-fails to null on an interactive TTY without blocking on stdin", async () => {
    const tty = {
      isTTY: true,
      async *[Symbol.asyncIterator]() {
        throw new Error("stdin must not be read on a TTY");
        yield Buffer.from(""); // unreachable; satisfies the generator signature
      },
    } as unknown as AsyncIterable<Buffer | string>;
    expect(await readAllFromStdin(tty)).toBeNull();
  });
});
