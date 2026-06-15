// Bun test preload (wired up in bunfig.toml); runs once before the suite.
//
// Token precedence is session > env > stdin (AINT-588), so command-handler tests
// that don't inject their own credential store would otherwise read the developer's
// real ~/.config/gusto session - and could hit the network on a refresh. Point the
// store at an empty temp dir and supply an ambient access token so those handlers
// resolve auth deterministically (the token value is irrelevant - network is stubbed).
//
// Tests that exercise precedence directly (api-context.test.ts, env.test.ts) clear
// these vars in their own setup, and store/config tests override XDG_CONFIG_HOME
// per-test, so this default never leaks into them.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "gusto-cli-unit-"));
process.env.GUSTO_ACCESS_TOKEN = "unit-test-token";
