import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { FileStore, resolveStore } from "./token-store.ts";

let scratch: string;
let file: string;

beforeEach(() => {
  scratch = mkdtempSync(path.join(tmpdir(), "gusto-cli-creds-"));
  file = path.join(scratch, "credentials.toml");
});
afterEach(() => rmSync(scratch, { recursive: true, force: true }));

describe("FileStore", () => {
  test("round-trips a session and writes 0600", async () => {
    const store = new FileStore(file);
    await store.save("sandbox", { clientId: "c", accessToken: "at" });
    expect(await store.load("sandbox")).toEqual({ clientId: "c", accessToken: "at" });
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  test("one env does not clobber another; clear removes only one", async () => {
    const store = new FileStore(file);
    await store.save("sandbox", { accessToken: "s-at" });
    await store.save("production", { accessToken: "p-at" });
    await store.clear("sandbox");
    expect(await store.load("sandbox")).toBeNull();
    expect(await store.load("production")).toEqual({ accessToken: "p-at" });
  });

  test("load returns null when the file is absent", async () => {
    expect(await new FileStore(file).load("sandbox")).toBeNull();
  });
});

describe("resolveStore", () => {
  test("returns a FileStore", () => {
    expect(resolveStore()).toBeInstanceOf(FileStore);
  });
});
