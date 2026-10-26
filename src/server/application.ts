import {
  Repository,
  HttpError,
  assert,
  textField,
  validTimeZone,
} from "./database";
import { SCHEDULER_VERSION } from "../shared/types";
import type { ReviewEvent, User } from "../shared/types";
import { handleImportRequest } from "../imports/handler";
import { detectMedia } from "../imports/content";
import { timingSafeEqual } from "node:crypto";
import { isSecureAccountOrigin } from "../shared/transport";

const SESSION_DAYS = 30;
const cookieValue = (request: Request, name: string) =>
  new RegExp(`(?:^|;\\s*)${name}=([^;]+)`).exec(
    request.headers.get("cookie") ?? "",
  )?.[1];
const sessionToken = (request: Request) =>
  cookieValue(request, "lll_session") ?? cookieValue(request, "recall_session");
const hash = (value: string) =>
  new Bun.CryptoHasher("sha256").update(value).digest("hex");
const token = () =>
  Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
const username = (value: unknown) => {
  const name = textField(value, "Username", 40, true);
  assert(
    /^[\p{L}\p{N}_.-]{3,40}$/u.test(name),
    "Username must contain 3–40 letters, numbers, dots, dashes or underscores.",
  );
  return name;
};
const password = (value: unknown) => {
  assert(
    typeof value === "string" && value.length >= 12 && value.length <= 256,
    "Use a password of 12–256 characters.",
  );
  return value;
};
const idPattern = /^[a-zA-Z0-9_-]{8,128}$/;

export interface ApplicationOptions {
  databasePath?: string;
  repository?: Repository;
  production?: boolean;
  publicOrigin?: string;
  bootstrapToken?: string;
  now?: () => number;
}

