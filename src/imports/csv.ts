import type { ImportNote, NoteType } from "../shared/types";
import { IMPORT_LIMITS, ImportError } from "./archive";
import { cleanContent, contentId } from "./content";

export interface ColumnMapping {
  front?: number;
  back?: number;
  example?: number;
  tags?: number;
  deckName?: number;
  sourceLang?: number;
  targetLang?: number;
  type?: number;
  hasHeader?: boolean;
  delimiter?: string;
  noteType?: NoteType;
  ankiFields?: Record<string, { front: number; back: number; type?: NoteType }>;
}
const columnKeys = [
  "front",
  "back",
  "example",
  "tags",
  "deckName",
  "sourceLang",
  "targetLang",
  "type",
] as const;
const headerNames: Record<string, string[]> = {
  front: ["front", "word", "term", "question", "expression"],
  back: ["back", "translation", "definition", "answer", "meaning"],
  example: ["example", "sentence", "notes"],
  tags: ["tags", "tag"],
  deckName: ["deck", "deckname", "list"],
  sourceLang: ["sourcelang", "sourcelanguage"],
  targetLang: ["targetlang", "targetlanguage"],
  type: ["type", "notetype"],
};

export function parseDelimited(text: string, delimiter: string): string[][] {
  if (![",", "\t", ";", "|"].includes(delimiter))
    throw new ImportError(
      "Choose comma, tab, semicolon, or pipe as delimiter.",
    );
  text = text.replace(/^\ufeff/, "");
  const rows: string[][] = [];
  let row: string[] = [],
    field = "",
    quoted = false,
    afterQuote = false;
  const saveField = () => {
    row.push(field);
    field = "";
    afterQuote = false;
    if (row.length > 100)
      throw new ImportError("A row has more than 100 columns.");
  };
  const saveRow = () => {
    saveField();
    if (row.some((value) => value.trim())) rows.push(row);
    row = [];
    if (rows.length > IMPORT_LIMITS.notes + 1)
      throw new ImportError("Import at most 50,000 notes at a time.");
  };
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (char === '"') {
        quoted = false;
        afterQuote = true;
      } else field += char;
    } else if (char === delimiter) saveField();
    else if (char === "\r" || char === "\n") {
      if (char === "\r" && text[i + 1] === "\n") i++;
      saveRow();
    } else if (char === '"') {
      if (field || afterQuote)
        throw new ImportError(`Unexpected quote near row ${rows.length + 1}.`);
      quoted = true;
    } else if (afterQuote) {
      if (char !== " " && char !== "\t")
        throw new ImportError(
          `Unexpected text after a closing quote near row ${rows.length + 1}.`,
        );
    } else field += char;
    if (field.length > 200_000)
      throw new ImportError("An imported field is too long.");
  }
  if (quoted) throw new ImportError("A quoted field is not closed.");
  if (field || row.length || afterQuote) saveRow();
  return rows;
}

export function detectDelimiter(text: string, filename: string): string {
  if (/\.tsv$/i.test(filename)) return "\t";
  let selected = ",",
    best = -1;
  for (const delimiter of ["\t", ",", ";", "|"]) {
    try {
      const rows = parseDelimited(text, delimiter).slice(0, 20);
      if (!rows.length) continue;
      const width = rows[0]!.length;
      const same = rows.filter((row) => row.length === width).length;
      const score = width > 1 ? same * 100 + Math.min(width, 50) : 0;
      if (score > best) {
        selected = delimiter;
        best = score;
      }
    } catch {
      /* Test the other delimiters before reporting parse errors. */
    }
  }
  return selected;
}

