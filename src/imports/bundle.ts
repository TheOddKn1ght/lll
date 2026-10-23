import { zipSync } from "fflate";
import type { ImportNote } from "../shared/types";
import { IMPORT_LIMITS, ImportError } from "./archive";
import { contentId, makeMedia, replaceMediaTokens } from "./content";
import type { ImportMedia } from "./content";

const encoder = new TextEncoder();
export interface DeckBundle {
  format: "lll-deck";
  version: 1;
  notes: ImportNote[];
  media: { id: string; name: string; mime: string; path: string }[];
}

export function createBundle(
  notes: ImportNote[],
  media: { id: string; name: string; mime: string; content: Uint8Array }[],
): Uint8Array {
  const files: Record<string, Uint8Array> = Object.create(null);
  const selected = new Map<
    string,
    { id: string; name: string; mime: string; content: Uint8Array }
  >();
  const references = new Set(
    notes.flatMap((note) =>
      [
        ...[note.front, note.back, note.example ?? ""]
          .join("\n")
          .matchAll(/\[\[(?:image|audio):([a-zA-Z0-9-]+)\]\]/g),
      ].map((match) => match[1]!),
    ),
  );
  for (const entry of media)
    if (references.has(entry.id)) selected.set(entry.id, entry);
  if ([...references].some((id) => !selected.has(id)))
    throw new ImportError(
      "Some deck media is missing. Restore it before exporting a portable bundle.",
    );
  const ids = new Map(
    [...selected.values()].map((entry) => [entry.id, contentId(entry.content)]),
  );
  const manifest: DeckBundle = {
    format: "lll-deck",
    version: 1,
    notes: notes.map((note) => ({
      ...note,
      front: replaceMediaTokens(note.front, ids),
      back: replaceMediaTokens(note.back, ids),
      example: replaceMediaTokens(note.example ?? "", ids),
    })),
    media: [...selected.values()].map((entry) => {
      const id = ids.get(entry.id)!;
      const path = `media/${id}`;
      files[path] = entry.content;
      return { id, name: entry.name, mime: entry.mime, path };
    }),
  };
  files["lll.bundle.json"] = encoder.encode(JSON.stringify(manifest));
  const expanded = Object.values(files).reduce(
    (sum, data) => sum + data.length,
    0,
  );
  if (
    expanded > IMPORT_LIMITS.expanded ||
    Object.keys(files).length > IMPORT_LIMITS.files
  )
    throw new ImportError(
      "This deck exceeds the portable bundle limit. Export smaller subdecks.",
    );
  const out = zipSync(files, { level: 6 });
  if (out.length > IMPORT_LIMITS.compressed)
    throw new ImportError(
      "The exported bundle exceeds 50 MiB. Export smaller subdecks.",
    );
  return out;
}

export function importBundle(files: Map<string, Uint8Array>) {
  let manifest: unknown;
  try {
    manifest = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        files.get("lll.bundle.json") ?? files.get("recall.bundle.json"),
      ),
    );
  } catch {
    throw new ImportError(
      "The portable bundle manifest is missing or damaged.",
    );
  }
  if (!manifest || typeof manifest !== "object")
    throw new ImportError("Invalid portable bundle.");
  const bundle = manifest as DeckBundle;
  if (
    !["lll-deck", "recall-deck"].includes(bundle.format) ||
    bundle.version !== 1
  )
    throw new ImportError("Unsupported portable bundle version.");
  if (
    !Array.isArray(bundle.notes) ||
    bundle.notes.length > IMPORT_LIMITS.notes ||
    !Array.isArray(bundle.media) ||
    bundle.media.length > IMPORT_LIMITS.files
  )
    throw new ImportError(
      "The portable bundle has too many notes or media entries.",
    );
  const media: ImportMedia[] = [];
  const ids = new Map<string, string>();
  for (const entry of bundle.media) {
    if (
      !entry ||
      typeof entry.id !== "string" ||
      !/^[a-f0-9]{64}$/.test(entry.id) ||
      typeof entry.name !== "string" ||
      entry.path !== `media/${entry.id}` ||
      ids.has(entry.id)
    )
      throw new ImportError("Invalid portable media entry.");
    const bytes = files.get(entry.path);
    if (!bytes || contentId(bytes) !== entry.id)
      throw new ImportError(
        "Bundle media is missing or failed its integrity check.",
      );
    const item = makeMedia(entry.name, bytes);
    ids.set(entry.id, item.id);
    media.push(item);
  }
  const notes = bundle.notes.map((note): ImportNote => {
    if (
      !note ||
      !["basic", "reverse", "cloze", "vocabulary"].includes(note.type) ||
      typeof note.front !== "string" ||
      !note.front.trim() ||
      typeof note.back !== "string" ||
      (note.type !== "cloze" && !note.back.trim())
    )
      throw new ImportError("Invalid note in portable bundle.");
    for (const field of [note.front, note.back, note.example ?? ""])
      if (typeof field !== "string" || field.length > 100_000)
        throw new ImportError("Invalid portable note field.");
    if (
      note.type === "cloze" &&
      !/\{\{c[1-9]\d*::[\s\S]+?\}\}/.test(note.front)
    )
      throw new ImportError("A cloze note has no deletion.");
    if (
      note.tags &&
      (!Array.isArray(note.tags) ||
        note.tags.length > 100 ||
        note.tags.some((tag) => typeof tag !== "string" || tag.length > 80))
    )
      throw new ImportError("Invalid portable note tags.");
    for (const [field, max] of [
      [note.sourceId, 1000],
      [note.deckName, 2000],
      [note.sourceLang, 50],
      [note.targetLang, 50],
    ] as const)
      if (
        field !== undefined &&
        (typeof field !== "string" || field.length > max)
      )
        throw new ImportError("Invalid portable note metadata.");
    return {
      type: note.type,
      front: replaceMediaTokens(note.front, ids),
      back: replaceMediaTokens(note.back, ids),
      example: replaceMediaTokens(note.example ?? "", ids),
      tags: note.tags ?? [],
      sourceId: note.sourceId,
      deckName: note.deckName,
      sourceLang: note.sourceLang ?? "",
      targetLang: note.targetLang ?? "",
    };
  });
  return {
    notes,
    media,
    warnings: ["Portable decks import content only. Cards start fresh."],
    skipped: 0,
  };
}
