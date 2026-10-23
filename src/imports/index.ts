import type { ImportNote } from "../shared/types";
import { importAnki } from "./anki";
import { IMPORT_LIMITS, ImportError, readZip } from "./archive";
import { importBundle } from "./bundle";
import { importDelimited } from "./csv";
import type { ColumnMapping } from "./csv";
import type { ImportMedia } from "./content";

export interface ParsedImport {
  notes: ImportNote[];
  media: ImportMedia[];
  warnings: string[];
  skipped: number;
  columns?: string[];
  rows?: string[][];
  mapping?: ColumnMapping;
}

export function parseImport(input: {
  bytes: Uint8Array;
  filename: string;
  mapping?: ColumnMapping;
}): ParsedImport {
  if (!input.bytes.length) throw new ImportError("The uploaded file is empty.");
  if (input.bytes.length > IMPORT_LIMITS.compressed)
    throw new ImportError("The upload exceeds 50 MiB.");
  if (input.bytes[0] === 0x50 && input.bytes[1] === 0x4b) {
    const files = readZip(input.bytes);
    return files.has("lll.bundle.json") || files.has("recall.bundle.json")
      ? importBundle(files)
      : importAnki(files, input.mapping);
  }
  if (/\.(apkg|zip|lll|recall)$/i.test(input.filename))
    throw new ImportError("The uploaded package is not a ZIP archive.");
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(input.bytes);
  } catch {
    throw new ImportError("Use a UTF-8 CSV or TSV file.");
  }
  if (text.includes("\0"))
    throw new ImportError(
      "This file is binary. Upload an Anki package or a UTF-8 text list.",
    );
  return importDelimited(text, input.filename, input.mapping);
}

export { ImportError, IMPORT_LIMITS } from "./archive";
export { detectMedia } from "./content";
export { exportCsv } from "./csv";
export { createBundle } from "./bundle";
export type { ColumnMapping } from "./csv";
