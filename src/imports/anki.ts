import { Database } from "bun:sqlite";
import type { ImportNote, NoteType } from "../shared/types";
import {
  decompressZstd,
  IMPORT_LIMITS,
  ImportError,
  protobuf,
  protoNumber,
  protoString,
} from "./archive";
import { cleanContent, makeMedia } from "./content";
import type { ImportMedia } from "./content";
import type { ColumnMapping } from "./csv";

type Model = {
  id: string;
  name: string;
  kind: number;
  fields: string[];
  templates: { front: string; back: string }[];
};
type Shape = { type: NoteType; front: number; back: number };
const decode = new TextDecoder("utf-8", { fatal: true });
const plainTemplate = (value: string) =>
  value.replace(/<[^>]*>/g, "").replace(/\s+/g, "");
const fieldToken = (name: string) => `{{${name.replace(/\s+/g, "")}}}`;

function modelShape(model: Model, mapping: ColumnMapping): Shape | null {
  const explicit = mapping.ankiFields?.[model.id];
  if (explicit) {
    if (
      !Number.isInteger(explicit.front) ||
      !Number.isInteger(explicit.back) ||
      explicit.front < 0 ||
      explicit.back < 0 ||
      explicit.front >= model.fields.length ||
      explicit.back >= model.fields.length ||
      explicit.front === explicit.back ||
      !["basic", "reverse", "cloze", "vocabulary"].includes(
        explicit.type ?? "basic",
      )
    )
      throw new ImportError(
        `Invalid field mapping for note type ${model.name}.`,
      );
    return {
      front: explicit.front,
      back: explicit.back,
      type: explicit.type ?? "basic",
    };
  }
  if (
    !model.fields.length ||
    model.templates.length < 1 ||
    model.templates.length > 2 ||
    model.templates.some((t) =>
      /<(?:script|iframe|object|embed)\b|\bon\w+\s*=|javascript:/i.test(
        t.front + t.back,
      ),
    )
  )
    return null;
  const first = model.templates[0]!;
  const question = plainTemplate(first.front);
  if (model.kind === 1) {
    const front = model.fields.findIndex(
      (name) => question === `{{cloze:${name.replace(/\s+/g, "")}}}`,
    );
    if (front < 0 || model.templates.length !== 1) return null;
    const answer = plainTemplate(first.back).replace(question, "");
    const back = model.fields.findIndex((name) => answer === fieldToken(name));
    return back >= 0
      ? { type: "cloze", front, back }
      : answer === ""
        ? { type: "cloze", front, back: -1 }
        : null;
  }
  const front = model.fields.findIndex((name) => question === fieldToken(name));
  const backText = plainTemplate(first.back).replace("{{FrontSide}}", "");
  const back = model.fields.findIndex((name) => backText === fieldToken(name));
  if (front < 0 || back < 0 || front === back) return null;
  if (model.templates.length === 1) return { type: "basic", front, back };
  const second = model.templates[1]!;
  if (
    plainTemplate(second.front) !== fieldToken(model.fields[back]!) ||
    plainTemplate(second.back).replace("{{FrontSide}}", "") !==
      fieldToken(model.fields[front]!)
  )
    return null;
  return { type: "reverse", front, back };
}

function loadModels(db: Database, legacy: boolean): Model[] {
  if (legacy) {
    const col = db.query("SELECT models FROM col LIMIT 1").get() as {
      models: string;
    } | null;
    if (!col) throw new ImportError("The Anki collection has no metadata.");
    let models: Record<string, any>;
    try {
      models = JSON.parse(col.models);
    } catch {
      throw new ImportError("Anki note types are damaged.");
    }
    if (!models || typeof models !== "object" || Array.isArray(models))
      throw new ImportError("Invalid Anki note types.");
    return Object.entries(models).map(([id, model]) => {
      if (!Array.isArray(model.flds) || !Array.isArray(model.tmpls))
        throw new ImportError("Invalid Anki note type definition.");
      return {
        id,
        name: String(model.name ?? id),
        kind: Number(model.type ?? 0),
        fields: model.flds.map((f: any) => String(f.name ?? "")),
        templates: model.tmpls.map((t: any) => ({
          front: String(t.qfmt ?? ""),
          back: String(t.afmt ?? ""),
        })),
      };
    });
  }
  // Anki schema 15+ stores each model/field/template separately. Config columns
  // use the wire fields documented by proto/anki/notetypes.proto upstream.
  const types = db
    .query("SELECT id, name, config FROM notetypes LIMIT 10001")
    .all() as { id: number; name: string; config: Uint8Array }[];
  if (types.length > 10_000) throw new ImportError("Too many Anki note types.");
  return types.map((model) => ({
    id: String(model.id),
    name: model.name,
    kind: protoNumber(protobuf(model.config), 1),
    fields: (
      db
        .query("SELECT name FROM fields WHERE ntid=? ORDER BY ord LIMIT 101")
        .all(model.id) as { name: string }[]
    ).map((f) => f.name),
    templates: (
      db
        .query(
          "SELECT config FROM templates WHERE ntid=? ORDER BY ord LIMIT 101",
        )
        .all(model.id) as { config: Uint8Array }[]
    ).map((t) => {
      const fields = protobuf(t.config);
      return { front: protoString(fields, 1), back: protoString(fields, 2) };
    }),
  }));
}

