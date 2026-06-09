import { describe, expect, test } from "bun:test";
import { InputError, resolveProvisionPayload } from "./provision-input.ts";

const noFile = (): Promise<string> => Promise.reject(new Error("should not read"));

describe("resolveProvisionPayload", () => {
  test("--example returns the canned shape with a unique email + EIN", async () => {
    const payload = await resolveProvisionPayload({ example: true }, noFile);
    expect(payload.user.first_name).toBe("Ada");
    expect(payload.user.email).toMatch(/^ada\+[a-f0-9]{8}@example\.com$/);
    expect(payload.company.name).toBe("Analytical Engines LLC");
    expect(payload.company.ein).toMatch(/^00-\d{7}$/);
  });

  test("--example yields distinct email + EIN across calls (so repeat runs don't 422)", async () => {
    const a = await resolveProvisionPayload({ example: true }, noFile);
    const b = await resolveProvisionPayload({ example: true }, noFile);
    expect(a.user.email).not.toBe(b.user.email);
    expect(a.company.ein).not.toBe(b.company.ein);
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
