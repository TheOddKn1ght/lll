import type { Repository } from "../server/database";
import { HttpError } from "../server/database";
import type { Deck, ImportNote, ImportPreview, User } from "../shared/types";
import { createBundle } from "./bundle";
import { replaceMediaTokens } from "./content";
import { exportCsv } from "./csv";
import { IMPORT_LIMITS, ImportError } from "./index";
import { parseImportIsolated } from "./isolated";
import type { ColumnMapping, ParsedImport } from "./index";

const TTL = 2 * 60 * 60 * 1000;
const json = (data: unknown, status = 200) =>
  Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
type Staged = {
  id: string;
  filename: string;
  content: Uint8Array;
  mapping: string;
  expires_at: number;
};

function setup(repo: Repository) {
  repo.db.exec(
    "CREATE TABLE IF NOT EXISTS import_jobs(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),filename TEXT NOT NULL,content BLOB NOT NULL,mapping TEXT NOT NULL,expires_at INTEGER NOT NULL); CREATE INDEX IF NOT EXISTS import_jobs_owner ON import_jobs(user_id,expires_at);",
  );
  repo.db.query("DELETE FROM import_jobs WHERE expires_at < ?").run(Date.now());
}
function mappingValue(value: unknown): ColumnMapping {
  if (value === undefined || value === null || value === "") return {};
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      throw new ImportError("Invalid column mapping JSON.");
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ImportError("Column mapping must be an object.");
  return value as ColumnMapping;
}
async function body(req: Request): Promise<Record<string, any>> {
  try {
    const result = await req.json();
    if (!result || typeof result !== "object" || Array.isArray(result)) throw 0;
    return result;
  } catch {
    throw new ImportError("Send a JSON object.");
  }
}

function deckPaths(decks: Deck[]): Map<string, string> {
  const byId = new Map(decks.map((deck) => [deck.id, deck]));
  const paths = new Map<string, string>();
  const resolve = (id: string, visited = new Set<string>()): string => {
    if (paths.has(id)) return paths.get(id)!;
    if (visited.has(id))
      throw new ImportError("A deck hierarchy contains a cycle.");
    visited.add(id);
    const deck = byId.get(id);
    if (!deck) return "";
    const path =
      (deck.parentId ? resolve(deck.parentId, visited) + "::" : "") + deck.name;
    paths.set(id, path);
    return path;
  };
  for (const deck of decks) resolve(deck.id);
  return paths;
}
const normalizeSourceId = (id: string) => id.replace(/^recall:/, "lll:");
function identity(note: ImportNote, deck: string): string[] {
  const result = [
    `${deck}|text:${JSON.stringify([note.type, note.front, note.back])}`,
  ];
  if (note.sourceId)
    result.push(`${deck}|source:${normalizeSourceId(note.sourceId)}`);
  return result;
}
function duplicateCount(
  repo: Repository,
  user: User,
  parsed: ParsedImport,
  filename: string,
): number {
  const library = repo.library(user.id);
  const paths = deckPaths(library.decks);
  const seen = new Set(
    library.notes.flatMap((note) =>
      identity(
        {
          ...note,
          sourceId: normalizeSourceId(note.sourceId ?? `lll:${note.id}`),
        },
        paths.get(note.deckId) ?? "",
      ),
    ),
  );
  let duplicates = 0;
  for (const note of parsed.notes) {
    const keys = identity(
      note,
      note.deckName ??
        (filename
          .replace(/\.(apkg|csv|tsv|txt|zip|lll|recall)$/i, "")
          .slice(0, 160) ||
          "Imported cards"),
    );
    if (keys.some((key) => seen.has(key))) duplicates++;
    for (const key of keys) seen.add(key);
  }
  return duplicates;
}

function preview(
  repo: Repository,
  user: User,
  stage: Staged,
  parsed: ParsedImport,
): ImportPreview & { mapping?: ColumnMapping } {
  return {
    id: stage.id,
    filename: stage.filename,
    notes: parsed.notes,
    warnings: parsed.warnings,
    skipped: parsed.skipped,
    duplicateCount: duplicateCount(repo, user, parsed, stage.filename),
    mediaCount: parsed.media.length,
    columns: parsed.columns,
    rows: parsed.rows,
    mapping: parsed.mapping,
  };
}

