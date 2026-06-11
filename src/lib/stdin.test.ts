import { describe, expect, test } from "bun:test";
import { Readable } from "node:stream";
import { readTokenFromStdin } from "./stdin.ts";

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

  test("returns null for empty input", async () => {
    expect(await readTokenFromStdin(Readable.from([]))).toBeNull();
  });

  test("returns null for whitespace-only input", async () => {
    expect(await readTokenFromStdin(Readable.from(["\n"]))).toBeNull();
  });
});
