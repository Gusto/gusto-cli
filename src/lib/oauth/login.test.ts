import { describe, expect, test } from "bun:test";
import { type SignInUrlEvent, companyUuidFromTokenInfo, formatUrlForTerminal, login, openOrPrint } from "./login.ts";
import { memoryStore, mockFetch } from "./test-support.ts";

function driveCallback(): {
  openBrowser: (authorizeUrl: string) => Promise<void>;
  response: () => Promise<Response>;
} {
  let responsePromise: Promise<Response> | undefined;
  const openBrowser = (authorizeUrl: string): Promise<void> => {
    const u = new URL(authorizeUrl);
    const redirect = u.searchParams.get("redirect_uri") as string;
    const state = u.searchParams.get("state") as string;
    responsePromise = globalThis.fetch(`${redirect}?code=auth-code&state=${state}`);
    return Promise.resolve();
  };
  return { openBrowser, response: () => responsePromise as Promise<Response> };
}

/** Drive the loopback callback off a printed sign-in URL line - the print path used
 * when the browser isn't opened (--no-browser or a headless environment). */
function driveLoopbackFromPrintedUrl(line: string): void {
  const m = line.match(/(https?:\/\/\S+\/oauth\/authorize\S*)/);
  if (!m) return;
  const u = new URL(m[1]);
  void globalThis.fetch(`${u.searchParams.get("redirect_uri")}?code=c&state=${u.searchParams.get("state")}`);
}

describe("companyUuidFromTokenInfo", () => {
  test("returns resource.uuid for a Company-scoped token", () => {
    expect(companyUuidFromTokenInfo({ resource: { type: "Company", uuid: "comp-1" } })).toBe("comp-1");
  });
  test("undefined when the resource is not a Company", () => {
    expect(companyUuidFromTokenInfo({ resource: { type: "Employee", uuid: "e-1" } })).toBeUndefined();
    expect(companyUuidFromTokenInfo({})).toBeUndefined();
  });
});

describe("formatUrlForTerminal", () => {
  test("wraps the URL in an OSC 8 hyperlink on a TTY", () => {
    const out = formatUrlForTerminal("https://auth.test/go", true);
    expect(out).toBe("\x1b]8;;https://auth.test/go\x1b\\https://auth.test/go\x1b]8;;\x1b\\");
  });
  test("falls back to the bare URL when not a TTY", () => {
    expect(formatUrlForTerminal("https://auth.test/go", false)).toBe("https://auth.test/go");
  });
});

describe("openOrPrint", () => {
  test("emits an OSC 8 hyperlink for the URL when stderr is a TTY", async () => {
    const lines: string[] = [];
    await openOrPrint(
      "https://auth.test/go",
      () => Promise.resolve(),
      (l) => lines.push(l),
      true,
    );
    expect(lines.join("\n")).toContain("\x1b]8;;https://auth.test/go\x1b\\");
  });

  test("prints the opened-browser hint when the opener succeeds", async () => {
    const lines: string[] = [];
    await openOrPrint(
      "https://auth.test/go",
      () => Promise.resolve(),
      (l) => lines.push(l),
    );
    expect(lines[0]).toMatch(/Opened your browser/);
    expect(lines.join("\n")).toContain("https://auth.test/go");
  });

  test("falls back to a manual-URL prompt when the opener rejects", async () => {
    const lines: string[] = [];
    await openOrPrint(
      "https://auth.test/go",
      () => Promise.reject(new Error("no opener")),
      (l) => lines.push(l),
    );
    expect(lines[0]).toMatch(/Open this URL in your browser/);
    expect(lines.join("\n")).toContain("https://auth.test/go");
  });
});

