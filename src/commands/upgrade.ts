import type { Command } from "commander";
import { CONFIRM_OPT } from "../lib/cli-options.ts";
import { agentWriteGate } from "../lib/confirm.ts";
import { readGlobalFlags } from "../lib/global-flags.ts";
import { type CommandHandler, runCommand } from "../lib/runner.ts";
import { type UpgradeDeps, performUpgrade } from "../lib/upgrade.ts";

interface UpgradeCommandOpts {
  force?: boolean;
  dryRun?: boolean;
  confirm?: boolean;
}

export function registerUpgradeCommand(parent: Command): void {
  parent
    .command("upgrade")
    .description("Replace this gusto binary with the latest release, verifying its checksum")
    .option("--force", "Reinstall even when already on the latest version")
    // Not DRY_RUN_OPT: the shared wording ("build the request without sending") describes an API
    // call, and this command doesn't make one.
    .option("--dry-run", "Report what's available without downloading or replacing anything")
    .option(...CONFIRM_OPT)
    .addHelpText(
      "after",
      `
Examples:
  $ gusto upgrade
  $ gusto upgrade --dry-run              # report what's available, download nothing
  $ GUSTO_CLI_VERSION=v0.1.0 gusto upgrade   # pin a release (also how to downgrade)

Downloads gusto-<os>-<arch> from the GitHub release, verifies it against that
release's SHA256SUMS, checks the new binary runs, then atomically replaces the
installed one. A checksum mismatch or a binary that won't run leaves the current
install untouched. Being already up to date is a success, not an error.

Honors the same overrides as install.sh: GUSTO_CLI_VERSION, GUSTO_CLI_REPO,
GUSTO_CLI_BASE_URL, GUSTO_INSTALL_DIR. Installs managed by a package manager
(Homebrew, Nix) are refused - update those with the package manager instead.

If an upgrade can't finish, the failure carries a hint naming the way out, so
there's nothing to look up. Usually that's the installer, which fetches the same
release by a different route (retrying curl, its own staging dir):

  curl -fsSL https://cli.gusto.com/install.sh | sh

Or download the binary for your platform by hand from
https://github.com/Gusto/gusto-cli/releases and replace the one you're running.
`,
    )
    .action((opts: UpgradeCommandOpts) =>
      runCommand("gusto upgrade", readGlobalFlags(parent.opts()), upgradeHandler(opts)),
    );
}

/** `overrides` exists for tests: they inject the target path (via env), a stub fetch, and a fake
 * platform so no test ever touches the network or the runner's own executable. */
export function upgradeHandler(opts: UpgradeCommandOpts, overrides: Partial<UpgradeDeps> = {}): CommandHandler {
  return async ({ globals, sinks }) =>
    performUpgrade(
      { force: opts.force, dryRun: opts.dryRun },
      {
        gate: (description) => agentWriteGate(globals, description, { confirm: opts.confirm, dryRun: opts.dryRun }),
        log: (line) => sinks.stderr.write(`${line}\n`), // noboost
        ...overrides,
      },
    );
}
