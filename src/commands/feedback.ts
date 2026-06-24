import { Command } from "commander";
import type { StdinReader } from "../lib/api-context.ts";
import { DRY_RUN_OPT, TOKEN_STDIN_OPT } from "../lib/cli-options.ts";
import { readGlobalFlags } from "../lib/global-flags.ts";
import { callMcpTool } from "../lib/mcp.ts";
import { type CommandHandler, missingArgs, runCommand, validationFailure } from "../lib/runner.ts";
import { readAllFromStdin } from "../lib/stdin.ts";

interface FeedbackOpts {
  message?: string;
  email?: string;
  category?: string;
  tokenStdin?: boolean;
  dryRun?: boolean;
}

const CATEGORY_CHOICES = ["bug", "feature_request", "general", "praise"] as const;

export function registerFeedbackCommand(parent: Command): void {
  parent
    .command("feedback")
    .description("Send feedback to Gusto")
    .option("--message <text>", "Feedback message (or pipe it via stdin)")
    .option("--email <addr>", "Optional reply-to email")
    .option("--category <value>", "Optional feedback category")
    .option(...DRY_RUN_OPT)
    .option(...TOKEN_STDIN_OPT)
    .action((opts: FeedbackOpts) =>
      runCommand("gusto feedback", readGlobalFlags(parent.opts()), feedbackHandler(opts)),
    );
}

export function feedbackHandler(opts: FeedbackOpts, readStdin: StdinReader = readAllFromStdin): CommandHandler {
  return async ({ globals }) => {
    if (opts.tokenStdin && !opts.message) {
      return missingArgs([{ field: "message", reason: "--token-stdin uses stdin, so --message is required" }]);
    }

    const message = (opts.message ?? (await readStdin()))?.trim() ?? "";
    if (!message) {
      return missingArgs([{ field: "message", reason: "provide --message <text> or pipe the message to stdin" }]);
    }

    if (opts.category && !(CATEGORY_CHOICES as readonly string[]).includes(opts.category)) {
      return validationFailure("invalid --category", [
        { field: "category", reason: `must be one of: ${CATEGORY_CHOICES.join(", ")}, got: ${opts.category}` },
      ]);
    }

    const body: { message: string; email?: string; category?: string } = { message };
    if (opts.email) body.email = opts.email;
    if (opts.category) body.category = opts.category;

    if (opts.dryRun) {
      return { ok: true, data: { tool: "submit_feedback", arguments: body } };
    }

    return callMcpTool(globals, { tokenStdin: opts.tokenStdin }, "submit_feedback", body);
  };
}