export function importDelimited(
  text: string,
  filename: string,
  mapping: ColumnMapping = {},
) {
  const warnings = new Set<string>();
  const delimiter = mapping.delimiter ?? detectDelimiter(text, filename);
  const allRows = parseDelimited(text, delimiter);
  if (!allRows.length) throw new ImportError("The list is empty.");
  const first = allRows[0]!;
  const detected: ColumnMapping = {};
  const normalized = first.map((value) =>
    value
      .trim()
      .toLowerCase()
      .replace(/[\s_-]/g, ""),
  );
  for (const key of columnKeys) {
    const index = normalized.findIndex((value) =>
      headerNames[key]!.includes(value),
    );
    if (index >= 0) detected[key] = index;
  }
  const hasHeader =
    mapping.hasHeader ??
    (detected.front !== undefined && detected.back !== undefined);
  // An explicit front/back mapping is a complete mapping chosen in the preview;
  // omitted optional columns must stay excluded rather than being redetected.
  const selected = {
    ...(hasHeader && mapping.front === undefined && mapping.back === undefined
      ? detected
      : {}),
    ...mapping,
  };
  selected.front ??= 0;
  selected.back ??= 1;
  for (const key of columnKeys)
    if (
      selected[key] !== undefined &&
      (!Number.isInteger(selected[key]) ||
        selected[key]! < 0 ||
        selected[key]! > 99)
    )
      throw new ImportError(
        "Column mappings must be zero-based column numbers.",
      );
  if (selected.front === selected.back)
    throw new ImportError("Front and back must use different columns.");
  const rows = hasHeader ? allRows.slice(1) : allRows;
  const notes: ImportNote[] = [];
  let skipped = 0;
  const maxColumns = Math.max(...allRows.map((row) => row.length));
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    const value = (key: (typeof columnKeys)[number]) =>
      selected[key] === undefined ? "" : (row[selected[key]!] ?? "");
    const clean = (text: string) =>
      cleanContent(text, new Map(), warnings).replace(
        /\[\[(image|audio):[a-zA-Z0-9-]+\]\]/g,
        (_token, kind: string) => {
          warnings.add(
            "CSV contains media references without files. Use a portable bundle to transfer media.",
          );
          return `[Missing ${kind}]`;
        },
      );
    const front = clean(value("front"));
    const back = clean(value("back"));
    const typeValue = value("type") || selected.noteType || "basic";
    if (
      !["basic", "reverse", "cloze", "vocabulary"].includes(typeValue) ||
      !front ||
      (!back && typeValue !== "cloze") ||
      (typeValue === "cloze" && !/\{\{c[1-9]\d*::[\s\S]+?\}\}/.test(front))
    ) {
      skipped++;
      if (warnings.size < 40)
        warnings.add(
          `Row ${i + (hasHeader ? 2 : 1)}: missing front/back or unsupported note type.`,
        );
      continue;
    }
    const note: ImportNote = {
      type: typeValue as NoteType,
      front,
      back,
      example: clean(value("example")),
      tags: value("tags")
        .split(/[\s,]+/)
        .filter(Boolean),
      deckName: value("deckName").trim() || undefined,
      sourceLang: value("sourceLang").trim(),
      targetLang: value("targetLang").trim(),
    };
    note.sourceId = `text:${contentId(new TextEncoder().encode(JSON.stringify([note.type, front, back, note.deckName ?? ""])))}`;
    notes.push(note);
  }
  if (notes.length > IMPORT_LIMITS.notes)
    throw new ImportError("Import at most 50,000 notes at a time.");
  return {
    notes,
    media: [],
    warnings: [...warnings],
    skipped,
    columns: Array.from({ length: maxColumns }, (_, i) =>
      hasHeader ? first[i] || `Column ${i + 1}` : `Column ${i + 1}`,
    ),
    rows: rows.slice(0, 20),
    mapping: { ...selected, hasHeader, delimiter },
  };
}

export function exportCsv(notes: ImportNote[]): string {
  const cell = (value: string) => `"${value.replace(/"/g, '""')}"`;
  const keys = [
    "type",
    "front",
    "back",
    "example",
    "tags",
    "deckName",
    "sourceLang",
    "targetLang",
  ] as const;
  return (
    "\ufeff" +
    [
      keys.join(","),
      ...notes.map((note) =>
        keys
          .map((key) =>
            cell(
              key === "tags"
                ? (note.tags ?? []).join(" ")
                : String(note[key] ?? ""),
            ),
          )
          .join(","),
      ),
    ].join("\r\n")
  );
}