export function importAnki(
  files: Map<string, Uint8Array>,
  mapping: ColumnMapping = {},
) {
  const warnings = new Set<string>();
  let version: number;
  if (files.has("meta")) version = protoNumber(protobuf(files.get("meta")!), 1);
  else version = files.has("collection.anki21") ? 2 : 1;
  if (![1, 2, 3].includes(version))
    throw new ImportError(
      "This Anki package version is unsupported. Export a legacy .apkg from Anki.",
    );
  const modern = version === 3;
  const databaseName = modern
    ? "collection.anki21b"
    : version === 2
      ? "collection.anki21"
      : "collection.anki2";
  const compressed = files.get(databaseName);
  if (!compressed)
    throw new ImportError(`The package is missing ${databaseName}.`);
  const collection = modern ? decompressZstd(compressed) : compressed;
  if (decode.decode(collection.subarray(0, 16)) !== "SQLite format 3\0")
    throw new ImportError("The Anki collection is not a SQLite database.");
  let totalExpanded =
    [...files.values()].reduce((n, data) => n + data.length, 0) +
    (modern ? collection.length : 0);
  const expand = (data: Uint8Array) => {
    const out = modern ? decompressZstd(data) : data;
    if (modern) totalExpanded += out.length;
    if (totalExpanded > IMPORT_LIMITS.expanded)
      throw new ImportError("The expanded Anki package exceeds 200 MiB.");
    return out;
  };
  const mediaByName = new Map<string, ImportMedia>();
  const mediaRaw = files.get("media");
  if (mediaRaw) {
    const mediaData = expand(mediaRaw);
    let names: {
      index: string;
      name: string;
      size?: number;
      sha1?: Uint8Array;
    }[];
    if (modern) {
      names = protobuf(mediaData)
        .filter((f) => f.number === 1)
        .map((f, index) => {
          if (!(f.value instanceof Uint8Array))
            throw new ImportError("Invalid Anki media entry.");
          const fields = protobuf(f.value);
          const sha1 = fields.find((field) => field.number === 3)?.value;
          if (!(sha1 instanceof Uint8Array) || sha1.length !== 20)
            throw new ImportError("Invalid Anki media checksum.");
          return {
            index: String(protoNumber(fields, 255, index)),
            name: protoString(fields, 1),
            size: protoNumber(fields, 2),
            sha1,
          };
        });
    } else {
      let object: unknown;
      try {
        object = JSON.parse(decode.decode(mediaData));
      } catch {
        throw new ImportError("The Anki media map is damaged.");
      }
      if (!object || typeof object !== "object" || Array.isArray(object))
        throw new ImportError("Invalid Anki media map.");
      names = Object.entries(object).map(([index, name]) => {
        if (typeof name !== "string" || !/^\d+$/.test(index))
          throw new ImportError("Invalid Anki media map.");
        return { index, name };
      });
    }
    if (names.length > IMPORT_LIMITS.files)
      throw new ImportError("Too many Anki media files.");
    for (const entry of names) {
      if (
        !entry.name ||
        entry.name.length > 500 ||
        /[\0\\/]/.test(entry.name) ||
        mediaByName.has(entry.name)
      )
        throw new ImportError("Unsafe or duplicate Anki media filename.");
      const raw = files.get(entry.index);
      if (!raw) {
        if (warnings.size < 40) warnings.add(`Missing media: ${entry.name}`);
        continue;
      }
      const bytes = expand(raw);
      if (entry.size !== undefined && entry.size !== bytes.length)
        throw new ImportError("Anki media size does not match the index.");
      if (
        entry.sha1 &&
        !Buffer.from(
          new Bun.CryptoHasher("sha1").update(bytes).digest(),
        ).equals(Buffer.from(entry.sha1))
      )
        throw new ImportError("Anki media failed its checksum.");
      try {
        mediaByName.set(entry.name, makeMedia(entry.name, bytes));
      } catch (e) {
        if (!(e instanceof ImportError)) throw e;
        if (warnings.size < 40)
          warnings.add(`Skipped unsupported media: ${entry.name}`);
      }
    }
  }
  let db: Database | undefined;
  try {
    db = Database.deserialize(collection, { readonly: true, strict: true });
    db.exec("PRAGMA trusted_schema=OFF; PRAGMA query_only=ON;");
    const tables = new Set(
      (
        db.query("SELECT name FROM sqlite_schema WHERE type='table'").all() as {
          name: string;
        }[]
      ).map((row) => row.name),
    );
    if (["col", "notes", "cards"].some((table) => !tables.has(table)))
      throw new ImportError("The Anki database is missing required tables.");
    const schema = db.query("SELECT ver FROM col LIMIT 1").get() as {
      ver: number;
    } | null;
    if (!schema || ![11, 15, 16, 17, 18].includes(schema.ver))
      throw new ImportError(
        `Unsupported Anki database schema ${schema?.ver ?? "unknown"}. Export a legacy .apkg.`,
      );
    const legacy = schema.ver === 11;
    const required = [
      "col",
      "notes",
      "cards",
      ...(legacy ? [] : ["notetypes", "fields", "templates", "decks"]),
    ];
    if (required.some((table) => !tables.has(table)))
      throw new ImportError("The Anki database is missing required tables.");
    const models = new Map(
      loadModels(db, legacy).map((model) => [model.id, model]),
    );
    const deckNames = new Map<string, string>();
    if (legacy) {
      const row = db.query("SELECT decks FROM col LIMIT 1").get() as {
        decks: string;
      };
      const decks = JSON.parse(row.decks);
      for (const [id, deck] of Object.entries(decks) as [string, any][])
        deckNames.set(id, String(deck.name));
    } else {
      const decks = db.query("SELECT id,name FROM decks LIMIT 10001").all() as {
        id: number;
        name: string;
      }[];
      if (decks.length > 10_000)
        throw new ImportError("Too many decks in the Anki collection.");
      for (const deck of decks)
        deckNames.set(String(deck.id), deck.name.replace(/\x1f/g, "::"));
    }
    const sourceNotes = db
      .query("SELECT id,guid,mid,flds,tags FROM notes LIMIT 50001")
      .all() as {
      id: number;
      guid: string;
      mid: number;
      flds: string;
      tags: string;
    }[];
    if (sourceNotes.length > IMPORT_LIMITS.notes)
      throw new ImportError("Import at most 50,000 notes at a time.");
    // One source note may live in multiple decks: preserve one copy per deck.
    const sourceCards = db
      .query("SELECT nid,did,odid FROM cards LIMIT 5000001")
      .iterate() as Iterable<{ nid: number; did: number; odid: number }>;
    const noteDecks = new Map<number, Set<string>>();
    let cardCount = 0;
    for (const card of sourceCards) {
      if (++cardCount > 5_000_000)
        throw new ImportError("Too many cards in the Anki collection.");
      if (!noteDecks.has(card.nid)) noteDecks.set(card.nid, new Set());
      noteDecks.get(card.nid)!.add(String(card.odid || card.did));
    }
    const notes: ImportNote[] = [];
    let skipped = 0;
    for (const note of sourceNotes) {
      const model = models.get(String(note.mid));
      const shape = model && modelShape(model, mapping);
      if (!shape) {
        skipped++;
        if (warnings.size < 40)
          warnings.add(
            `Unsupported note type: ${model?.name ?? note.mid}. Map its fields explicitly or acknowledge skipping these notes.`,
          );
        continue;
      }
      const fields = note.flds.split("\x1f");
      const front = cleanContent(
        fields[shape.front] ?? "",
        mediaByName,
        warnings,
      );
      const back = cleanContent(
        fields[shape.back] ?? "",
        mediaByName,
        warnings,
      );
      if (
        !front ||
        (!back && shape.type !== "cloze") ||
        (shape.type === "cloze" && !/\{\{c[1-9]\d*::[\s\S]+?\}\}/.test(front))
      ) {
        skipped++;
        if (warnings.size < 40)
          warnings.add(
            "Some notes have empty fields or no valid cloze deletion.",
          );
        continue;
      }
      for (const deck of noteDecks.get(note.id) ?? ["1"]) {
        notes.push({
          type: shape.type,
          front,
          back,
          tags: note.tags.trim().split(/\s+/).filter(Boolean),
          sourceId: `anki:${note.guid}`,
          deckName: deckNames.get(deck) ?? "Imported Anki",
        });
        if (notes.length > IMPORT_LIMITS.notes)
          throw new ImportError("Import at most 50,000 notes at a time.");
      }
    }
    warnings.add(
      "Anki scheduling and review history are not imported. Cards start fresh.",
    );
    return {
      notes,
      media: [
        ...new Map([...mediaByName.values()].map((m) => [m.id, m])).values(),
      ],
      warnings: [...warnings],
      skipped,
    };
  } catch (e) {
    if (e instanceof ImportError) throw e;
    throw new ImportError(
      "The Anki database is damaged or uses an unsupported schema.",
    );
  } finally {
    db?.close();
  }
}
