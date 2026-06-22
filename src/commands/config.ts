import type { Command } from "commander";
import {
  CONFIG_KEYS,
  type ConfigKey,
  type UserConfig,
  configPaths,
  readConfig,
  resetConfig,
  normalizeValue,
  validateKey,
  validateValue,
  writeConfig,
} from "../lib/config.ts";
import { ExitCode } from "../lib/exit-codes.ts";
import { readGlobalFlags } from "../lib/global-flags.ts";
import { type CommandHandler, type CommandResult, runCommand, runReadCommand } from "../lib/runner.ts";

function requireValidKey(key: string): { ok: true; key: ConfigKey } | { ok: false; result: CommandResult } {
  const validKey = validateKey(key);
  if (validKey) return { ok: true, key: validKey };
  return {
    ok: false,
    result: {
      ok: false,
      exitCode: ExitCode.Validation,
      error: { code: "unknown_key", message: `Unknown config key: ${key}. Valid keys: ${CONFIG_KEYS.join(", ")}` },
    },
  };
}

export function registerConfigCommand(parent: Command): void {
  const cmd = parent.command("config").description("Get / set / list user-settable config + reset local state");

  cmd
    .command("get <key>")
    .description(`Read a single config key (one of: ${CONFIG_KEYS.join(", ")})`)
    .action((key: string) => runReadCommand("gusto config get", readGlobalFlags(parent.opts()), configGetHandler(key)));

  cmd
    .command("set <key> <value>")
    .description("Set a user config key (V1: environment, format)")
    .addHelpText(
      "after",
      `
Examples:
  $ gusto config set environment sandbox
  $ gusto config set format agent
`,
    )
    .action((key: string, value: string) =>
      runCommand("gusto config set", readGlobalFlags(parent.opts()), configSetHandler(key, value)),
    );

  cmd
    .command("list")
    .description("Show all user-settable config values")
    .action(() => runReadCommand("gusto config list", readGlobalFlags(parent.opts()), configListHandler()));

  cmd
    .command("reset")
    .description("Wipe local config (recovery / fresh start)")
    .action(() => runCommand("gusto config reset", readGlobalFlags(parent.opts()), configResetHandler()));
}

function configGetHandler(key: string): CommandHandler {
  return async () => {
    const checked = requireValidKey(key);
    if (!checked.ok) return checked.result;
    const validKey = checked.key;
    const cfg = await readConfig();
    return { ok: true, data: { key: validKey, value: cfg[validKey] ?? null } };
  };
}

function configSetHandler(key: string, value: string): CommandHandler {
  return async () => {
    const checked = requireValidKey(key);
    if (!checked.ok) return checked.result;
    const validKey = checked.key;
    const valueError = validateValue(validKey, value);
    if (valueError) {
      return {
        ok: false,
        exitCode: ExitCode.Validation,
        error: { code: "invalid_value", message: valueError },
      };
    }
    const normalized = normalizeValue(validKey, value);
    const cfg = await readConfig();
    const updated: UserConfig = { ...cfg, [validKey]: normalized };
    await writeConfig(updated);
    return { ok: true, data: { key: validKey, value: normalized } };
  };
}

function configListHandler(): CommandHandler {
  return async () => {
    const cfg = await readConfig();
    const paths = configPaths();
    return {
      ok: true,
      data: {
        config_path: paths.file,
        values: Object.fromEntries(CONFIG_KEYS.map((k) => [k, cfg[k] ?? null])),
      },
    };
  };
}

function configResetHandler(): CommandHandler {
  return async () => {
    const paths = configPaths();
    await resetConfig(paths);
    return { ok: true, data: { reset: true, config_path: paths.file } };
  };
}
