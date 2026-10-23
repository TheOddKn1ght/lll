import { HttpError } from "../server/database";
import { ImportError } from "./archive";
import type { ColumnMapping, ParsedImport } from "./index";

let activeParsers = 0;
const MAX_PARSERS = 2;
const TIMEOUT_MS = 10_000;

/** Decompression and untrusted SQLite inspection never run on the HTTP thread. */
export async function parseImportIsolated(input: {
  bytes: Uint8Array;
  filename: string;
  mapping?: ColumnMapping;
}): Promise<ParsedImport> {
  if (activeParsers >= MAX_PARSERS)
    throw new HttpError(
      429,
      "Two imports are already processing. Try again shortly.",
    );
  activeParsers++;
  let worker: Worker | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    // The production build emits index.js and imports/worker.js as entrypoints.
    // Source execution resolves the neighboring TypeScript file directly.
    const path = import.meta.file.endsWith(".js")
      ? new URL("./imports/worker.js", import.meta.url)
      : new URL("./worker.ts", import.meta.url);
    worker = new Worker(path.href, { type: "module", smol: true });
    return await new Promise<ParsedImport>((resolve, reject) => {
      timeout = setTimeout(
        () =>
          reject(
            new ImportError(
              "The import took longer than 10 seconds. Split this deck into smaller files and try again.",
            ),
          ),
        TIMEOUT_MS,
      );
      worker!.onmessage = (
        event: MessageEvent<{
          ok: boolean;
          result?: ParsedImport;
          message?: string;
        }>,
      ) =>
        event.data.ok && event.data.result
          ? resolve(event.data.result)
          : reject(
              new ImportError(
                event.data.message ?? "Could not read the import.",
              ),
            );
      worker!.onerror = (event) => {
        event.preventDefault();
        reject(
          new ImportError(
            "The import could not be processed. Check the file and try again.",
          ),
        );
      };
      const bytes = new Uint8Array(input.bytes);
      worker!.postMessage({ ...input, bytes }, [bytes.buffer]);
    });
  } finally {
    if (timeout) clearTimeout(timeout);
    worker?.terminate();
    activeParsers--;
  }
}
