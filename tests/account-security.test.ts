import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { api } from "../src/client";
import {
  createApplication,
  type ApplicationOptions,
} from "../src/server/application";

const applications: ReturnType<typeof createApplication>[] = [];
const locationDescriptor = Object.getOwnPropertyDescriptor(globalThis, "location");
afterEach(() => {
  for (const app of applications.splice(0)) app.close();
  if (locationDescriptor)
    Object.defineProperty(globalThis, "location", locationDescriptor);
  else Reflect.deleteProperty(globalThis, "location");
});

function application(options: ApplicationOptions = {}) {
  const app = createApplication({
    databasePath: ":memory:",
    production: false,
    ...options,
  });
  applications.push(app);
  return app;
}

function post(
  app: ReturnType<typeof createApplication>,
  path: string,
  body: unknown,
  origin = "https://cards.example.com",
  headers: Record<string, string> = {},
) {
  return app.fetch(
    new Request(`${origin}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    }),
  );
}

describe("account transport", () => {
  test("rejects remote HTTP configuration", () => {
    for (const publicOrigin of [
      "http://cards.example.com",
      "http://192.168.1.2:3000",
      "https://admin:secret@cards.example.com",
      "https://cards.example.com/path",
    ])
      expect(() => application({ publicOrigin })).toThrow("PUBLIC_ORIGIN");
  });

  test("rejects remote HTTP before reading passwords or using sessions", async () => {
    const app = application();
    for (const path of [
      "/api/auth/setup",
      "/api/auth/register",
      "/api/auth/login",
      "/api/admin/reset-password",
    ]) {
      const request = new Request(`http://cards.example.com${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Forwarded-Proto": "https",
        },
        body: "invalid JSON that must not be parsed",
      });
      const response = await app.fetch(request);
      expect(response.status).toBe(403);
      expect(request.bodyUsed).toBe(false);
      expect(response.headers.has("set-cookie")).toBe(false);
      expect(response.headers.get("cache-control")).toBe("no-store");
    }
    expect(
      (await app.fetch(new Request("http://cards.example.com/api/auth/me")))
        .status,
    ).toBe(403);
    expect(app.repo.userCount()).toBe(0);
  });

  test("accepts only the configured HTTPS proxy host and a single HTTPS protocol", async () => {
    const app = application({ publicOrigin: "https://cards.example.com" });
    for (const [origin, protocol] of [
      ["http://cards.example.com", ""],
      ["http://cards.example.com", "http"],
      ["http://cards.example.com", "https, http"],
      ["http://other.example.com", "https"],
      ["http://localhost", "https"],
    ]) {
      const response = await post(app, "/api/auth/setup", {}, origin, {
        "X-Forwarded-Proto": protocol!,
      });
      expect(response.status).toBe(403);
    }
    const response = await post(
      app,
      "/api/auth/setup",
      { username: "admin", password: "correct-horse-battery" },
      "http://cards.example.com",
      { "X-Forwarded-Proto": "https", Origin: "https://cards.example.com" },
    );
    expect(response.status).toBe(201);
    expect(response.headers.get("set-cookie")).toContain("; Secure");
    expect(
      (await app.fetch(new Request("http://localhost:3000/api/health"))).status,
    ).toBe(200);
  });

  test("keeps local development available and secures direct HTTPS cookies", async () => {
    const app = application();
    for (const origin of [
      "http://localhost:3000",
      "http://127.0.0.1:3000",
      "http://[::1]:3000",
    ])
      expect(
        (await app.fetch(new Request(`${origin}/api/auth/me`))).status,
      ).toBe(200);
    const response = await post(app, "/api/auth/setup", {
      username: "admin",
      password: "correct-horse-battery",
    });
    const cookie = response.headers.get("set-cookie")!;
    expect(cookie).toContain("; Secure");
    expect(cookie).toContain("; HttpOnly");
    expect(cookie).toContain("; SameSite=Lax");
    const logout = await post(app, "/api/auth/logout", {}, undefined, {
      Cookie: cookie.split(";")[0]!,
    });
    expect(logout.headers.getSetCookie()).toHaveLength(2);
    for (const expired of logout.headers.getSetCookie()) {
      expect(expired).toContain("; Secure");
      expect(expired).toContain("Max-Age=0");
    }
  });

  test("browser blocks passwords on remote HTTP and foreign origins before fetching", async () => {
    const fetch = spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ ok: true }),
    );
    try {
      Object.defineProperty(globalThis, "location", {
        value: new URL("http://cards.example.com/"),
        configurable: true,
      });
      for (const path of ["/api/auth/login", "/api/admin/reset-password"])
        await expect(
          api(path, {
            method: "POST",
            body: JSON.stringify({ password: "never-send-this-password" }),
          }),
        ).rejects.toMatchObject({ code: "INSECURE_TRANSPORT" });
      Object.defineProperty(globalThis, "location", {
        value: new URL("https://cards.example.com/"),
        configurable: true,
      });
      await expect(
        api("https://other.example.com/api/auth/login", { method: "POST" }),
      ).rejects.toMatchObject({ code: "INVALID_API_ORIGIN" });
      expect(fetch).not.toHaveBeenCalled();

      await api("/api/auth/login", { method: "POST", body: "{}" });
      expect(fetch).toHaveBeenCalledWith(
        "/api/auth/login",
        expect.objectContaining({
          credentials: "same-origin",
          cache: "no-store",
          redirect: "error",
        }),
      );
    } finally {
      fetch.mockRestore();
    }
  });
});

