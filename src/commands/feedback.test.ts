import { afterEach, describe, expect, test } from "bun:test";
import { feedbackHandler } from "./feedback.ts";
import { TEST_CONTEXT as ctx, blockedFields, okData, stubGlobalFetch, successEnvelope } from "../lib/test-support.ts";

let restore: () => void = () => {};
afterEach(() => restore());

const noStdin = async () => null;

describe("feedbackHandler", () => {
  test("--dry-run returns tool+arguments without making a network call", async () => {
    const fetchStub = stubGlobalFetch(() => ({ status: 200, body: {} }));
    restore = fetchStub.restore;
    const d = okData(await feedbackHandler({ message: "hi", email: "u@e.com", dryRun: true }, noStdin)(ctx));
    expect(d).toEqual({ tool: "submit_feedback", arguments: { message: "hi", email: "u@e.com" } });
    expect(fetchStub.calls).toHaveLength(0);
  });

  test("calls submit_feedback via MCP and returns the tool result", async () => {
    const payload = { status: "received", feedback_id: "1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed" };
    const fetchStub = stubGlobalFetch(() => ({ status: 200, body: successEnvelope(payload) }));
    restore = fetchStub.restore;
    const d = okData(await feedbackHandler({ message: "hi", category: "bug" }, noStdin)(ctx));
    expect(d).toEqual({ status: "received", feedback_id: "1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed" });
    expect(fetchStub.calls).toHaveLength(1);
    const call = fetchStub.calls[0];
    expect(call?.method).toBe("POST");
    expect(call?.url).toContain("mcp.api.gusto-demo.com");
    expect(call?.body).toMatchObject({
      jsonrpc: "2.0",
      method: "tools/call",
      params: { name: "submit_feedback", arguments: { message: "hi", category: "bug" } },
    });
  });

  test("omits absent optional fields from the MCP arguments", async () => {
    const fetchStub = stubGlobalFetch(() => ({ status: 200, body: successEnvelope({ status: "received" }) }));
    restore = fetchStub.restore;
    await feedbackHandler({ message: "just a message" }, noStdin)(ctx);
    const args = (fetchStub.calls[0]?.body as { params?: { arguments?: object } })?.params?.arguments;
    expect(args).toEqual({ message: "just a message" });
  });

  test("missing message with no stdin returns missingArgs", async () => {
    const fetchStub = stubGlobalFetch(() => ({ status: 200, body: {} }));
    restore = fetchStub.restore;
    const result = await feedbackHandler({}, noStdin)(ctx);
    expect(result.ok).toBe(false);
    expect(blockedFields(result)).toEqual(["message"]);
    expect(fetchStub.calls).toHaveLength(0);
  });

  test("--token-stdin without --message returns missingArgs (stdin collision)", async () => {
    const fetchStub = stubGlobalFetch(() => ({ status: 200, body: {} }));
    restore = fetchStub.restore;
    const result = await feedbackHandler({ tokenStdin: true }, noStdin)(ctx);
    expect(result.ok).toBe(false);
    expect(blockedFields(result)).toEqual(["message"]);
    expect(fetchStub.calls).toHaveLength(0);
  });

  test("reads the message from stdin when --message is absent", async () => {
    const fetchStub = stubGlobalFetch(() => ({ status: 200, body: successEnvelope({ status: "received" }) }));
    restore = fetchStub.restore;
    okData(await feedbackHandler({}, async () => "piped message")(ctx));
    const args = (fetchStub.calls[0]?.body as { params?: { arguments?: object } })?.params?.arguments;
    expect(args).toMatchObject({ message: "piped message" });
  });

  test("whitespace-only --message is rejected as missing", async () => {
    const fetchStub = stubGlobalFetch(() => ({ status: 200, body: {} }));
    restore = fetchStub.restore;
    const result = await feedbackHandler({ message: "   " }, noStdin)(ctx);
    expect(result.ok).toBe(false);
    expect(blockedFields(result)).toEqual(["message"]);
    expect(fetchStub.calls).toHaveLength(0);
  });

  test("invalid --category returns validation failure with category field flagged", async () => {
    const fetchStub = stubGlobalFetch(() => ({ status: 200, body: {} }));
    restore = fetchStub.restore;
    const result = await feedbackHandler({ message: "hi", category: "bogus" }, noStdin)(ctx);
    expect(result.ok).toBe(false);
    expect(blockedFields(result)).toEqual(["category"]);
    expect(fetchStub.calls).toHaveLength(0);
  });
});
