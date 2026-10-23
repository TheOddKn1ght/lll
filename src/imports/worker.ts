import { parseImport, ImportError } from "./index";
import type { ColumnMapping } from "./index";

self.onmessage = (
  event: MessageEvent<{
    bytes: Uint8Array;
    filename: string;
    mapping?: ColumnMapping;
  }>,
) => {
  try {
    const result = parseImport(event.data);
    self.postMessage({ ok: true, result });
  } catch (error) {
    self.postMessage({
      ok: false,
      message:
        error instanceof ImportError
          ? error.message
          : "The file is damaged or uses an unsupported format.",
    });
  }
};
