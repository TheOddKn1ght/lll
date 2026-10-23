import { ImportError } from "./archive";

export interface ImportMedia {
  id: string;
  name: string;
  mime: string;
  kind: "image" | "audio";
  bytes: Uint8Array;
}
export function contentId(bytes: Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

/** The signature decides MIME; filenames and browser-provided MIME are untrusted. */
export function detectMedia(
  bytes: Uint8Array,
  name: string,
): { mime: string; kind: "image" | "audio" } {
  if (!bytes.length || bytes.length > 25 * 1024 * 1024)
    throw new ImportError("Media must contain between 1 byte and 25 MiB.");
  const starts = (...values: number[]) =>
    values.every((value, i) => bytes[i] === value);
  const ascii = (start: number, end: number) =>
    new TextDecoder().decode(bytes.subarray(start, end));
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))
    return { mime: "image/png", kind: "image" };
  if (starts(0xff, 0xd8, 0xff)) return { mime: "image/jpeg", kind: "image" };
  if (["GIF87a", "GIF89a"].includes(ascii(0, 6)))
    return { mime: "image/gif", kind: "image" };
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP")
    return { mime: "image/webp", kind: "image" };
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WAVE")
    return { mime: "audio/wav", kind: "audio" };
  if (ascii(0, 4) === "OggS") return { mime: "audio/ogg", kind: "audio" };
  if (ascii(0, 4) === "fLaC") return { mime: "audio/flac", kind: "audio" };
  if (
    ascii(0, 3) === "ID3" ||
    (bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0)
  )
    return { mime: "audio/mpeg", kind: "audio" };
  if (ascii(4, 8) === "ftyp" && /\.(m4a|mp4|aac)$/i.test(name))
    return { mime: "audio/mp4", kind: "audio" };
  throw new ImportError(
    "Unsupported media. Use PNG, JPEG, GIF, WebP, MP3, Ogg, WAV, FLAC, or M4A.",
  );
}

export function makeMedia(name: string, bytes: Uint8Array): ImportMedia {
  return {
    id: contentId(bytes),
    name: name.slice(0, 500),
    bytes,
    ...detectMedia(bytes, name),
  };
}

const entities: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  bull: "•",
  copy: "©",
  reg: "®",
  laquo: "«",
  raquo: "»",
};
export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, key: string) => {
    if (key[0] !== "#") return entities[key.toLowerCase()] ?? match;
    const number =
      key[1]?.toLowerCase() === "x"
        ? Number.parseInt(key.slice(2), 16)
        : Number(key.slice(1));
    return number > 0 &&
      number <= 0x10ffff &&
      !(number >= 0xd800 && number <= 0xdfff)
      ? String.fromCodePoint(number)
      : "�";
  });
}

/** Convert imported markup into plain React text and explicit local media tokens. */
export function cleanContent(
  text: string,
  media: Map<string, ImportMedia>,
  warnings: Set<string>,
): string {
  if (text.length > 200_000)
    throw new ImportError("An imported field is too long.");
  const reference = (name: string, kind: "image" | "audio") => {
    name = decodeEntities(name).trim();
    try {
      name = decodeURIComponent(name);
    } catch {
      /* A literal filename may contain %. */
    }
    const found = media.get(name);
    if (found && found.kind === kind) return `[[${kind}:${found.id}]]`;
    if (warnings.size < 40)
      warnings.add(`Missing or unsupported ${kind}: ${name.slice(0, 120)}`);
    return `[Missing ${kind}: ${name.slice(0, 120)}]`;
  };
  return decodeEntities(
    text
      .replace(/<!--[^]*?-->/g, "")
      .replace(
        /<(script|style|iframe|object|embed)\b[^>]*>[^]*?<\/\1\s*>/gi,
        "",
      )
      .replace(/\[sound:([^\]]+)\]/gi, (_, name: string) =>
        reference(name, "audio"),
      )
      .replace(/<img\b[^>]*>/gi, (tag: string) => {
        const src = /\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag);
        return src ? reference(src[1] ?? src[2] ?? src[3] ?? "", "image") : "";
      })
      .replace(/<(audio|source)\b[^>]*>/gi, (tag: string) => {
        const src = /\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag);
        return src ? reference(src[1] ?? src[2] ?? src[3] ?? "", "audio") : "";
      })
      .replace(/<br\s*\/?\s*>|<\/(?:div|p|li|tr|h[1-6])\s*>/gi, "\n")
      .replace(/<[^>]*>/g, ""),
  )
    .replace(/\u0000/g, "")
    .replace(/\r\n?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function replaceMediaTokens(
  text: string,
  ids: Map<string, string>,
): string {
  return text.replace(
    /\[\[(image|audio):([a-zA-Z0-9-]+)\]\]/g,
    (_match, kind: string, id: string) => {
      const replacement = ids.get(id);
      if (!replacement)
        throw new ImportError(
          "A note refers to media not included in the import.",
        );
      return `[[${kind}:${replacement}]]`;
    },
  );
}