describe("login", () => {
  test("runs PKCE, reads token_info, and persists the token + company_uuid", async () => {
    const store = memoryStore({ sandbox: { clientId: "cid", clientSecret: "sec" } }); // creds present -> no DCR
    // Mock only the api.test calls (code exchange, then token_info). The loopback
    // redirect is hit with the REAL fetch so the local server actually responds.
    const { fetch: apiFetch } = mockFetch([
      { status: 200, body: { access_token: "user-at", refresh_token: "rt", expires_in: 7200 } }, // code exchange
      {
        status: 200,
        body: {
          scope: "accounts:write",
          resource: { type: "Company", uuid: "comp-9" },
          resource_owner: { type: "PayrollAdmin", uuid: "po-1" },
        },
      }, // token_info
    ]);

    const info = await login("sandbox", {
      store,
      http: { baseUrl: "https://api.test", fetchImpl: apiFetch },
      browserAvailable: () => true,
      openBrowser: driveCallback().openBrowser,
      print: () => {},
    });

    expect(info.resource?.uuid).toBe("comp-9");
    expect(store.data.sandbox?.accessToken).toBe("user-at");
    expect(store.data.sandbox?.refreshToken).toBe("rt");
    expect(store.data.sandbox?.companyUuid).toBe("comp-9");
  });

  test("noBrowser prints the sign-in URL instead of opening a browser", async () => {
    const store = memoryStore({ sandbox: { clientId: "cid", clientSecret: "sec" } });
    const { fetch: apiFetch } = mockFetch([
      { status: 200, body: { access_token: "user-at", refresh_token: "rt", expires_in: 7200 } }, // code exchange
      { status: 200, body: { resource: { type: "Company", uuid: "comp-1" } } }, // token_info
    ]);

    const lines: string[] = [];
    let opened = false;
    // With --no-browser the URL is only printed; drive the loopback off the printed line.
    const print = (l: string): void => {
      lines.push(l);
      driveLoopbackFromPrintedUrl(l);
    };

    const info = await login("sandbox", {
      store,
      http: { baseUrl: "https://api.test", fetchImpl: apiFetch },
      openBrowser: () => {
        opened = true;
        return Promise.resolve();
      },
      noBrowser: true,
      print,
    });

    expect(opened).toBe(false);
    expect(lines.join("\n")).toMatch(/Open this URL in your browser/);
    expect(info.resource?.uuid).toBe("comp-1");
  });

  test("auto-detects a headless environment: prints the URL, skips the browser, still emits the event", async () => {
    const store = memoryStore({ sandbox: { clientId: "cid", clientSecret: "sec" } });
    const { fetch: apiFetch } = mockFetch([
      { status: 200, body: { access_token: "user-at", refresh_token: "rt", expires_in: 7200 } },
      { status: 200, body: { resource: { type: "Company", uuid: "comp-1" } } },
    ]);

    const events: SignInUrlEvent[] = [];
    let opened = false;
    // No --no-browser flag, but the environment can't open one: drive the loopback off the printed line.
    const info = await login("sandbox", {
      store,
      http: { baseUrl: "https://api.test", fetchImpl: apiFetch },
      browserAvailable: () => false,
      openBrowser: () => {
        opened = true;
        return Promise.resolve();
      },
      emitEvent: (e) => events.push(e),
      print: driveLoopbackFromPrintedUrl,
    });

    expect(opened).toBe(false);
    expect(events).toHaveLength(1); // agent still gets the URL even though no browser opened
    expect(info.resource?.uuid).toBe("comp-1");
  });

  test("auto-opens the browser when the environment has one (no --no-browser)", async () => {
    const store = memoryStore({ sandbox: { clientId: "cid", clientSecret: "sec" } });
    const { fetch: apiFetch } = mockFetch([
      { status: 200, body: { access_token: "user-at", refresh_token: "rt", expires_in: 7200 } },
      { status: 200, body: { resource: { type: "Company", uuid: "comp-1" } } },
    ]);

    let opened = false;
    const driver = driveCallback();
    const info = await login("sandbox", {
      store,
      http: { baseUrl: "https://api.test", fetchImpl: apiFetch },
      browserAvailable: () => true,
      openBrowser: (url) => {
        opened = true;
        return driver.openBrowser(url);
      },
      print: () => {},
    });

    expect(opened).toBe(true);
    expect(info.resource?.uuid).toBe("comp-1");
  });

  test("emitEvent fires with the sign-in URL before the OAuth callback completes", async () => {
    const store = memoryStore({ sandbox: { clientId: "cid", clientSecret: "sec" } });
    const { fetch: apiFetch } = mockFetch([
      { status: 200, body: { access_token: "user-at", refresh_token: "rt", expires_in: 7200 } },
      { status: 200, body: { resource: { type: "Company", uuid: "comp-1" } } },
    ]);

    // AINT-625 holds the loopback callback response open until server.complete();
    // fire-and-forget the fetch (don't await) so login can progress past openBrowser.
    const eventOrder: string[] = [];
    const events: { event: string; sign_in_url: string; state: string }[] = [];
    const openBrowser = (authorizeUrl: string): Promise<void> => {
      eventOrder.push("callback");
      const u = new URL(authorizeUrl);
      const redirect = u.searchParams.get("redirect_uri") as string;
      const state = u.searchParams.get("state") as string;
      void globalThis.fetch(`${redirect}?code=auth-code&state=${state}`);
      return Promise.resolve();
    };

    await login("sandbox", {
      store,
      http: { baseUrl: "https://api.test", fetchImpl: apiFetch },
      browserAvailable: () => true,
      openBrowser,
      emitEvent: (e) => {
        eventOrder.push("emitEvent");
        events.push(e);
      },
      print: () => {},
    });

    expect(events).toHaveLength(1);
    expect(events[0].event).toBe("sign_in_url");
    expect(events[0].sign_in_url).toMatch(/oauth\/authorize/);
    expect(events[0].state).toBeTruthy();
    // emitEvent must fire BEFORE the callback so an agent can surface the URL up front.
    expect(eventOrder).toEqual(["emitEvent", "callback"]);
  });

  test("clears a stale companyUuid when re-login yields a non-company token", async () => {
    const store = memoryStore({
      sandbox: { clientId: "cid", clientSecret: "sec", accessToken: "prev", companyUuid: "old-co" },
    });
    const { fetch: apiFetch } = mockFetch([
      { status: 200, body: { access_token: "new-at", refresh_token: "rt", expires_in: 7200 } }, // code exchange
      { status: 200, body: { resource: { type: "Employee", uuid: "emp-1" } } }, // token_info: not Company-scoped
    ]);
    await login("sandbox", {
      store,
      http: { baseUrl: "https://api.test", fetchImpl: apiFetch },
      browserAvailable: () => true,
      openBrowser: driveCallback().openBrowser,
      print: () => {},
    });

    expect(store.data.sandbox?.accessToken).toBe("new-at");
    expect(store.data.sandbox?.companyUuid).toBeUndefined();
  });

  test("browser tab shows 'login complete' only after the token exchange succeeds", async () => {
    const store = memoryStore({ sandbox: { clientId: "cid", clientSecret: "sec" } });
    const { fetch: apiFetch } = mockFetch([
      { status: 200, body: { access_token: "user-at", refresh_token: "rt", expires_in: 7200 } },
      { status: 200, body: { resource: { type: "Company", uuid: "comp-1" } } },
    ]);

    const driver = driveCallback();
    await login("sandbox", {
      store,
      http: { baseUrl: "https://api.test", fetchImpl: apiFetch },
      browserAvailable: () => true,
      openBrowser: driver.openBrowser,
      print: () => {},
    });

    const res = await driver.response();
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("login complete");
  });

  test("a heartbeat line fires on each interval tick and stops once the callback resolves", async () => {
    const store = memoryStore({ sandbox: { clientId: "cid", clientSecret: "sec" } });
    const { fetch: apiFetch } = mockFetch([
      { status: 200, body: { access_token: "user-at", refresh_token: "rt", expires_in: 7200 } },
      { status: 200, body: { resource: { type: "Company", uuid: "comp-1" } } },
    ]);

    let intervalCallback: (() => void) | undefined;
    let cleared = false;
    const sentinelHandle = Symbol("handle");
    const fakeSetInterval = (cb: () => void): unknown => {
      intervalCallback = cb;
      return sentinelHandle;
    };
    const fakeClearInterval = (h: unknown): void => {
      if (h === sentinelHandle) cleared = true;
    };

    let mockNow = 1_000_000;
    const lines: string[] = [];

    // setTimeout(0) so login() has reached `await server.waitForCode()` and registered
    // setInterval before we fire ticks; a microtask would run too early.
    const openBrowser = (authorizeUrl: string): Promise<void> => {
      const u = new URL(authorizeUrl);
      const redirect = u.searchParams.get("redirect_uri") as string;
      const state = u.searchParams.get("state") as string;
      setTimeout(() => {
        mockNow += 12_000;
        intervalCallback?.();
        mockNow += 13_000;
        intervalCallback?.();
        void globalThis.fetch(`${redirect}?code=auth-code&state=${state}`);
      }, 0);
      return Promise.resolve();
    };

    await login("sandbox", {
      store,
      http: { baseUrl: "https://api.test", fetchImpl: apiFetch },
      browserAvailable: () => true,
      openBrowser,
      print: (l) => lines.push(l),
      now: () => mockNow,
      setInterval: fakeSetInterval,
      clearInterval: fakeClearInterval,
    });

    const heartbeats = lines.filter((l) => l.startsWith("Open the URL above"));
    expect(heartbeats).toHaveLength(2);
    expect(heartbeats[0]).toContain("(12s elapsed)");
    expect(heartbeats[1]).toContain("(25s elapsed)");
    expect(cleared).toBe(true);
  });

  test("heartbeat stops when the OAuth callback rejects, not just on success", async () => {
    const store = memoryStore({ sandbox: { clientId: "cid", clientSecret: "sec" } });
    const { fetch: apiFetch } = mockFetch([{ status: 400, body: { error: "invalid_grant" } }]);

    let cleared = false;
    const sentinelHandle = Symbol("handle");
    const fakeSetInterval = (): unknown => sentinelHandle;
    const fakeClearInterval = (h: unknown): void => {
      if (h === sentinelHandle) cleared = true;
    };

    await expect(
      login("sandbox", {
        store,
        http: { baseUrl: "https://api.test", fetchImpl: apiFetch },
        browserAvailable: () => true,
        openBrowser: driveCallback().openBrowser,
        print: () => {},
        setInterval: fakeSetInterval,
        clearInterval: fakeClearInterval,
      }),
    ).rejects.toThrow();

    expect(cleared).toBe(true);
  });

  test("browser tab shows a failure page when the token exchange returns non-200", async () => {
    const store = memoryStore({ sandbox: { clientId: "cid", clientSecret: "sec" } });
    const { fetch: apiFetch } = mockFetch([{ status: 400, body: { error: "invalid_grant" } }]);

    const driver = driveCallback();
    await expect(
      login("sandbox", {
        store,
        http: { baseUrl: "https://api.test", fetchImpl: apiFetch },
        browserAvailable: () => true,
        openBrowser: driver.openBrowser,
        print: () => {},
      }),
    ).rejects.toThrow();

    const res = await driver.response();
    const body = await res.text();
    expect(body).toContain("login failed");
    expect(body).not.toContain("login complete");
    expect(store.data.sandbox?.accessToken).toBeUndefined();
  });
});