function commit(
  repo: Repository,
  user: User,
  stage: Staged,
  parsed: ParsedImport,
  options: Record<string, any>,
) {
  if (parsed.skipped && options.skipUnsupported !== true)
    throw new ImportError(
      "Review the skipped rows or unsupported templates, then explicitly acknowledge skipping them.",
    );
  if (!parsed.notes.length)
    throw new ImportError(
      "There are no supported notes to import. Check the field mapping.",
    );
  if (options.deckId !== undefined && typeof options.deckId !== "string")
    throw new ImportError("Choose a valid destination deck.");
  if (
    options.deckName !== undefined &&
    (typeof options.deckName !== "string" ||
      options.deckName.length > 160 ||
      !options.deckName.trim())
  )
    throw new ImportError(
      "A destination deck name must contain 1–160 characters.",
    );
  return repo.transaction(() => {
    const library = repo.library(user.id);
    const paths = deckPaths(library.decks);
    const decks = new Map(
      library.decks.map((deck) => [paths.get(deck.id)!, deck]),
    );
    const seen = new Set(
      library.notes.flatMap((note) =>
        identity(
          {
            ...note,
            sourceId: normalizeSourceId(note.sourceId ?? `lll:${note.id}`),
          },
          note.deckId,
        ),
      ),
    );
    const fallback =
      options.deckName ??
      (stage.filename
        .replace(/\.(apkg|csv|tsv|txt|zip|lll|recall)$/i, "")
        .slice(0, 160) ||
        "Imported cards");
    const selected = options.deckId
      ? repo.getDeck(user.id, options.deckId)
      : null;
    const ensureDeck = (name: string): Deck => {
      const parts = name
        .split("::")
        .map((part) => part.trim())
        .filter(Boolean);
      if (
        !parts.length ||
        parts.length > 20 ||
        parts.some((part) => part.length > 160)
      )
        throw new ImportError(
          "Imported deck names must contain at most 20 levels of 160 characters each.",
        );
      let current: Deck | null = null;
      let path = "";
      for (const part of parts) {
        path += (path ? "::" : "") + part;
        let found = decks.get(path);
        if (!found) {
          found = repo.createDeck(user.id, {
            name: part,
            parentId: current?.id ?? null,
          });
          decks.set(path, found);
        }
        current = found;
      }
      return current!;
    };
    const accepted: { note: ImportNote; deckId: string }[] = [];
    let duplicates = 0;
    const deckIds = new Set<string>();
    for (const note of parsed.notes) {
      const deck =
        selected ??
        ensureDeck(
          options.deckName
            ? note.deckName
              ? `${fallback}::${note.deckName}`
              : fallback
            : (note.deckName ?? fallback),
        );
      deckIds.add(deck.id);
      const keys = identity(note, deck.id);
      if (keys.some((key) => seen.has(key))) {
        duplicates++;
        continue;
      }
      for (const key of keys) seen.add(key);
      accepted.push({ note, deckId: deck.id });
    }
    const used = new Set(
      accepted.flatMap(({ note }) =>
        [
          ...[note.front, note.back, note.example ?? ""]
            .join("\n")
            .matchAll(/\[\[(?:image|audio):([a-zA-Z0-9-]+)\]\]/g),
        ].map((match) => match[1]!),
      ),
    );
    const mediaIds = new Map<string, string>();
    for (const entry of parsed.media)
      if (used.has(entry.id))
        mediaIds.set(
          entry.id,
          repo.putMedia(user.id, entry.name, entry.mime, entry.bytes),
        );
    for (const { note, deckId } of accepted)
      repo.createNote(user.id, {
        ...note,
        deckId,
        front: replaceMediaTokens(note.front, mediaIds),
        back: replaceMediaTokens(note.back, mediaIds),
        example: replaceMediaTokens(note.example ?? "", mediaIds),
      });
    repo.db
      .query("DELETE FROM import_jobs WHERE id=? AND user_id=?")
      .run(stage.id, user.id);
    return {
      imported: accepted.length,
      duplicates,
      skipped: parsed.skipped,
      deckId: [...deckIds][0],
      deckIds: [...deckIds],
    };
  });
}

