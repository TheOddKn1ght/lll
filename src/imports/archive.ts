import { inflateRawSync, zstdDecompressSync } from "node:zlib";

export const IMPORT_LIMITS = {
  compressed: 50 * 1024 * 1024,
  expanded: 200 * 1024 * 1024,
  entry: 50 * 1024 * 1024,
  files: 20_000,
  notes: 50_000,
};

export class ImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImportError";
  }
}

const decoder = new TextDecoder("utf-8", { fatal: true });
const crcTable = Uint32Array.from({ length: 256 }, (_, i) => {
  let value = i;
  for (let bit = 0; bit < 8; bit++)
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 255]!;
  return (crc ^ 0xffffffff) >>> 0;
}

/** Read files directly from the archive: no untrusted path is ever written. */
export function readZip(bytes: Uint8Array): Map<string, Uint8Array> {
  if (bytes.length > IMPORT_LIMITS.compressed)
    throw new ImportError("The upload exceeds 50 MiB.");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (
    let i = bytes.length - 22;
    i >= Math.max(0, bytes.length - 65_557);
    i--
  ) {
    if (
      view.getUint32(i, true) === 0x06054b50 &&
      i + 22 + view.getUint16(i + 20, true) === bytes.length
    ) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new ImportError("This is not a complete ZIP archive.");
  const count = view.getUint16(end + 10, true);
  const directorySize = view.getUint32(end + 12, true);
  const directoryOffset = view.getUint32(end + 16, true);
  if (
    view.getUint16(end + 4, true) ||
    view.getUint16(end + 6, true) ||
    view.getUint16(end + 8, true) !== count
  )
    throw new ImportError("Multipart ZIP files are unsupported.");
  if (
    count === 0xffff ||
    directoryOffset === 0xffffffff ||
    directorySize === 0xffffffff
  )
    throw new ImportError("ZIP64 packages are unsupported.");
  if (count > IMPORT_LIMITS.files || directoryOffset + directorySize !== end)
    throw new ImportError(
      "The archive has too many files or an invalid directory.",
    );
  const entries: {
    name: string;
    start: number;
    compressed: number;
    expanded: number;
    method: number;
    crc: number;
  }[] = [];
  const names = new Set<string>();
  let pos = directoryOffset;
  let total = 0;
  for (let i = 0; i < count; i++) {
    if (pos + 46 > end || view.getUint32(pos, true) !== 0x02014b50)
      throw new ImportError("The ZIP directory is damaged.");
    const flags = view.getUint16(pos + 8, true);
    const method = view.getUint16(pos + 10, true);
    const compressed = view.getUint32(pos + 20, true);
    const expanded = view.getUint32(pos + 24, true);
    const nameSize = view.getUint16(pos + 28, true);
    const extraSize = view.getUint16(pos + 30, true);
    const commentSize = view.getUint16(pos + 32, true);
    const local = view.getUint32(pos + 42, true);
    if (pos + 46 + nameSize + extraSize + commentSize > end)
      throw new ImportError("A ZIP entry is truncated.");
    let name: string;
    try {
      name = decoder.decode(bytes.subarray(pos + 46, pos + 46 + nameSize));
    } catch {
      throw new ImportError("Archive filenames must be valid UTF-8.");
    }
    if (
      !name ||
      name.length > 1024 ||
      name.includes("\\") ||
      name.includes("\0") ||
      name.startsWith("/") ||
      /^[a-z]:/i.test(name) ||
      name.split("/").some((p) => p === ".." || p === ".")
    )
      throw new ImportError("Unsafe archive filename.");
    if (names.has(name))
      throw new ImportError("The archive contains duplicate filenames.");
    names.add(name);
    total += expanded;
    if (expanded > IMPORT_LIMITS.entry || total > IMPORT_LIMITS.expanded)
      throw new ImportError("The expanded archive exceeds the import limit.");
    if (flags & 1 || (method !== 0 && method !== 8))
      throw new ImportError("Encrypted or unsupported ZIP compression.");
    if (
      local + 30 > directoryOffset ||
      view.getUint32(local, true) !== 0x04034b50
    )
      throw new ImportError("Invalid ZIP file offset.");
    const localNameSize = view.getUint16(local + 26, true);
    const localExtraSize = view.getUint16(local + 28, true);
    const start = local + 30 + localNameSize + localExtraSize;
    if (
      view.getUint16(local + 8, true) !== method ||
      view.getUint16(local + 6, true) !== flags ||
      start + compressed > directoryOffset ||
      localNameSize !== nameSize
    )
      throw new ImportError("Inconsistent ZIP file headers.");
    if (
      decoder.decode(bytes.subarray(local + 30, local + 30 + localNameSize)) !==
      name
    )
      throw new ImportError("Inconsistent ZIP filenames.");
    entries.push({
      name,
      start,
      compressed,
      expanded,
      method,
      crc: view.getUint32(pos + 16, true),
    });
    pos += 46 + nameSize + extraSize + commentSize;
  }
  if (pos !== end) throw new ImportError("Invalid ZIP directory length.");
  const out = new Map<string, Uint8Array>();
  for (const entry of entries) {
    const input = bytes.subarray(entry.start, entry.start + entry.compressed);
    let data: Uint8Array;
    try {
      data =
        entry.method === 0
          ? input.slice()
          : inflateRawSync(input, {
              maxOutputLength: Math.max(1, entry.expanded),
            });
    } catch {
      throw new ImportError(
        "An archive entry exceeds its declared size or is corrupt.",
      );
    }
    if (data.length !== entry.expanded || crc32(data) !== entry.crc)
      throw new ImportError("An archive entry failed its integrity check.");
    if (!entry.name.endsWith("/")) out.set(entry.name, data);
  }
  return out;
}

/** Bun's built-in zlib compatibility API supports a bounded Zstandard output. */
export function decompressZstd(
  bytes: Uint8Array,
  max = IMPORT_LIMITS.entry,
): Uint8Array {
  if (
    bytes.length < 6 ||
    new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(
      0,
      true,
    ) !== 0xfd2fb528
  )
    throw new ImportError("Invalid Zstandard frame.");
  const descriptor = bytes[4]!;
  if (descriptor & 0x18)
    throw new ImportError("Unsupported Zstandard frame flags.");
  const single = !!(descriptor & 0x20);
  const flag = descriptor >>> 6;
  const dictSize = [0, 1, 2, 4][descriptor & 3]!;
  const sizeBytes = flag === 0 ? (single ? 1 : 0) : [0, 2, 4, 8][flag]!;
  const sizeOffset = 5 + (single ? 0 : 1) + dictSize;
  if (sizeOffset + sizeBytes > bytes.length)
    throw new ImportError("Truncated Zstandard header.");
  let size = 0n;
  for (let i = 0; i < sizeBytes; i++)
    size += BigInt(bytes[sizeOffset + i]!) << BigInt(i * 8);
  if (flag === 1) size += 256n;
  if (size > BigInt(max))
    throw new ImportError(
      "A decompressed Anki entry exceeds the import limit.",
    );
  // Check block boundaries ourselves to reject appended frames before decompression.
  let pos = sizeOffset + sizeBytes;
  let last = false;
  while (!last) {
    if (pos + 3 > bytes.length)
      throw new ImportError("Truncated Zstandard block.");
    const header =
      bytes[pos]! | (bytes[pos + 1]! << 8) | (bytes[pos + 2]! << 16);
    last = !!(header & 1);
    const type = (header >>> 1) & 3;
    if (type === 3) throw new ImportError("Invalid Zstandard block.");
    pos += 3 + (type === 1 ? 1 : header >>> 3);
    if (pos > bytes.length) throw new ImportError("Truncated Zstandard block.");
  }
  if (descriptor & 4) pos += 4;
  if (pos !== bytes.length)
    throw new ImportError("Concatenated Zstandard frames are unsupported.");
  try {
    const out = zstdDecompressSync(bytes, { maxOutputLength: max });
    if (sizeBytes && out.length !== Number(size))
      throw new ImportError("Incorrect Zstandard content size.");
    return out;
  } catch (e) {
    if (e instanceof ImportError) throw e;
    throw new ImportError("Damaged Zstandard data.");
  }
}

export type ProtoField = { number: number; value: number | Uint8Array };
/** Only protobuf wire types used by Anki metadata; skips fixed-width unknowns. */
export function protobuf(bytes: Uint8Array): ProtoField[] {
  const out: ProtoField[] = [];
  let pos = 0;
  function varint(): bigint {
    let value = 0n;
    for (let i = 0; i < 10; i++) {
      const byte = bytes[pos++];
      if (byte === undefined)
        throw new ImportError("Truncated protobuf value.");
      value |= BigInt(byte & 127) << BigInt(i * 7);
      if (!(byte & 128)) return value;
    }
    throw new ImportError("Invalid protobuf value.");
  }
  while (pos < bytes.length) {
    const key = Number(varint());
    const number = key >>> 3;
    const wire = key & 7;
    if (!number) throw new ImportError("Invalid protobuf field.");
    if (wire === 0) {
      const value = varint();
      out.push({
        number,
        value:
          value <= BigInt(Number.MAX_SAFE_INTEGER)
            ? Number(value)
            : Number.MAX_SAFE_INTEGER,
      });
    } else if (wire === 2) {
      const size = Number(varint());
      if (!Number.isSafeInteger(size) || size < 0 || pos + size > bytes.length)
        throw new ImportError("Invalid protobuf length.");
      out.push({ number, value: bytes.subarray(pos, pos + size) });
      pos += size;
    } else if (wire === 1 || wire === 5) {
      pos += wire === 1 ? 8 : 4;
      if (pos > bytes.length)
        throw new ImportError("Truncated protobuf field.");
    } else throw new ImportError("Unsupported protobuf wire type.");
    if (out.length > 200_000)
      throw new ImportError("Too many protobuf entries.");
  }
  return out;
}
export function protoNumber(
  fields: ProtoField[],
  number: number,
  fallback = 0,
): number {
  const value = fields.find((f) => f.number === number)?.value;
  return typeof value === "number" ? value : fallback;
}
export function protoString(fields: ProtoField[], number: number): string {
  const value = fields.find((f) => f.number === number)?.value;
  if (!(value instanceof Uint8Array)) return "";
  try {
    return decoder.decode(value);
  } catch {
    throw new ImportError("Invalid UTF-8 in Anki metadata.");
  }
}
