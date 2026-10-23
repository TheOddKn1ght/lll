import { afterEach, describe, expect, test } from "bun:test";
import { createApplication } from "../src/server/application";
import { SCHEDULER_VERSION } from "../src/shared/types";
import type { Card, ReviewEvent } from "../src/shared/types";

const applications: ReturnType<typeof createApplication>[] = [];
afterEach(() => {
  for (const app of applications.splice(0)) app.close();
});

function fixture() {
  const app = createApplication({
    databasePath: ":memory:",
    production: false,
  });
  applications.push(app);
  const user = app.repo.createUser("learner", "unused", "UTC", true);
  const raw = "test-session-token";
  const hash = new Bun.CryptoHasher("sha256").update(raw).digest("hex");
  app.repo.db
    .query("INSERT INTO sessions(hash,user_id,expires_at) VALUES(?,?,?)")
    .run(hash, user.id, Date.now() + 60000);
  const cookie = `lll_session=${raw}`;
  const call = async (
    path: string,
    method = "GET",
    body?: unknown,
    headers: Record<string, string> = {},
  ) => {
    const response = await app.fetch(
      new Request(`http://localhost${path}`, {
        method,
        headers: {
          cookie,
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
          ...headers,
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      }),
    );
    return { response, data: (await response.json()) as any };
  };
  const deck = app.repo.createDeck(user.id, { name: "Words" });
  const { note, cards } = app.repo.createNote(user.id, {
    deckId: deck.id,
    type: "basic",
    front: "hello",
    back: "hola",
  });
  return { app, user, call, deck, note, card: cards[0]! };
}

function event(card: Card, input: Partial<ReviewEvent> = {}): ReviewEvent {
  return {
    id: crypto.randomUUID(),
    kind: "review",
    cardId: card.id,
    deviceId: "device-alpha",
    sequence: 1,
    rating: 3,
    reviewedAt: Math.max(Date.now(), card.createdAt),
    durationMs: 1500,
    timeZone: "UTC",
    retention: 0.9,
    schedulerVersion: SCHEDULER_VERSION,
    ...input,
  };
}

describe("private account API", () => {
  test("keeps legacy sessions valid and clears both cookie names on logout", async () => {
    const { call, user } = fixture();
    const legacyHeaders = { cookie: "recall_session=test-session-token" };
    const authenticated = await call(
      "/api/auth/me",
      "GET",
      undefined,
      legacyHeaders,
    );
    expect(authenticated.data.user.id).toBe(user.id);

    const loggedOut = await call("/api/auth/logout", "POST", {}, legacyHeaders);
    expect(loggedOut.response.status).toBe(200);
    const cookies = loggedOut.response.headers.getSetCookie();
    expect(cookies).toHaveLength(2);
    expect(
      cookies.some(
        (cookie) =>
          cookie.startsWith("lll_session=;") && cookie.includes("Max-Age=0"),
      ),
    ).toBe(true);
    expect(
      cookies.some(
        (cookie) =>
          cookie.startsWith("recall_session=;") && cookie.includes("Max-Age=0"),
      ),
    ).toBe(true);
    expect(
      (await call("/api/auth/me", "GET", undefined, legacyHeaders)).data.user,
    ).toBeNull();
  });

  test("protects initial administrator setup in production", async () => {
    const app = createApplication({
      databasePath: ":memory:",
      production: true,
      bootstrapToken: "",
    });
    applications.push(app);
    const response = await app.fetch(
      new Request("http://localhost/api/auth/setup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: "admin",
          password: "correct-horse-battery",
        }),
      }),
    );
    expect(response.status).toBe(403);
    expect(app.repo.userCount()).toBe(0);
    const gated = createApplication({
      databasePath: ":memory:",
      production: true,
      bootstrapToken: "test-bootstrap-secret",
    });
    applications.push(gated);
    const invalid = await gated.fetch(
      new Request("http://localhost/api/auth/setup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: "admin",
          password: "correct-horse-battery",
          bootstrapToken: "wrong-secret",
        }),
      }),
    );
    expect(invalid.status).toBe(403);
    expect(gated.repo.userCount()).toBe(0);
  });

  test("bootstraps one administrator, logs in, and atomically consumes invitations", async () => {
    const app = createApplication({ databasePath: ":memory:" });
    applications.push(app);
    const request = (path: string, body: any, cookie = "") =>
      app.fetch(
        new Request(`http://localhost${path}`, {
          method: "POST",
          headers: { "Content-Type": "application/json", cookie },
          body: JSON.stringify(body),
        }),
      );
    expect(
      await (
        await app.fetch(new Request("http://localhost/api/auth/me"))
      ).json(),
    ).toMatchObject({ user: null, setupRequired: true });
    const setup = await request("/api/auth/setup", {
      username: "admin",
      password: "correct-horse-battery",
      timeZone: "Europe/Moscow",
    });
    expect(setup.status).toBe(201);
    const firstCookie = setup.headers.get("set-cookie")!.split(";")[0]!;
    const secondSetup = await request("/api/auth/setup", {
      username: "other",
      password: "correct-horse-battery",
    });
    expect(secondSetup.status).toBe(409);
    const invitation = await request("/api/admin/invites", {}, firstCookie);
    const token = ((await invitation.json()) as any).invite.token;
    const registered = await request("/api/auth/register", {
      username: "guest",
      password: "correct-horse-battery",
      invite: token,
      timeZone: "UTC",
    });
    expect(registered.status).toBe(201);
    expect(
      (
        await request("/api/auth/register", {
          username: "guest2",
          password: "correct-horse-battery",
          invite: token,
          timeZone: "UTC",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await request("/api/auth/login", {
          username: "GUEST",
          password: "correct-horse-battery",
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await request("/api/auth/login", {
          username: "guest",
          password: "incorrect",
        })
      ).status,
    ).toBe(401);
  });

  test("isolates decks, cards, media, reviews, and administrator operations", async () => {
    const { app, call, user } = fixture();
    const other = app.repo.createUser("private", "unused", "UTC");
    const deck = app.repo.createDeck(other.id, { name: "Private" });
    const { cards } = app.repo.createNote(other.id, {
      deckId: deck.id,
      type: "basic",
      front: "secret",
      back: "private",
    });
    const mediaId = app.repo.putMedia(
      other.id,
      "test.png",
      "image/png",
      new Uint8Array([1, 2, 3]),
    );
    expect(
      (await call(`/api/decks/${deck.id}`, "PUT", { name: "stolen" })).response
        .status,
    ).toBe(404);
    expect((await call(`/api/media/${mediaId}`)).response.status).toBe(404);
    expect(
      (
        await call("/api/sync", "POST", {
          cursor: 0,
          events: [event(cards[0]!)],
        })
      ).response.status,
    ).toBe(404);
    const library = (await call("/api/library")).data;
    expect(library.decks.every((d: any) => d.id !== deck.id)).toBe(true);
    expect(app.repo.library(user.id).reviews).toHaveLength(0);
    expect(
      (await app.fetch(new Request("http://localhost/api/library"))).status,
    ).toBe(401);
  });

  test("rejects cross-site mutations, invalid preferences, deck cycles and unsupported routes", async () => {
    const { call, deck } = fixture();
    expect(
      (
        await call(
          "/api/decks",
          "POST",
          { name: "Bad" },
          { origin: "https://other.example" },
        )
      ).response.status,
    ).toBe(403);
    expect(
      (await call("/api/preferences", "PUT", { timeZone: "Not/AZone" }))
        .response.status,
    ).toBe(400);
    expect(
      (await call("/api/preferences", "PUT", { retention: 1.2 })).response
        .status,
    ).toBe(400);
    const child = (
      await call("/api/decks", "POST", { name: "Child", parentId: deck.id })
    ).data;
    expect(
      (await call(`/api/decks/${deck.id}`, "PUT", { parentId: child.id }))
        .response.status,
    ).toBe(400);
    expect((await call("/api/not-real")).response.status).toBe(404);
  });

  test("binds private responses and mutations to the account captured by the caller", async () => {
    const { app, user, call } = fixture();
    const other = app.repo.createUser("other", "unused", "UTC");
    for (const [path, method, body] of [
      ["/api/library", "GET", undefined],
      ["/api/decks", "POST", { name: "Wrong account" }],
      ["/api/sync", "POST", { cursor: 0, events: [] }],
      ["/api/auth/logout", "POST", undefined],
    ] as const) {
      const rejected = await call(path, method, body, {
        "X-Account-ID": other.id,
      });
      expect(rejected.response.status).toBe(409);
      expect(rejected.data.code).toBe("ACCOUNT_CHANGED");
    }
    const accepted = await call("/api/library", "GET", undefined, {
      "X-Account-ID": user.id,
    });
    expect(accepted.response.status).toBe(200);
    expect(accepted.response.headers.get("X-Account-ID")).toBe(user.id);
    expect(app.repo.library(user.id).decks).toHaveLength(1);
  });
});

describe("durable review synchronization", () => {
  test("acknowledges retries once and rejects identity or sequence reuse atomically", async () => {
    const { call, card } = fixture();
    const review = event(card);
    const first = await call("/api/sync", "POST", {
      cursor: 0,
      events: [review],
    });
    expect(first.response.status).toBe(200);
    expect(first.data.acknowledged).toEqual([review.id]);
    expect(first.data.cards[0].state.reps).toBe(1);
    const retry = await call("/api/sync", "POST", {
      cursor: first.data.cursor,
      events: [review],
    });
    expect(retry.data.reviews).toHaveLength(1);
    expect(retry.data.cursor).toBe(first.data.cursor);
    expect(
      (
        await call("/api/sync", "POST", {
          cursor: 0,
          events: [{ ...review, rating: 1 }],
        })
      ).response.status,
    ).toBe(409);
    expect(
      (
        await call("/api/sync", "POST", {
          cursor: 0,
          events: [{ ...review, id: crypto.randomUUID() }],
        })
      ).response.status,
    ).toBe(409);
    const valid = event(card, { sequence: 2 });
    const invalid = event(card, {
      sequence: 3,
      reviewedAt: Date.now() + 3600000,
    });
    expect(
      (await call("/api/sync", "POST", { cursor: 0, events: [valid, invalid] }))
        .response.status,
    ).toBe(400);
    expect((await call("/api/library")).data.reviews).toHaveLength(1);
  });

  test("replays disconnected device reviews deterministically regardless of arrival order", async () => {
    const first = fixture();
    const second = fixture();
    const start = Math.max(first.card.createdAt, second.card.createdAt);
    const a = event(first.card, {
      reviewedAt: start,
      deviceId: "device-alpha",
      rating: 2,
    });
    const b = event(first.card, {
      reviewedAt: start + 1000,
      deviceId: "device-bravo",
      rating: 4,
    });
    await first.call("/api/sync", "POST", { cursor: 0, events: [b] });
    const left = await first.call("/api/sync", "POST", {
      cursor: 0,
      events: [a],
    });
    const right = await second.call("/api/sync", "POST", {
      cursor: 0,
      events: [
        { ...a, cardId: second.card.id },
        { ...b, cardId: second.card.id },
      ],
    });
    expect(left.data.cards[0].state).toEqual(right.data.cards[0].state);
    expect(left.data.reviews).toHaveLength(2);
  });

  test("undo restores the prior schedule and cannot undo twice or cross cards", async () => {
    const { call, card } = fixture();
    const review = event(card);
    await call("/api/sync", "POST", { cursor: 0, events: [review] });
    const undo = event(card, { kind: "undo", sequence: 2, undoOf: review.id });
    const result = await call("/api/sync", "POST", {
      cursor: 0,
      events: [undo],
    });
    expect(result.response.status).toBe(200);
    expect(result.data.cards[0].state.reps).toBe(0);
    expect(
      (
        await call("/api/sync", "POST", {
          cursor: 0,
          events: [{ ...undo, id: crypto.randomUUID(), sequence: 3 }],
        })
      ).response.status,
    ).toBe(409);
    expect(result.data.reviews).toHaveLength(2);
  });

  test("preserves history and accepts late offline reviews without resurrecting deleted content", async () => {
    const { call, card, deck } = fixture();
    const review = event(card);
    await call("/api/sync", "POST", { cursor: 0, events: [review] });
    await call(`/api/decks/${deck.id}`, "DELETE");
    const late = event(card, {
      deviceId: "device-bravo",
      reviewedAt: Date.now() + 100,
    });
    const result = await call("/api/sync", "POST", {
      cursor: 0,
      events: [late],
    });
    expect(result.response.status).toBe(200);
    expect(result.data.cards).toHaveLength(0);
    expect(result.data.notes).toHaveLength(0);
    expect(result.data.decks).toHaveLength(0);
    expect(result.data.reviews).toHaveLength(2);
  });

  test("edits wording without resetting progress and tombstones obsolete reverse variants", async () => {
    const { app, user, call, note, card } = fixture();
    await call("/api/sync", "POST", { cursor: 0, events: [event(card)] });
    const changed = await call(`/api/notes/${note.id}`, "PUT", {
      front: "greetings",
      type: "reverse",
    });
    expect(changed.data.cards).toHaveLength(2);
    expect(
      changed.data.cards.find((c: Card) => c.id === card.id).state.reps,
    ).toBe(1);
    await call(`/api/notes/${note.id}`, "PUT", { type: "basic" });
    expect(app.repo.library(user.id).cards).toHaveLength(1);
    expect(app.repo.library(user.id).reviews).toHaveLength(1);
  });
});
