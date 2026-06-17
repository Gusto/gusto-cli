import { describe, expect, test } from "bun:test";
import { canOpenBrowser } from "./browser.ts";

describe("canOpenBrowser", () => {
  test("macOS desktop session can open a browser", () => {
    expect(canOpenBrowser({}, "darwin")).toBe(true);
  });

  test("Windows desktop session can open a browser", () => {
    expect(canOpenBrowser({}, "win32")).toBe(true);
  });

  test("Linux needs an X11 or Wayland display", () => {
    expect(canOpenBrowser({}, "linux")).toBe(false);
    expect(canOpenBrowser({ DISPLAY: ":0" }, "linux")).toBe(true);
    expect(canOpenBrowser({ WAYLAND_DISPLAY: "wayland-0" }, "linux")).toBe(true);
    expect(canOpenBrowser({ DISPLAY: "" }, "linux")).toBe(false);
  });

  test("CI is never treated as openable", () => {
    expect(canOpenBrowser({ CI: "true" }, "darwin")).toBe(false);
    expect(canOpenBrowser({ CI: "1" }, "win32")).toBe(false);
    expect(canOpenBrowser({ CI: "true", DISPLAY: ":0" }, "linux")).toBe(false);
  });

  test("CI set to a falsey string is ignored", () => {
    expect(canOpenBrowser({ CI: "false" }, "darwin")).toBe(true);
    expect(canOpenBrowser({ CI: "0" }, "darwin")).toBe(true);
    expect(canOpenBrowser({ CI: "" }, "darwin")).toBe(true);
  });

  test("a remote SSH shell on macOS/Windows can't reach the user's display", () => {
    expect(canOpenBrowser({ SSH_CONNECTION: "10.0.0.1 22 10.0.0.2 22" }, "darwin")).toBe(false);
    expect(canOpenBrowser({ SSH_TTY: "/dev/pts/0" }, "darwin")).toBe(false);
    expect(canOpenBrowser({ SSH_CLIENT: "10.0.0.1 22 22" }, "win32")).toBe(false);
  });

  test("SSH with X11 forwarding (DISPLAY present) can open on Linux", () => {
    expect(canOpenBrowser({ SSH_CONNECTION: "x", DISPLAY: "localhost:10.0" }, "linux")).toBe(true);
    expect(canOpenBrowser({ SSH_CONNECTION: "x" }, "linux")).toBe(false);
  });

  test("an explicit BROWSER launcher overrides headless detection", () => {
    expect(canOpenBrowser({ BROWSER: "firefox" }, "linux")).toBe(true);
    expect(canOpenBrowser({ BROWSER: "firefox", SSH_TTY: "/dev/pts/0" }, "darwin")).toBe(true);
  });

  test("CI wins over an explicit BROWSER (no human to see the tab)", () => {
    expect(canOpenBrowser({ CI: "true", BROWSER: "firefox" }, "linux")).toBe(false);
  });

  test("an unknown platform is treated as not openable", () => {
    expect(canOpenBrowser({}, "freebsd" as NodeJS.Platform)).toBe(false);
  });
});