async function route(
  repo: Repository,
  req: Request,
  user: User,
): Promise<Response | null> {
  const url = new URL(req.url);
  const commitMatch =
    /^\/api\/imports\/([a-zA-Z0-9-]+)\/(commit|preview)$/.exec(url.pathname);
  const exportMatch = /^\/api\/decks\/([a-zA-Z0-9-]+)\/export$/.exec(
    url.pathname,
  );
  if (
    !url.pathname.startsWith("/api/imports") &&
    url.pathname !== "/api/exports" &&
    !exportMatch
  )
    return null;
  setup(repo);
  if (url.pathname === "/api/imports/preview" && req.method === "POST") {
    const stageCount = repo.db
      .query("SELECT count(*) AS n FROM import_jobs WHERE user_id=?")
      .get(user.id) as { n: number };
    if (stageCount.n >= 3)
      repo.db
        .query(
          "DELETE FROM import_jobs WHERE id IN (SELECT id FROM import_jobs WHERE user_id=? ORDER BY expires_at ASC LIMIT ?)",
        )
        .run(user.id, stageCount.n - 2);
    let filename: string, bytes: Uint8Array, mapping: ColumnMapping;
    if (req.headers.get("content-type")?.startsWith("multipart/form-data")) {
      const form = await req.formData();
      const file = form.get("file");
      if (!(file instanceof File))
        throw new ImportError("Choose an import file.");
      if (file.size > IMPORT_LIMITS.compressed)
        throw new ImportError("The upload exceeds 50 MiB.");
      filename = file.name;
      bytes = new Uint8Array(await file.arrayBuffer());
      mapping = mappingValue(form.get("mapping"));
    } else {
      const data = await body(req);
      if (typeof data.text !== "string")
        throw new ImportError("Paste a CSV or tab-separated list.");
      filename =
        typeof data.filename === "string" ? data.filename : "Pasted list.tsv";
      bytes = new TextEncoder().encode(data.text);
      mapping = mappingValue(data.mapping ?? data.columnMapping);
    }
    filename =
      filename.replace(/[\0\r\n\\/]/g, "_").slice(0, 200) || "Imported list";
    const parsed = await parseImportIsolated({ bytes, filename, mapping });
    const stage: Staged = {
      id: crypto.randomUUID(),
      filename,
      content: bytes,
      mapping: JSON.stringify(mapping),
      expires_at: Date.now() + TTL,
    };
    repo.db
      .query(
        "INSERT INTO import_jobs(id,user_id,filename,content,mapping,expires_at) VALUES(?,?,?,?,?,?)",
      )
      .run(stage.id, user.id, filename, bytes, stage.mapping, stage.expires_at);
    return json(preview(repo, user, stage, parsed));
  }
  if (commitMatch && req.method === "POST") {
    const stage = repo.db
      .query(
        "SELECT id,filename,content,mapping,expires_at FROM import_jobs WHERE id=? AND user_id=? AND expires_at>=?",
      )
      .get(commitMatch[1]!, user.id, Date.now()) as Staged | null;
    if (!stage)
      throw new HttpError(
        404,
        "Import preview expired or was already committed. Upload the file again.",
      );
    const options = await body(req);
    const providedMapping = options.mapping ?? options.columnMapping;
    const mapping =
      commitMatch[2] === "preview" && providedMapping !== undefined
        ? mappingValue(providedMapping)
        : { ...mappingValue(stage.mapping), ...mappingValue(providedMapping) };
    const parsed = await parseImportIsolated({
      bytes: stage.content,
      filename: stage.filename,
      mapping,
    });
    if (commitMatch[2] === "preview") {
      repo.db
        .query("UPDATE import_jobs SET mapping=? WHERE id=? AND user_id=?")
        .run(JSON.stringify(mapping), stage.id, user.id);
      return json(preview(repo, user, stage, parsed));
    }
    return json(commit(repo, user, stage, parsed, options));
  }
  if (
    (url.pathname === "/api/exports" || exportMatch) &&
    req.method === "GET"
  ) {
    const library = repo.library(user.id);
    const deckId = exportMatch?.[1] ?? url.searchParams.get("deckId");
    const ids = new Set<string>();
    let filename = "lll library";
    if (deckId) {
      filename = repo.getDeck(user.id, deckId).name;
      ids.add(deckId);
      let changed = true;
      while (changed) {
        changed = false;
        for (const deck of library.decks)
          if (deck.parentId && ids.has(deck.parentId) && !ids.has(deck.id)) {
            ids.add(deck.id);
            changed = true;
          }
      }
    }
    const paths = deckPaths(library.decks);
    const notes = library.notes
      .filter((note) => !deckId || ids.has(note.deckId))
      .map((note): ImportNote => ({
        type: note.type,
        front: note.front,
        back: note.back,
        example: note.example,
        tags: note.tags,
        sourceLang: note.sourceLang,
        targetLang: note.targetLang,
        sourceId: normalizeSourceId(note.sourceId ?? `lll:${note.id}`),
        deckName: paths.get(note.deckId),
      }));
    const format = url.searchParams.get("format") ?? "bundle";
    if (!["csv", "bundle"].includes(format))
      throw new ImportError("Choose CSV or portable bundle.");
    filename =
      filename.replace(/[^a-zA-Z0-9 _-]/g, "_").slice(0, 100) || "lll deck";
    const headers = {
      "Content-Disposition": `attachment; filename="${filename}.${format === "csv" ? "csv" : "lll.zip"}"`,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    };
    return format === "csv"
      ? new Response(exportCsv(notes), {
          headers: { ...headers, "Content-Type": "text/csv; charset=utf-8" },
        })
      : new Response(
          Buffer.from(createBundle(notes, repo.listMedia(user.id))),
          { headers: { ...headers, "Content-Type": "application/zip" } },
        );
  }
  return json({ error: "Import route not found." }, 404);
}

export async function handleImportRequest(
  repo: Repository,
  req: Request,
  user: User,
): Promise<Response | null> {
  try {
    return await route(repo, req, user);
  } catch (error) {
    if (error instanceof ImportError)
      return json({ error: error.message }, 400);
    throw error;
  }
}
