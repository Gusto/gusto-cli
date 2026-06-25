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
    // Command-level concern: routes to the MCP host and calls the right tool with the right args.
    // The JSON-RPC envelope mechanics (method/version) are covered by mcp.test.ts.
    expect(call?.url).toContain("mcp.api.gusto-demo.com");
    expect(call?.body).toMatchObject({
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

  test("includes email in the MCP arguments on a real send", async () => {
    const fetchStub = stubGlobalFetch(() => ({ status: 200, body: successEnvelope({ status: "received" }) }));
    restore = fetchStub.restore;
    await feedbackHandler({ message: "hi", email: "u@e.com" }, noStdin)(ctx);
    const args = (fetchStub.calls[0]?.body as { params?: { arguments?: object } })?.params?.arguments;
    expect(args).toEqual({ message: "hi", email: "u@e.com" });
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

  test("invalid --category returns validation failure with category field flagged", async () => {
    const fetchStub = stubGlobalFetch(() => ({ status: 200, body: {} }));
    restore = fetchStub.restore;
    const result = await feedbackHandler({ message: "hi", category: "bogus" }, noStdin)(ctx);
    expect(result.ok).toBe(false);
    expect(blockedFields(result)).toEqual(["category"]);
    expect(fetchStub.calls).toHaveLength(0);
  });

  test("--message exceeding 5000 chars returns validation failure and does not call MCP", async () => {
    const fetchStub = stubGlobalFetch(() => ({ status: 200, body: {} }));
    restore = fetchStub.restore;
    const result = await feedbackHandler({ message: "x".repeat(5001) }, noStdin)(ctx);
    expect(result.ok).toBe(false);
    expect(blockedFields(result)).toEqual(["message"]);
    expect(fetchStub.calls).toHaveLength(0);
  });

  test("a message of exactly 5000 chars is accepted and sent", async () => {
    const fetchStub = stubGlobalFetch(() => ({ status: 200, body: successEnvelope({ status: "received" }) }));
    restore = fetchStub.restore;
    const exact = "z".repeat(5000);
    okData(await feedbackHandler({ message: exact }, noStdin)(ctx));
    const args = (fetchStub.calls[0]?.body as { params?: { arguments?: { message?: string } } })?.params?.arguments;
    expect(args?.message).toHaveLength(5000);
  });

  test("--context is parsed and included in the MCP arguments on a real send", async () => {
    const fetchStub = stubGlobalFetch(() => ({ status: 200, body: successEnvelope({ status: "received" }) }));
    restore = fetchStub.restore;
    await feedbackHandler({ message: "hi", context: '{"os":"darwin"}' }, noStdin)(ctx);
    const args = (fetchStub.calls[0]?.body as { params?: { arguments?: object } })?.params?.arguments;
    expect(args).toEqual({ message: "hi", context: { os: "darwin" } });
  });

  test("invalid --context JSON returns validationFailure with context field, no MCP call", async () => {
    const fetchStub = stubGlobalFetch(() => ({ status: 200, body: {} }));
    restore = fetchStub.restore;
    const result = await feedbackHandler({ message: "hi", context: "not json" }, noStdin)(ctx);
    expect(result.ok).toBe(false);
    expect(blockedFields(result)).toEqual(["context"]);
    expect(fetchStub.calls).toHaveLength(0);
  });

  test("--context with an array returns validationFailure with context field, no MCP call", async () => {
    const fetchStub = stubGlobalFetch(() => ({ status: 200, body: {} }));
    restore = fetchStub.restore;
    const result = await feedbackHandler({ message: "hi", context: "[1,2]" }, noStdin)(ctx);
    expect(result.ok).toBe(false);
    expect(blockedFields(result)).toEqual(["context"]);
    expect(fetchStub.calls).toHaveLength(0);
  });

  test("--context with a scalar string returns validationFailure with context field, no MCP call", async () => {
    const fetchStub = stubGlobalFetch(() => ({ status: 200, body: {} }));
    restore = fetchStub.restore;
    const result = await feedbackHandler({ message: "hi", context: '"x"' }, noStdin)(ctx);
    expect(result.ok).toBe(false);
    expect(blockedFields(result)).toEqual(["context"]);
    expect(fetchStub.calls).toHaveLength(0);
  });

  test("dry-run includes the parsed context object in the returned arguments", async () => {
    const fetchStub = stubGlobalFetch(() => ({ status: 200, body: {} }));
    restore = fetchStub.restore;
    const d = okData(
      await feedbackHandler({ message: "hi", context: '{"os":"darwin","version":"1.0"}', dryRun: true }, noStdin)(ctx),
    );
    expect(d).toEqual({
      tool: "submit_feedback",
      arguments: { message: "hi", context: { os: "darwin", version: "1.0" } },
    });
    expect(fetchStub.calls).toHaveLength(0);
  });
});
