import { spawn } from "node:child_process";

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
