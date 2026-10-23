import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { resolveDatabasePath } from "./paths";
import { cardVariants, createCardState, replayCard } from "../shared/scheduler";
import { DEFAULT_PREFERENCES } from "../shared/types";
import type {
  Card,
  Deck,
  ImportNote,
  Library,
  Note,
  Preferences,
  ReviewEvent,
  User,
} from "../shared/types";

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export function assert(
  value: unknown,
  message: string,
  status = 400,
): asserts value {
  if (!value) throw new HttpError(status, message);
}

export function textField(
  value: unknown,
  label: string,
  max = 10_000,
  required = false,
): string {
  assert(typeof value === "string", `${label} must be text.`);
  const result = value.trim();
  assert(
    result.length <= max && (!required || result.length > 0),
    `${label} must contain ${required ? "1–" : "at most "}${max} characters.`,
  );
  return result;
}

export function validTimeZone(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 100) return false;
  try {
    new Intl.DateTimeFormat("en", { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

export function preferences(
  input: unknown,
  base: Preferences = DEFAULT_PREFERENCES,
): Preferences {
  assert(
    input && typeof input === "object" && !Array.isArray(input),
    "Preferences must be an object.",
  );
  const result = { ...base, ...input } as Preferences;
  assert(validTimeZone(result.timeZone), "Choose a valid timezone.");
  assert(
    Number.isInteger(result.newCardsPerDay) &&
      result.newCardsPerDay >= 0 &&
      result.newCardsPerDay <= 1000,
    "New cards must be between 0 and 1,000.",
  );
  assert(
    typeof result.retention === "number" &&
      result.retention >= 0.7 &&
      result.retention <= 0.99,
    "Retention must be between 0.70 and 0.99.",
  );
  assert(
    Number.isInteger(result.dailyGoal) &&
      result.dailyGoal >= 1 &&
      result.dailyGoal <= 10000,
    "Daily goal must be between 1 and 10,000.",
  );
  assert(
    ["system", "light", "dark"].includes(result.theme),
    "Choose a valid theme.",
  );
  assert(
    typeof result.typedAnswers === "boolean",
    "Typed answers must be true or false.",
  );
  return {
    timeZone: result.timeZone,
    newCardsPerDay: result.newCardsPerDay,
    retention: result.retention,
    dailyGoal: result.dailyGoal,
    theme: result.theme,
    typedAnswers: result.typedAnswers,
  };
}

type Row = Record<string, any>;
export class Repository {
  readonly db: Database;
  constructor(path = resolveDatabasePath(process.env.DATABASE_PATH)) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path, { create: true, strict: true });
    this.db.exec(
      "PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;",
    );
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE COLLATE NOCASE, password_hash TEXT NOT NULL, admin INTEGER NOT NULL DEFAULT 0, preferences TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions (hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS invites (id TEXT PRIMARY KEY, hash TEXT NOT NULL UNIQUE, created_by TEXT NOT NULL REFERENCES users(id), expires_at INTEGER NOT NULL, used_at INTEGER, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS cursors (user_id TEXT PRIMARY KEY REFERENCES users(id), revision INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS decks (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), parent_id TEXT, data TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS decks_owner ON decks(user_id, deleted);
      CREATE TABLE IF NOT EXISTS notes (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), deck_id TEXT NOT NULL REFERENCES decks(id), data TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS notes_owner ON notes(user_id, deleted);
      CREATE TABLE IF NOT EXISTS cards (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), note_id TEXT NOT NULL REFERENCES notes(id), data TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS cards_owner ON cards(user_id, deleted);
      CREATE TABLE IF NOT EXISTS reviews (id TEXT NOT NULL, user_id TEXT NOT NULL REFERENCES users(id), card_id TEXT NOT NULL REFERENCES cards(id), device_id TEXT NOT NULL, sequence INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(user_id, id), UNIQUE(user_id, device_id, sequence));
      CREATE INDEX IF NOT EXISTS reviews_card ON reviews(user_id, card_id);
      CREATE TABLE IF NOT EXISTS media (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), name TEXT NOT NULL, mime TEXT NOT NULL, content BLOB NOT NULL);
      CREATE INDEX IF NOT EXISTS media_owner ON media(user_id);
      CREATE TABLE IF NOT EXISTS throttles (key TEXT PRIMARY KEY, failures INTEGER NOT NULL, until_at INTEGER NOT NULL);
      INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES(1, unixepoch() * 1000);
    `);
  }
  close() {
    this.db.close();
  }
  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn).immediate();
  }
  bump(userId: string) {
    this.db
      .query(
        "INSERT INTO cursors(user_id, revision) VALUES(?, 1) ON CONFLICT(user_id) DO UPDATE SET revision=revision+1",
      )
      .run(userId);
  }
  userCount() {
    return (this.db.query("SELECT COUNT(*) AS count FROM users").get() as Row)
      .count as number;
  }
  getUser(id: string): User | null {
    const r = this.db
      .query("SELECT * FROM users WHERE id=?")
      .get(id) as Row | null;
    return r ? this.publicUser(r) : null;
  }
  publicUser(row: Row): User {
    return {
      id: row.id,
      username: row.username,
      admin: Boolean(row.admin),
      preferences: JSON.parse(row.preferences),
    };
  }
  userByName(name: string) {
    return this.db
      .query("SELECT * FROM users WHERE username=? COLLATE NOCASE")
      .get(name) as Row | null;
  }
  createUser(
    username: string,
    passwordHash: string,
    timeZone: string,
    admin = false,
  ): User {
    const user: User = {
      id: crypto.randomUUID(),
      username,
      admin,
      preferences: preferences({ timeZone }),
    };
    this.db
      .query(
        "INSERT INTO users(id, username, password_hash, admin, preferences, created_at) VALUES(?, ?, ?, ?, ?, ?)",
      )
      .run(
        user.id,
        username,
        passwordHash,
        admin ? 1 : 0,
        JSON.stringify(user.preferences),
        Date.now(),
      );
    this.bump(user.id);
    return user;
  }
  updatePreferences(userId: string, input: unknown) {
    const user = this.getUser(userId)!;
    user.preferences = preferences(input, user.preferences);
    this.db
      .query("UPDATE users SET preferences=? WHERE id=?")
      .run(JSON.stringify(user.preferences), userId);
    this.bump(userId);
    return user;
  }
  getDeck(userId: string, id: string): Deck {
    assert(typeof id === "string" && id.length <= 128, "Choose a valid deck.");
    const row = this.db
      .query("SELECT data FROM decks WHERE id=? AND user_id=? AND deleted=0")
      .get(id, userId) as Row | null;
    assert(row, "Deck not found.", 404);
    return JSON.parse(row.data);
  }
  createDeck(userId: string, input: any): Deck {
    assert(input && typeof input === "object", "Deck details are required.");
    const parentId = input.parentId || null;
    if (parentId) {
      assert(typeof parentId === "string", "Invalid parent deck.");
      this.getDeck(userId, parentId);
    }
    const now = Date.now();
    const deck: Deck = {
      id: crypto.randomUUID(),
      name: textField(input.name, "Deck name", 160, true),
      description: textField(input.description ?? "", "Description", 5000),
      color: textField(input.color ?? "#6d5ce7", "Color", 30),
      parentId,
      createdAt: now,
      updatedAt: now,
    };
    assert(
      /^#[0-9a-fA-F]{6}$/.test(deck.color),
      "Choose a six-digit hex color.",
    );
    this.db
      .query("INSERT INTO decks(id,user_id,parent_id,data) VALUES(?,?,?,?)")
      .run(deck.id, userId, parentId, JSON.stringify(deck));
    this.bump(userId);
    return deck;
  }
  updateDeck(userId: string, id: string, input: any): Deck {
    assert(
      input && typeof input === "object" && !Array.isArray(input),
      "Deck details are required.",
    );
    const old = this.getDeck(userId, id);
    const next = {
      ...old,
      ...input,
      id: old.id,
      createdAt: old.createdAt,
      updatedAt: Date.now(),
    };
    next.name = textField(next.name, "Deck name", 160, true);
    next.description = textField(next.description, "Description", 5000);
    assert(
      typeof next.color === "string" && /^#[0-9a-fA-F]{6}$/.test(next.color),
      "Choose a six-digit hex color.",
    );
    if (next.parentId) {
      let parent: Deck | null = this.getDeck(userId, next.parentId);
      const seen = new Set([id]);
      while (parent) {
        assert(!seen.has(parent.id), "A deck cannot contain itself.");
        seen.add(parent.id);
        parent = parent.parentId ? this.getDeck(userId, parent.parentId) : null;
      }
    } else next.parentId = null;
    this.db
      .query("UPDATE decks SET parent_id=?,data=? WHERE id=? AND user_id=?")
      .run(next.parentId, JSON.stringify(next), id, userId);
    this.bump(userId);
    return next;
  }
  deleteDeck(userId: string, id: string) {
    this.getDeck(userId, id);
    this.transaction(() => {
      const deckIds = new Set([id]);
      const all = this.library(userId).decks;
      let added = true;
      while (added) {
        added = false;
        for (const deck of all)
          if (
            deck.parentId &&
            deckIds.has(deck.parentId) &&
            !deckIds.has(deck.id)
          ) {
            deckIds.add(deck.id);
            added = true;
          }
      }
      for (const deckId of deckIds) {
        for (const note of this.db
          .query(
            "SELECT id FROM notes WHERE user_id=? AND deck_id=? AND deleted=0",
          )
          .all(userId, deckId) as Row[])
          this.deleteNote(userId, note.id);
        this.db
          .query("UPDATE decks SET deleted=1 WHERE id=? AND user_id=?")
          .run(deckId, userId);
      }
      this.bump(userId);
    });
  }
  getNote(userId: string, id: string): Note {
    assert(typeof id === "string" && id.length <= 128, "Choose a valid note.");
    const row = this.db
      .query("SELECT data FROM notes WHERE id=? AND user_id=? AND deleted=0")
      .get(id, userId) as Row | null;
    assert(row, "Note not found.", 404);
    return JSON.parse(row.data);
  }
  validateNote(userId: string, input: any, old?: Note): Note {
    assert(input && typeof input === "object", "Note details are required.");
    const data = { ...old, ...input };
    this.getDeck(userId, data.deckId);
    assert(
      ["basic", "reverse", "cloze", "vocabulary"].includes(data.type),
      "Choose a supported card type.",
    );
    assert(
      Array.isArray(data.tags ?? []) &&
        (data.tags ?? []).length <= 100 &&
        (data.tags ?? []).every(
          (tag: unknown) => typeof tag === "string" && tag.length <= 80,
        ),
      "Tags must be a list of up to 100 short names.",
    );
    const now = Date.now();
    const note: Note = {
      id: old?.id || crypto.randomUUID(),
      deckId: data.deckId,
      type: data.type,
      front: textField(data.front, "Front", 100000, true),
      back: textField(data.back ?? "", "Back", 100000, data.type !== "cloze"),
      example: textField(data.example ?? "", "Example", 100000),
      tags: [...new Set<string>(data.tags ?? [])],
      sourceLang: textField(data.sourceLang ?? "", "Source language", 50),
      targetLang: textField(data.targetLang ?? "", "Target language", 50),
      createdAt: old?.createdAt ?? now,
      updatedAt: now,
    };
    if (data.sourceId)
      note.sourceId = textField(data.sourceId, "Source identity", 1000);
    if (note.type === "cloze")
      assert(
        /\{\{c\d+::[\s\S]+?\}\}/.test(note.front),
        "Cloze cards need a deletion such as {{c1::word}}.",
      );
    assert(
      cardVariants(note).length > 0 && cardVariants(note).length <= 100,
      "A note must generate between 1 and 100 cards.",
    );
    return note;
  }
  createNote(userId: string, input: any): { note: Note; cards: Card[] } {
    return this.transaction(() => {
      const note = this.validateNote(userId, input);
      this.db
        .query("INSERT INTO notes(id,user_id,deck_id,data) VALUES(?,?,?,?)")
        .run(note.id, userId, note.deckId, JSON.stringify(note));
      const cards = this.regenerateCards(userId, note);
      this.bump(userId);
      return { note, cards };
    });
  }
  updateNote(
    userId: string,
    id: string,
    input: any,
  ): { note: Note; cards: Card[] } {
    return this.transaction(() => {
      const note = this.validateNote(userId, input, this.getNote(userId, id));
      this.db
        .query("UPDATE notes SET deck_id=?,data=? WHERE id=? AND user_id=?")
        .run(note.deckId, JSON.stringify(note), id, userId);
      const cards = this.regenerateCards(userId, note);
      this.bump(userId);
      return { note, cards };
    });
  }
  private regenerateCards(userId: string, note: Note) {
    const rows = this.db
      .query("SELECT data, deleted FROM cards WHERE user_id=? AND note_id=?")
      .all(userId, note.id) as Row[];
    const current = rows
      .filter((r) => !r.deleted)
      .map((r) => JSON.parse(r.data) as Card);
    const cards = cardVariants(note).map((variant) => {
      const old = current.find((card) => card.variant === variant);
      const now = Date.now();
      const card: Card = old
        ? { ...old, deckId: note.deckId, updatedAt: now }
        : {
            id: crypto.randomUUID(),
            noteId: note.id,
            deckId: note.deckId,
            variant,
            suspended: false,
            state: createCardState(now),
            createdAt: now,
            updatedAt: now,
          };
      this.db
        .query(
          "INSERT INTO cards(id,user_id,note_id,data) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data,deleted=0",
        )
        .run(card.id, userId, note.id, JSON.stringify(card));
      return card;
    });
    for (const card of current)
      if (!cards.some((c) => c.id === card.id))
        this.db
          .query("UPDATE cards SET deleted=1 WHERE id=? AND user_id=?")
          .run(card.id, userId);
    return cards;
  }
  deleteNote(userId: string, id: string) {
    this.getNote(userId, id);
    this.transaction(() => {
      this.db
        .query("UPDATE notes SET deleted=1 WHERE id=? AND user_id=?")
        .run(id, userId);
      this.db
        .query("UPDATE cards SET deleted=1 WHERE note_id=? AND user_id=?")
        .run(id, userId);
      this.bump(userId);
    });
  }
  getCard(userId: string, id: string, includeDeleted = false): Card {
    assert(typeof id === "string" && id.length <= 128, "Choose a valid card.");
    const row = this.db
      .query(
        `SELECT data FROM cards WHERE id=? AND user_id=?${includeDeleted ? "" : " AND deleted=0"}`,
      )
      .get(id, userId) as Row | null;
    assert(row, "Card not found.", 404);
    return JSON.parse(row.data);
  }
  suspendCard(userId: string, id: string, suspended: unknown) {
    assert(typeof suspended === "boolean", "Suspended must be true or false.");
    const card = this.getCard(userId, id);
    card.suspended = suspended;
    card.updatedAt = Date.now();
    this.db
      .query("UPDATE cards SET data=? WHERE id=? AND user_id=?")
      .run(JSON.stringify(card), id, userId);
    this.bump(userId);
    return card;
  }
  library(userId: string): Library {
    const get = <T>(table: string): T[] =>
      (
        this.db
          .query(
            `SELECT data FROM ${table} WHERE user_id=? AND deleted=0 ORDER BY rowid`,
          )
          .all(userId) as Row[]
      ).map((r) => JSON.parse(r.data));
    const reviews = (
      this.db
        .query("SELECT data FROM reviews WHERE user_id=? ORDER BY rowid")
        .all(userId) as Row[]
    ).map((r) => JSON.parse(r.data) as ReviewEvent);
    return {
      decks: get<Deck>("decks"),
      notes: get<Note>("notes"),
      cards: get<Card>("cards"),
      reviews,
      cursor:
        (
          this.db
            .query("SELECT revision FROM cursors WHERE user_id=?")
            .get(userId) as Row | null
        )?.revision ?? 0,
      serverTime: Date.now(),
    };
  }
  duplicateNote(userId: string, note: ImportNote, deckId?: string): boolean {
    return this.library(userId).notes.some(
      (existing) =>
        (!deckId || existing.deckId === deckId) &&
        ((note.sourceId && existing.sourceId === note.sourceId) ||
          (existing.type === note.type &&
            existing.front === note.front &&
            existing.back === note.back)),
    );
  }
  putMedia(
    userId: string,
    name: string,
    mime: string,
    content: Uint8Array,
  ): string {
    assert(
      content.byteLength <= 25 * 1024 * 1024,
      "A media file exceeds 25 MB.",
    );
    const id = new Bun.CryptoHasher("sha256")
      .update(userId)
      .update(content)
      .digest("hex");
    this.db
      .query(
        "INSERT OR IGNORE INTO media(id,user_id,name,mime,content) VALUES(?,?,?,?,?)",
      )
      .run(id, userId, name, mime, content);
    this.bump(userId);
    return id;
  }
  getMedia(
    userId: string,
    id: string,
  ): { id: string; name: string; mime: string; content: Uint8Array } | null {
    return this.db
      .query("SELECT id,name,mime,content FROM media WHERE id=? AND user_id=?")
      .get(id, userId) as any;
  }
  listMedia(userId: string) {
    return this.db
      .query("SELECT id,name,mime,content FROM media WHERE user_id=?")
      .all(userId) as {
      id: string;
      name: string;
      mime: string;
      content: Uint8Array;
    }[];
  }
  replayCard(userId: string, id: string) {
    const card = this.getCard(userId, id, true);
    const events = (
      this.db
        .query("SELECT data FROM reviews WHERE user_id=? AND card_id=?")
        .all(userId, id) as Row[]
    ).map((r) => JSON.parse(r.data));
    card.state = replayCard(card.createdAt, events);
    card.updatedAt = Date.now();
    this.db
      .query("UPDATE cards SET data=? WHERE user_id=? AND id=?")
      .run(JSON.stringify(card), userId, id);
  }
}