test("stores salted Argon2id hashes and revokes sessions on password reset", async () => {
  const app = application();
  const password = "correct-horse-battery";
  const replacement = "a-different-long-password";
  const setup = await post(app, "/api/auth/setup", {
    username: "admin",
    password,
  });
  expect(setup.status).toBe(201);
  const cookie = setup.headers.get("set-cookie")!.split(";")[0]!;
  const adminBody = await setup.text();
  expect(adminBody).not.toContain(password);
  expect(adminBody).not.toContain("password_hash");
  const invitation = await post(app, "/api/admin/invites", {}, undefined, {
    Cookie: cookie,
  });
  const { invite } = (await invitation.json()) as { invite: { token: string } };
  const registered = await post(app, "/api/auth/register", {
    username: "guest",
    password,
    invite: invite.token,
  });
  expect(registered.status).toBe(201);
  const admin = app.repo.userByName("admin")!;
  const guest = app.repo.userByName("guest")!;
  for (const row of [admin, guest]) {
    expect(row.password_hash).toStartWith("$argon2id$v=19$m=65536,t=3,p=1$");
    expect(row.password_hash).not.toContain(password);
    expect(await Bun.password.verify(password, row.password_hash)).toBe(true);
  }
  expect(admin.password_hash).not.toBe(guest.password_hash);
  const guestCookie = registered.headers.get("set-cookie")!.split(";")[0]!;
  const session = app.repo.db
    .query("SELECT hash FROM sessions WHERE user_id=?")
    .get(guest.id) as { hash: string };
  expect(session.hash).not.toBe(guestCookie.slice("lll_session=".length));
  expect(session.hash).toMatch(/^[a-f0-9]{64}$/);

  const reset = await post(
    app,
    "/api/admin/reset-password",
    { username: "guest", password: replacement },
    undefined,
    { Cookie: cookie },
  );
  expect(reset.status).toBe(200);
  expect(await reset.text()).not.toContain(replacement);
  const updated = app.repo.userByName("guest")!;
  expect(updated.password_hash).not.toBe(guest.password_hash);
  expect(await Bun.password.verify(replacement, updated.password_hash)).toBe(true);
  const me = await app.fetch(
    new Request("https://cards.example.com/api/auth/me", {
      headers: { Cookie: guestCookie },
    }),
  );
  expect(await me.json()).toMatchObject({ user: null });
  expect(
    (await post(app, "/api/auth/login", { username: "guest", password }))
      .status,
  ).toBe(401);
  expect(
    (
      await post(app, "/api/auth/login", {
        username: "guest",
        password: replacement,
      })
    ).status,
  ).toBe(200);
});