export function createApplication(options: ApplicationOptions = {}) {
  const production =
    options.production ?? process.env.NODE_ENV === "production";
  const publicOrigin = options.publicOrigin ?? process.env.PUBLIC_ORIGIN;
  const publicURL = publicOrigin ? new URL(publicOrigin) : undefined;
  if (
    publicURL &&
    (!isSecureAccountOrigin(publicURL) ||
      publicURL.username ||
      publicURL.password ||
      publicURL.pathname !== "/" ||
      publicURL.search ||
      publicURL.hash)
  )
    throw new Error(
      "PUBLIC_ORIGIN must be an HTTPS origin. HTTP is allowed only on localhost.",
    );
  const repo = options.repository ?? new Repository(options.databasePath);
  const bootstrapToken = options.bootstrapToken ?? process.env.BOOTSTRAP_TOKEN;
  const now = options.now ?? Date.now;
  let passwordOperations = 0;
  async function withPasswordSlot<T>(operation: () => Promise<T>): Promise<T> {
    assert(
      passwordOperations < 4,
      "The server is busy. Try signing in again shortly.",
      429,
    );
    passwordOperations++;
    try {
      return await operation();
    } finally {
      passwordOperations--;
    }
  }
  const hashPassword = (pass: string) =>
    withPasswordSlot(() =>
      Bun.password.hash(pass, {
        algorithm: "argon2id",
        memoryCost: 65536,
        timeCost: 3,
      }),
    );
  const secureCookie = (request: Request) =>
    production ||
    publicURL?.protocol === "https:" ||
    new URL(request.url).protocol === "https:";
  const sessionCookie = (request: Request, value: string, expires: number) =>
    `lll_session=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${expires}${secureCookie(request) ? "; Secure" : ""}`;

  function secureTransport(request: Request, url: URL): boolean {
    if (url.protocol === "https:") return true;
    if (url.protocol !== "http:") return false;
    // nginx terminates TLS and overwrites this header. Trust it only for the
    // configured HTTPS host; keep the app port private behind that proxy.
    if (publicURL?.protocol === "https:")
      return (
        url.host === publicURL.host &&
        request.headers.get("x-forwarded-proto") === "https"
      );
    return isSecureAccountOrigin(url);
  }

  async function json(request: Request) {
    assert(
      request.headers
        .get("content-type")
        ?.toLowerCase()
        .includes("application/json"),
      "Send JSON with Content-Type application/json.",
      415,
    );
    const raw = await request.text();
    assert(raw.length <= 2 * 1024 * 1024, "Request exceeds 2 MB.", 413);
    try {
      const value = JSON.parse(raw);
      assert(
        value && typeof value === "object" && !Array.isArray(value),
        "Send a JSON object.",
      );
      return value;
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(400, "Invalid JSON.");
    }
  }
  function currentUser(request: Request): User | null {
    const raw = sessionToken(request);
    if (!raw || raw.length > 200) return null;
    const row = repo.db
      .query("SELECT user_id FROM sessions WHERE hash=? AND expires_at>?")
      .get(hash(raw), now()) as { user_id: string } | null;
    return row ? repo.getUser(row.user_id) : null;
  }
  function loginResponse(request: Request, user: User, status = 200) {
    const raw = token();
    repo.db.query("DELETE FROM sessions WHERE expires_at<=?").run(now());
    repo.db
      .query("INSERT INTO sessions(hash,user_id,expires_at) VALUES(?,?,?)")
      .run(hash(raw), user.id, now() + SESSION_DAYS * 86400000);
    return Response.json(
      { user },
      {
        status,
        headers: {
          "Set-Cookie": sessionCookie(request, raw, SESSION_DAYS * 86400),
        },
      },
    );
  }
  function throttle(key: string) {
    const row = repo.db
      .query("SELECT failures,until_at FROM throttles WHERE key=?")
      .get(key) as { failures: number; until_at: number } | null;
    if (row && row.failures >= 8 && row.until_at > now())
      throw new HttpError(429, "Too many attempts. Try again in 15 minutes.");
  }
  function failure(key: string) {
    repo.db
      .query(
        "INSERT INTO throttles(key,failures,until_at) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET failures=CASE WHEN until_at<? THEN 1 ELSE failures+1 END,until_at=excluded.until_at",
      )
      .run(key, now() + 15 * 60000, now());
  }
  function successful(key: string) {
    repo.db.query("DELETE FROM throttles WHERE key=?").run(key);
  }

  function normalizeEvent(input: any): ReviewEvent {
    assert(
      input && typeof input === "object" && !Array.isArray(input),
      "Invalid review event.",
    );
    assert(
      typeof input.id === "string" && idPattern.test(input.id),
      "Invalid review identity.",
    );
    assert(
      typeof input.deviceId === "string" && idPattern.test(input.deviceId),
      "Invalid device identity.",
    );
    assert(
      typeof input.cardId === "string" && idPattern.test(input.cardId),
      "Invalid card identity.",
    );
    assert(
      input.kind === "review" || input.kind === "undo",
      "Invalid review event kind.",
    );
    assert(
      Number.isSafeInteger(input.sequence) && input.sequence >= 1,
      "Review sequence must be a positive integer.",
    );
    assert(
      [1, 2, 3, 4].includes(input.rating),
      "Choose Again, Hard, Good or Easy.",
    );
    assert(
      Number.isSafeInteger(input.reviewedAt) &&
        input.reviewedAt > 0 &&
        input.reviewedAt <= now() + 5 * 60000,
      "Review time is invalid or too far in the future.",
    );
    assert(
      Number.isFinite(input.durationMs) &&
        input.durationMs >= 0 &&
        input.durationMs <= 30 * 60000,
      "Review time spent must be between 0 and 30 minutes.",
    );
    assert(validTimeZone(input.timeZone), "Review timezone is invalid.");
    assert(
      typeof input.retention === "number" &&
        input.retention >= 0.7 &&
        input.retention <= 0.99,
      "Review retention is invalid.",
    );
    assert(
      input.schedulerVersion === SCHEDULER_VERSION,
      "This review uses an unsupported scheduler. Update the app before studying.",
      409,
    );
    const event: ReviewEvent = {
      id: input.id,
      kind: input.kind,
      deviceId: input.deviceId,
      sequence: input.sequence,
      cardId: input.cardId,
      rating: input.rating,
      reviewedAt: input.reviewedAt,
      durationMs: input.durationMs,
      timeZone: input.timeZone,
      retention: input.retention,
      schedulerVersion: input.schedulerVersion,
    };
    if (input.kind === "undo") {
      assert(
        typeof input.undoOf === "string" &&
          idPattern.test(input.undoOf) &&
          input.undoOf !== input.id,
        "Undo must identify a previous review.",
      );
      event.undoOf = input.undoOf;
    }
    return event;
  }
  function sync(userId: string, input: any) {
    assert(
      Number.isSafeInteger(input.cursor) && input.cursor >= 0,
      "Sync cursor must be a nonnegative integer.",
    );
    assert(
      Array.isArray(input.events) && input.events.length <= 1000,
      "Sync up to 1,000 review events at a time.",
    );
    const events = input.events.map(normalizeEvent);
    const acknowledged: string[] = [];
    repo.transaction(() => {
      const changed = new Set<string>();
      // Validate identities and append reviews before undos, irrespective of upload ordering.
      for (const event of [...events].sort(
        (a, b) => Number(a.kind === "undo") - Number(b.kind === "undo"),
      )) {
        const payload = JSON.stringify(event);
        const existing = repo.db
          .query("SELECT data FROM reviews WHERE user_id=? AND id=?")
          .get(userId, event.id) as { data: string } | null;
        if (existing) {
          assert(
            existing.data === payload,
            "A review identity was reused with different data.",
            409,
          );
          acknowledged.push(event.id);
          continue;
        }
        const sequence = repo.db
          .query(
            "SELECT id FROM reviews WHERE user_id=? AND device_id=? AND sequence=?",
          )
          .get(userId, event.deviceId, event.sequence);
        assert(
          !sequence,
          "A device sequence was reused. Keep the pending review and reconnect from its original device.",
          409,
        );
        // Tombstones remain available for delayed offline answers without restoring deleted cards.
        const card = repo.getCard(userId, event.cardId, true);
        assert(
          event.reviewedAt >= card.createdAt,
          "Review time predates this card. Check the device clock.",
        );
        if (event.kind === "undo") {
          const target = repo.db
            .query(
              "SELECT data FROM reviews WHERE user_id=? AND id=? AND card_id=?",
            )
            .get(userId, event.undoOf!, event.cardId) as {
            data: string;
          } | null;
          assert(target, "The review to undo was not found.");
          const original = JSON.parse(target.data) as ReviewEvent;
          assert(
            original.kind === "review" &&
              event.reviewedAt >= original.reviewedAt,
            "Undo must follow a review of the same card.",
          );
          const previous = (
            repo.db
              .query("SELECT data FROM reviews WHERE user_id=? AND card_id=?")
              .all(userId, event.cardId) as { data: string }[]
          ).map((r) => JSON.parse(r.data) as ReviewEvent);
          assert(
            !previous.some(
              (e) => e.kind === "undo" && e.undoOf === original.id,
            ),
            "This review has already been undone.",
            409,
          );
        }
        repo.db
          .query(
            "INSERT INTO reviews(id,user_id,card_id,device_id,sequence,data) VALUES(?,?,?,?,?,?)",
          )
          .run(
            event.id,
            userId,
            event.cardId,
            event.deviceId,
            event.sequence,
            payload,
          );
        acknowledged.push(event.id);
        changed.add(event.cardId);
      }
      for (const cardId of changed) repo.replayCard(userId, cardId);
      if (changed.size) repo.bump(userId);
    });
    return { ...repo.library(userId), acknowledged };
  }

  async function dispatch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;
    assert(path.startsWith("/api/"), "Route not found.", 404);
    assert(
      (path === "/api/health" && method === "GET") ||
        secureTransport(request, url),
      "Open this app over HTTPS to protect your account.",
      403,
    );
    if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
      const expected = publicOrigin ? new URL(publicOrigin).origin : url.origin;
      const origin = request.headers.get("origin");
      assert(
        !origin || origin === expected,
        "Request origin is not allowed.",
        403,
      );
      assert(
        request.headers.get("sec-fetch-site") !== "cross-site",
        "Cross-site requests are not allowed.",
        403,
      );
    }
    if (path === "/api/health" && method === "GET") {
      repo.db.query("SELECT 1").get();
      return Response.json({ status: "ok" });
    }
    if (path === "/api/auth/me" && method === "GET")
      return Response.json({
        user: currentUser(request),
        setupRequired: repo.userCount() === 0,
        browserSetupAllowed: !production || Boolean(bootstrapToken),
        bootstrapTokenRequired: Boolean(bootstrapToken),
      });
    if (path === "/api/auth/setup" && method === "POST") {
      assert(
        repo.userCount() === 0,
        "Initial setup has already been completed.",
        409,
      );
      assert(
        !production || bootstrapToken,
        "Create the first administrator with the admin command before exposing this server, or configure BOOTSTRAP_TOKEN for browser setup.",
        403,
      );
      const input = await json(request);
      if (bootstrapToken)
        assert(
          typeof input.bootstrapToken === "string" &&
            input.bootstrapToken.length <= 1000 &&
            timingSafeEqual(
              Buffer.from(hash(input.bootstrapToken)),
              Buffer.from(hash(bootstrapToken)),
            ),
          "A valid bootstrap token is required.",
          403,
        );
      const name = username(input.username);
      const pass = password(input.password);
      assert(
        validTimeZone(input.timeZone ?? "UTC"),
        "Choose a valid timezone.",
      );
      const passwordHash = await hashPassword(pass);
      const user = repo.transaction(() => {
        assert(
          repo.userCount() === 0,
          "Initial setup has already been completed.",
          409,
        );
        return repo.createUser(
          name,
          passwordHash,
          input.timeZone ?? "UTC",
          true,
        );
      });
      return loginResponse(request, user, 201);
    }
    if (path === "/api/auth/login" && method === "POST") {
      const input = await json(request);
      const name = username(input.username);
      const key = `login:${name.toLowerCase()}`;
      throttle(key);
      assert(
        typeof input.password === "string" && input.password.length <= 256,
        "Invalid username or password.",
        401,
      );
      const row = repo.userByName(name);
      failure(key);
      const valid = row
        ? await withPasswordSlot(() =>
            Bun.password.verify(input.password, row.password_hash),
          )
        : false;
      if (!valid) throw new HttpError(401, "Invalid username or password.");
      successful(key);
      return loginResponse(request, repo.publicUser(row!));
    }
    if (path === "/api/auth/register" && method === "POST") {
      const input = await json(request);
      const name = username(input.username);
      const pass = password(input.password);
      const rawInvite = textField(input.invite, "Invitation", 200, true);
      const key = `register:${hash(rawInvite)}`;
      throttle(key);
      assert(
        validTimeZone(input.timeZone ?? "UTC"),
        "Choose a valid timezone.",
      );
      const invite = repo.db
        .query(
          "SELECT id FROM invites WHERE hash=? AND used_at IS NULL AND expires_at>?",
        )
        .get(hash(rawInvite), now());
      if (!invite) {
        failure(key);
        throw new HttpError(
          400,
          "This invitation is invalid, expired or already used.",
        );
      }
      assert(!repo.userByName(name), "This username is already in use.", 409);
      const passwordHash = await hashPassword(pass);
      const user = repo.transaction(() => {
        const claim = repo.db
          .query(
            "UPDATE invites SET used_at=? WHERE hash=? AND used_at IS NULL AND expires_at>?",
          )
          .run(now(), hash(rawInvite), now());
        assert(
          claim.changes === 1,
          "This invitation is invalid, expired or already used.",
        );
        assert(!repo.userByName(name), "This username is already in use.", 409);
        return repo.createUser(name, passwordHash, input.timeZone ?? "UTC");
      });
      successful(key);
      return loginResponse(request, user, 201);
    }
    if (path === "/api/auth/logout" && method === "POST") {
      const account = currentUser(request);
      const expected = request.headers.get("X-Account-ID");
      if (account && expected && account.id !== expected)
        return Response.json(
          {
            error:
              "The signed-in account changed. Reloading your account safely.",
            code: "ACCOUNT_CHANGED",
          },
          { status: 409 },
        );
      for (const name of ["lll_session", "recall_session"]) {
        const raw = cookieValue(request, name);
        if (raw)
          repo.db.query("DELETE FROM sessions WHERE hash=?").run(hash(raw));
      }
      const headers = new Headers();
      headers.append("Set-Cookie", sessionCookie(request, "", 0));
      headers.append(
        "Set-Cookie",
        `recall_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secureCookie(request) ? "; Secure" : ""}`,
      );
      return Response.json({ ok: true }, { headers });
    }
    const user = currentUser(request);
    assert(user, "Sign in to continue.", 401);
    const expectedAccount = request.headers.get("X-Account-ID");
    if (expectedAccount && expectedAccount !== user.id)
      return Response.json(
        {
          error:
            "The signed-in account changed. Reloading your account safely.",
          code: "ACCOUNT_CHANGED",
        },
        { status: 409 },
      );
    if (path === "/api/library" && method === "GET")
      return Response.json(repo.library(user.id));
    if (path === "/api/preferences" && method === "PUT")
      return Response.json({
        user: repo.updatePreferences(user.id, await json(request)),
      });
    if (path === "/api/decks" && method === "POST")
      return Response.json(repo.createDeck(user.id, await json(request)), {
        status: 201,
      });
    const deckMatch = /^\/api\/decks\/([^/]+)$/.exec(path);
    if (deckMatch && method === "PUT")
      return Response.json(
        repo.updateDeck(user.id, deckMatch[1]!, await json(request)),
      );
    if (deckMatch && method === "DELETE") {
      repo.deleteDeck(user.id, deckMatch[1]!);
      return Response.json({ ok: true });
    }
    if (path === "/api/notes" && method === "POST")
      return Response.json(repo.createNote(user.id, await json(request)), {
        status: 201,
      });
    const noteMatch = /^\/api\/notes\/([^/]+)$/.exec(path);
    if (noteMatch && method === "PUT")
      return Response.json(
        repo.updateNote(user.id, noteMatch[1]!, await json(request)),
      );
    if (noteMatch && method === "DELETE") {
      repo.deleteNote(user.id, noteMatch[1]!);
      return Response.json({ ok: true });
    }
    const cardMatch = /^\/api\/cards\/([^/]+)$/.exec(path);
    if (cardMatch && method === "PATCH")
      return Response.json(
        repo.suspendCard(
          user.id,
          cardMatch[1]!,
          (await json(request)).suspended,
        ),
      );
    if (path === "/api/sync" && method === "POST")
      return Response.json(sync(user.id, await json(request)));
    if (path === "/api/media" && method === "POST") {
      const form = await request.formData();
      const file = form.get("file");
      assert(file instanceof File, "Choose a media file.");
      assert(file.size <= 25 * 1024 * 1024, "A media file exceeds 25 MB.", 413);
      const bytes = new Uint8Array(await file.arrayBuffer());
      let mime: string;
      try {
        mime = detectMedia(bytes, file.name).mime;
      } catch (error) {
        throw new HttpError(
          400,
          error instanceof Error
            ? error.message
            : "Choose a supported image or audio file.",
        );
      }
      const id = repo.putMedia(user.id, file.name, mime, bytes);
      return Response.json({ id, name: file.name, mime }, { status: 201 });
    }
    const mediaMatch = /^\/api\/media\/([^/]+)$/.exec(path);
    if (mediaMatch && method === "GET") {
      const media = repo.getMedia(user.id, mediaMatch[1]!);
      assert(media, "Media not found.", 404);
      return new Response(media.content as Uint8Array<ArrayBuffer>, {
        headers: {
          "Content-Type": media.mime,
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
          "Content-Disposition": `inline; filename="${media.name.replace(/[^a-zA-Z0-9_.-]/g, "_")}"`,
        },
      });
    }
    if (path.startsWith("/api/admin/")) {
      assert(user.admin, "Administrator access is required.", 403);
      if (path === "/api/admin/invites" && method === "GET")
        return Response.json({
          invites: repo.db
            .query(
              "SELECT id,created_at AS createdAt,expires_at AS expiresAt,used_at AS usedAt FROM invites WHERE created_by=? ORDER BY created_at DESC",
            )
            .all(user.id),
        });
      if (path === "/api/admin/invites" && method === "POST") {
        const raw = token();
        const invite = {
          id: crypto.randomUUID(),
          token: raw,
          createdAt: now(),
          expiresAt: now() + 7 * 86400000,
        };
        repo.db
          .query(
            "INSERT INTO invites(id,hash,created_by,expires_at,created_at) VALUES(?,?,?,?,?)",
          )
          .run(
            invite.id,
            hash(raw),
            user.id,
            invite.expiresAt,
            invite.createdAt,
          );
        return Response.json(
          { invite, token: raw, expiresAt: invite.expiresAt },
          { status: 201 },
        );
      }
      if (path === "/api/admin/reset-password" && method === "POST") {
        const input = await json(request);
        const row = repo.userByName(username(input.username));
        assert(row, "Account not found.", 404);
        const passwordHash = await hashPassword(password(input.password));
        repo.transaction(() => {
          repo.db
            .query("UPDATE users SET password_hash=? WHERE id=?")
            .run(passwordHash, row.id);
          repo.db.query("DELETE FROM sessions WHERE user_id=?").run(row.id);
        });
        return Response.json({ ok: true });
      }
    }
    const imported = await handleImportRequest(repo, request, user);
    if (imported) return imported;
    throw new HttpError(404, "API route not found.");
  }

  async function fetch(request: Request): Promise<Response> {
    const started = performance.now();
    let response: Response;
    try {
      response = await dispatch(request);
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      if (status === 500)
        console.error(
          JSON.stringify({
            level: "error",
            message: "Request failed",
            error: error instanceof Error ? error.message : "unknown",
          }),
        );
      response = Response.json(
        {
          error:
            status === 500
              ? "Something went wrong. Please try again."
              : (error as Error).message,
        },
        { status },
      );
    }
    response.headers.set("X-Content-Type-Options", "nosniff");
    response.headers.set("Referrer-Policy", "same-origin");
    const account = currentUser(request);
    if (account && !new URL(request.url).pathname.startsWith("/api/auth/"))
      response.headers.set("X-Account-ID", account.id);
    if (!response.headers.has("Cache-Control"))
      response.headers.set("Cache-Control", "no-store");
    if (production)
      console.info(
        JSON.stringify({
          method: request.method,
          path: new URL(request.url).pathname,
          status: response.status,
          durationMs: Math.round(performance.now() - started),
        }),
      );
    return response;
  }
  return { fetch, repo, close: () => repo.close() };
}
