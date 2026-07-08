import { Command } from "commander";
import type { StdinReader } from "../lib/api-context.ts";
import { DRY_RUN_OPT, TOKEN_STDIN_OPT } from "../lib/cli-options.ts";
import { readGlobalFlags } from "../lib/global-flags.ts";
import { callMcpTool } from "../lib/mcp.ts";
import { type CommandHandler, missingArgs, runCommand, validationFailure } from "../lib/runner.ts";
import { readAllFromStdin } from "../lib/stdin.ts";

interface FeedbackOpts {
  message?: string;
  category?: string;
  context?: string;
  tokenStdin?: boolean;
  dryRun?: boolean;
}

type FeedbackCategory = "bug" | "feature_request" | "general" | "praise";
const CATEGORY_CHOICES: readonly FeedbackCategory[] = ["bug", "feature_request", "general", "praise"];
const MAX_MESSAGE_LENGTH = 5000;

function isFeedbackCategory(v: string): v is FeedbackCategory {
  return CATEGORY_CHOICES.includes(v as FeedbackCategory);
}

export function registerFeedbackCommand(parent: Command): void {
  parent
    .command("feedback")
    .description("Send feedback to Gusto")
    .option("--message <text>", "Feedback message (or pipe it via stdin)")
    .option("--category <value>", "Optional feedback category")
    .option("--context <json>", "Optional context metadata as a JSON object")
    .option(...DRY_RUN_OPT)
    .option(...TOKEN_STDIN_OPT)
    .action((opts: FeedbackOpts) =>
      runCommand("gusto feedback", readGlobalFlags(parent.opts()), feedbackHandler(opts)),
    );
}

const readMessageFromStdin: StdinReader = () => readAllFromStdin(process.stdin, MAX_MESSAGE_LENGTH);

export function feedbackHandler(opts: FeedbackOpts, readStdin: StdinReader = readMessageFromStdin): CommandHandler {
  return async ({ globals }) => {
    if (opts.tokenStdin && !opts.message) {
      return missingArgs([{ field: "message", reason: "--token-stdin uses stdin, so --message is required" }]);
    }

    const message = (opts.message ?? (await readStdin()))?.trim();
    if (!message) {
      return missingArgs([{ field: "message", reason: "provide --message <text> or pipe the message to stdin" }]);
    }

    if (message.length > MAX_MESSAGE_LENGTH) {
      return validationFailure(`message exceeds ${MAX_MESSAGE_LENGTH} characters`, [
        { field: "message", reason: `message exceeds ${MAX_MESSAGE_LENGTH} characters` },
      ]);
    }

    let category: FeedbackCategory | undefined;
    if (opts.category) {
      if (!isFeedbackCategory(opts.category)) {
        return validationFailure("invalid --category", [
          { field: "category", reason: `must be one of: ${CATEGORY_CHOICES.join(", ")}, got: ${opts.category}` },
        ]);
      }
      category = opts.category;
    }

    let context: Record<string, unknown> | undefined;
    if (opts.context !== undefined) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(opts.context);
      } catch {
        return validationFailure("--context must be valid JSON", [
          { field: "context", reason: "--context must be valid JSON" },
        ]);
      }
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        return validationFailure("--context must be a JSON object", [
          { field: "context", reason: "--context must be a JSON object, not an array or scalar" },
        ]);
      }
      context = parsed as Record<string, unknown>;
    }

    const body: { message: string; category?: FeedbackCategory; context?: Record<string, unknown> } = {
      message,
    };
    if (category) body.category = category;
    if (context) body.context = context;

    if (opts.dryRun) {
      return { ok: true, data: { tool: "submit_feedback", arguments: body } };
    }

    return callMcpTool(globals, { tokenStdin: opts.tokenStdin }, "submit_feedback", body);
  };
}
