import { describe, expect, test } from "bun:test";
import { EXAMPLE_PAYLOAD, InputError, resolveProvisionPayload } from "./provision-input.ts";

const noFile = (): Promise<string> => Promise.reject(new Error("should not read"));

describe("resolveProvisionPayload", () => {
  test("--example returns the canned payload", async () => {
    expect(await resolveProvisionPayload({ example: true }, noFile)).toEqual(EXAMPLE_PAYLOAD);
  });

  test("--input and --example together is an error", async () => {
    await expect(resolveProvisionPayload({ example: true, input: "x.json" }, noFile)).rejects.toThrow(/not both/);
  });

  test("neither flag is an error", async () => {
    await expect(resolveProvisionPayload({}, noFile)).rejects.toThrow(/--input|--example/);
  });

  test("--input parses and validates {user, company}", async () => {
    const read = (): Promise<string> =>
      Promise.resolve(JSON.stringify({ user: { email: "a@b.co" }, company: { name: "Co" } }));
    expect(await resolveProvisionPayload({ input: "x.json" }, read)).toEqual({
      user: { email: "a@b.co" },
      company: { name: "Co" },
    });
  });

  test("--input missing company is rejected", async () => {
    const read = (): Promise<string> => Promise.resolve(JSON.stringify({ user: {} }));
    await expect(resolveProvisionPayload({ input: "x.json" }, read)).rejects.toThrow(InputError);
  });

  test("--input invalid JSON is rejected", async () => {
    const read = (): Promise<string> => Promise.resolve("{not json");
    await expect(resolveProvisionPayload({ input: "x.json" }, read)).rejects.toThrow(/not valid JSON/);
  });
});
