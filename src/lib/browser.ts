import { spawn } from "node:child_process";
import { isTruthy } from "./env.ts";

/** Whether this environment can plausibly open a browser the user will actually see.
 * Used to decide whether `auth login` should launch a browser or just print the URL -
 * a capability of the environment, independent of whether output is agent/JSON mode.
 * `spawn("xdg-open")` resolves even with no display, so we can't rely on the spawn
 * failing; we infer from the environment instead. */
export function canOpenBrowser(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): boolean {
  // CI never has a human at a desktop, regardless of anything else.
  if (isTruthy(env.CI)) return false;
  // BROWSER lets the user decide how URLs open. A real launcher (`firefox`) means
  // yes; by convention `none` or empty means "never open one", so honor that as a
  // suppress override on every platform before the per-OS heuristics run.
  if (env.BROWSER !== undefined) return env.BROWSER !== "" && env.BROWSER !== "none";
  if (platform === "linux") {
    // A graphical launcher needs an X11/Wayland display. This also handles SSH:
    // forwarded sessions set DISPLAY, bare remote shells don't.
    return Boolean(env.DISPLAY || env.WAYLAND_DISPLAY);
  }
  if (platform === "darwin" || platform === "win32") {
    // A logged-in GUI session is the norm; bail only in a remote shell, where
    // `open`/`start` would target the console session, not the SSH user.
    if (env.SSH_CONNECTION || env.SSH_TTY || env.SSH_CLIENT) return false;
    return true;
  }
  return false;
}

/** Open a URL in the user's default browser. Generic helper - not OAuth-specific,
 * so non-auth callers (e.g. the hosted form-signing flow) can depend on it without
 * reaching into lib/oauth/*. */
export function defaultOpenBrowser(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
    const child = spawn(cmd, [url], { stdio: "ignore", detached: true });
    child.on("error", reject);
    child.on("spawn", () => {
      child.unref();
      resolve();
    });
  });
}
