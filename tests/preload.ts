// Bun test preload (wired up in bunfig.toml); runs once before the suite.
//
// Token precedence puts an explicit token first - stdin > env > session.
// Set an ambient GUSTO_ACCESS_TOKEN so command-handler tests that don't inject their
// own credential store resolve auth deterministically off the env token, never the
// developer's real ~/.config/gusto session (which could hit the network on refresh).
// Point the store at an empty temp dir as a second guard. The token value is
// irrelevant - network is stubbed.
//
// Tests that exercise precedence directly (api-context.test.ts, env.test.ts) clear
// these vars in their own setup, and store/config tests override XDG_CONFIG_HOME
// per-test, so this default never leaks into them.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Drop every ambient GUSTO_* var first. Developers commonly export variables from their shell profile.
// This is the in-process counterpart to stripGustoEnv in tests/smoke.test.ts, which does this for the spawned
// binary. Runs before the assignments below so the two vars the suite does rely on survive.
for (const key of Object.keys(process.env)) {
  if (key.startsWith("GUSTO_")) delete process.env[key];
}

process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "gusto-cli-unit-"));
process.env.GUSTO_ACCESS_TOKEN = "unit-test-token";
