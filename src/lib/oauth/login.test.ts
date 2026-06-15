import { describe, expect, test } from "bun:test";
import { companyUuidFromTokenInfo, formatUrlForTerminal, login, openOrPrint } from "./login.ts";
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
      const m = l.match(/(https?:\/\/\S+\/oauth\/authorize\S*)/);
      if (m) {
        const u = new URL(m[1]);
        void globalThis.fetch(`${u.searchParams.get("redirect_uri")}?code=c&state=${u.searchParams.get("state")}`);
      }
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
      openBrowser: driver.openBrowser,
      print: () => {},
    });

    const res = await driver.response();
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("login complete");
  });

  test("browser tab shows a failure page when the token exchange returns non-200", async () => {
    const store = memoryStore({ sandbox: { clientId: "cid", clientSecret: "sec" } });
    const { fetch: apiFetch } = mockFetch([{ status: 400, body: { error: "invalid_grant" } }]);

    const driver = driveCallback();
    await expect(
      login("sandbox", {
        store,
        http: { baseUrl: "https://api.test", fetchImpl: apiFetch },
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
