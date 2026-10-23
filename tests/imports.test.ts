import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { zipSync } from "fflate";
import { Repository } from "../src/server/database";
import { parseImport, createBundle, exportCsv } from "../src/imports";
import { decompressZstd, ImportError, readZip } from "../src/imports/archive";
import { makeMedia } from "../src/imports/content";
import { handleImportRequest } from "../src/imports/handler";
import { parseImportIsolated } from "../src/imports/isolated";

const encode = (value: string) => new TextEncoder().encode(value);
const parse = (text: string, filename = "words.csv", mapping = {}) =>
  parseImport({ bytes: encode(text), filename, mapping });
const png = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0,
]);
const openRepos: Repository[] = [];
afterEach(() => {
  for (const repo of openRepos.splice(0)) repo.close();
});
function repo() {
  const result = new Repository(":memory:");
  openRepos.push(result);
  return result;
}

test("quoted multiline UTF-8 CSV detects vocabulary headers and preserves escaped quotes", () => {
  const result = parse(
    '\ufeffWord,Translation,Example,Tags\r\n"café","coffee","A ""good""\ncoffee",noun\r\n',
  );
  expect(result.notes).toHaveLength(1);
  expect(result.notes[0]).toMatchObject({
    front: "café",
    back: "coffee",
    example: 'A "good"\ncoffee',
    tags: ["noun"],
  });
  expect(result.columns).toEqual(["Word", "Translation", "Example", "Tags"]);
});

test("tab lists and explicit column mappings support paste without a header", () => {
  const result = parse("coffee\tcafé\nwater\teau", "pasted.tsv", {
    front: 1,
    back: 0,
  });
  expect(result.notes.map((n) => [n.front, n.back])).toEqual([
    ["café", "coffee"],
    ["eau", "water"],
  ]);
  expect(parse("term;meaning\nbonjour;hello").notes[0]).toMatchObject({
    front: "bonjour",
    back: "hello",
  });
});

test("malformed CSV fails clearly; invalid rows are counted rather than silently dropped", () => {
  expect(() => parse('Front,Back\n"not closed,answer')).toThrow("not closed");
  expect(() => parse('Front,Back\n"front"bad,answer')).toThrow("closing quote");
  expect(() => parse("front,back", "words.csv", { front: 0, back: 0 })).toThrow(
    "different columns",
  );
  const result = parse("Front,Back\none,two\nmissing,\n,orphan");
  expect(result.notes).toHaveLength(1);
  expect(result.skipped).toBe(2);
  expect(result.warnings.join(" ")).toContain("Row 3");
});

test("CSV export round trips supported text fields, tags and note types", () => {
  const notes = [
    {
      type: "vocabulary" as const,
      front: 'Hello, "world"',
      back: "Bonjour\nle monde",
      tags: ["greeting"],
      example: "Example",
      deckName: "French",
    },
  ];
  expect(parse(exportCsv(notes)).notes[0]).toMatchObject(notes[0]!);
});

test("ZIP preflight rejects path traversal, corrupt bytes and forged expanded sizes", () => {
  expect(() => readZip(zipSync({ "../secret": encode("unsafe") }))).toThrow(
    "Unsafe",
  );
  const damaged = zipSync({ "words.txt": encode("a,b") }, { level: 0 });
  damaged[39] = damaged[39]! ^ 1;
  expect(() => readZip(damaged)).toThrow("integrity");
  const oversized = zipSync({ "words.txt": encode("a,b") });
  const view = new DataView(oversized.buffer);
  for (let i = 0; i < oversized.length - 46; i++)
    if (view.getUint32(i, true) === 0x02014b50) {
      view.setUint32(i + 24, 100 * 1024 * 1024, true);
      break;
    }
  expect(() => readZip(oversized)).toThrow("limit");
  const mismatch = zipSync({ "words.txt": encode("a".repeat(100_000)) });
  const mismatchView = new DataView(mismatch.buffer);
  for (let i = 0; i < mismatch.length - 46; i++)
    if (mismatchView.getUint32(i, true) === 0x02014b50) {
      mismatchView.setUint32(i + 24, 1, true);
      break;
    }
  expect(() => readZip(mismatch)).toThrow("declared size");
});

function varint(n: number): number[] {
  const out: number[] = [];
  do {
    const next = n & 127;
    n >>>= 7;
    out.push(next | (n ? 128 : 0));
  } while (n);
  return out;
}
function pb(fields: [number, string | Uint8Array | number][]): Uint8Array {
  return Uint8Array.from(
    fields.flatMap(([key, value]) =>
      typeof value === "number"
        ? [...varint(key << 3), ...varint(value)]
        : [
            ...varint((key << 3) | 2),
            ...varint(
              (typeof value === "string" ? encode(value) : value).length,
            ),
            ...(typeof value === "string" ? encode(value) : value),
          ],
    ),
  );
}
/** Match Anki's stream encoder, which omits the optional frame content size. */
function zstdStream(input: Uint8Array): Uint8Array {
  const bytes = Bun.zstdCompressSync(input);
  const descriptor = bytes[4]!;
  const flag = descriptor >>> 6;
  const size = flag === 0 ? (descriptor & 32 ? 1 : 0) : [0, 2, 4, 8][flag]!;
  const dictionary = [0, 1, 2, 4][descriptor & 3]!;
  const payload = 5 + (descriptor & 32 ? 0 : 1) + dictionary + size;
  return Uint8Array.from([
    ...bytes.subarray(0, 4),
    descriptor & 0x1f,
    0x68,
    ...bytes.subarray(5, 5 + dictionary),
    ...bytes.subarray(payload),
  ]);
}

function ankiFixture(modern: boolean, unsupported = false): Uint8Array {
  const db = new Database(":memory:");
  db.exec(
    "CREATE TABLE col(ver INTEGER,models TEXT,decks TEXT); CREATE TABLE notes(id INTEGER,guid TEXT,mid INTEGER,flds TEXT,tags TEXT); CREATE TABLE cards(nid INTEGER,did INTEGER,odid INTEGER);",
  );
  const models = {
    "100": {
      name: "Basic",
      type: 0,
      flds: [{ name: "Front" }, { name: "Back" }],
      tmpls: [
        {
          qfmt: unsupported ? "Question: {{Front}}" : "{{Front}}",
          afmt: "{{FrontSide}}<hr id=answer>{{Back}}",
        },
      ],
    },
  };
  db.query("INSERT INTO col VALUES(?,?,?)").run(
    modern ? 18 : 11,
    JSON.stringify(models),
    JSON.stringify({ "1": { name: "Languages::French" } }),
  );
  db.query("INSERT INTO notes VALUES(1,?,?,?,?)").run(
    "unique-guid",
    100,
    'Bonjour<img src="pic.png" onerror="alert(1)"><script>steal()</script>\x1fHello',
    " greeting French ",
  );
  db.exec("INSERT INTO cards VALUES(1,1,0)");
  if (modern) {
    db.exec(
      "CREATE TABLE notetypes(id INTEGER,name TEXT,config BLOB); CREATE TABLE fields(ntid INTEGER,ord INTEGER,name TEXT); CREATE TABLE templates(ntid INTEGER,ord INTEGER,config BLOB); CREATE TABLE decks(id INTEGER,name TEXT);",
    );
    db.query("INSERT INTO notetypes VALUES(100,'Basic',?)").run(
      new Uint8Array(),
    );
    db.exec(
      "INSERT INTO fields VALUES(100,0,'Front'),(100,1,'Back'); INSERT INTO decks VALUES(1,'Languages' || char(31) || 'French');",
    );
    db.query("INSERT INTO templates VALUES(100,0,?)").run(
      pb([
        [1, unsupported ? "Question: {{Front}}" : "{{Front}}"],
        [2, "{{FrontSide}}<hr id=answer>{{Back}}"],
      ]),
    );
  }
  const collection = db.serialize();
  db.close();
  return modern
    ? zipSync(
        {
          meta: pb([[1, 3]]),
          "collection.anki21b": zstdStream(collection),
          media: zstdStream(
            pb([
              [
                1,
                pb([
                  [1, "pic.png"],
                  [2, png.length],
                  [3, new Bun.CryptoHasher("sha1").update(png).digest()],
                ]),
              ],
            ]),
          ),
          "0": zstdStream(png),
        },
        { level: 0 },
      )
    : zipSync({
        "collection.anki2": collection,
        media: encode('{"0":"pic.png"}'),
        "0": png,
      });
}

for (const modern of [false, true]) {
  test(`${modern ? "modern schema 18 protobuf/zstd" : "legacy schema 11"} Anki imports content, hierarchy, safe media and tags`, () => {
    const result = parseImport({
      bytes: ankiFixture(modern),
      filename: "French.apkg",
    });
    expect(result.notes).toHaveLength(1);
    expect(result.notes[0]).toMatchObject({
      back: "Hello",
      type: "basic",
      deckName: "Languages::French",
      tags: ["greeting", "French"],
      sourceId: "anki:unique-guid",
    });
    expect(result.notes[0]!.front).toMatch(
      /^Bonjour\[\[image:[a-f0-9]{64}\]\]$/,
    );
    expect(result.media).toHaveLength(1);
    expect(result.notes[0]!.front).not.toContain("steal");
  });
  test(`${modern ? "modern" : "legacy"} custom templates require explicit field mapping`, () => {
    const bytes = ankiFixture(modern, true);
    const unsupported = parseImport({ bytes, filename: "custom.apkg" });
    expect(unsupported.skipped).toBe(1);
    expect(unsupported.notes).toHaveLength(0);
    const mapped = parseImport({
      bytes,
      filename: "custom.apkg",
      mapping: { ankiFields: { "100": { front: 0, back: 1 } } },
    });
    expect(mapped.notes).toHaveLength(1);
  });
}

test("bounded zstd rejects oversized output, concatenated frames and truncation", () => {
  const bytes = zstdStream(encode("x".repeat(1000)));
  expect(decompressZstd(bytes)).toEqual(encode("x".repeat(1000)));
  expect(() => decompressZstd(bytes, 10)).toThrow(ImportError);
  expect(() => decompressZstd(Uint8Array.from([...bytes, ...bytes]))).toThrow(
    "Concatenated",
  );
  expect(() => decompressZstd(bytes.subarray(0, 8))).toThrow("Truncated");
});

test("portable bundles round trip content and media without scheduling", () => {
  const media = makeMedia("image.png", png);
  const notes = [
    {
      type: "reverse" as const,
      front: `Question [[image:${media.id}]]`,
      back: "Answer",
      deckName: "Parent::Child",
    },
  ];
  const bytes = createBundle(notes, [{ ...media, content: media.bytes }]);
  const result = parseImport({ bytes, filename: "deck.lll.zip" });
  expect(result.notes).toHaveLength(1);
  expect(result.notes[0]).toMatchObject(notes[0]!);
  expect(result.media[0]!.bytes).toEqual(png);
  expect((result.notes[0] as any).state).toBeUndefined();
});

test("new bundles use lll names and legacy exports remain readable", () => {
  const notes = [
    {
      type: "basic" as const,
      front: "hello",
      back: "hola",
      sourceId: "recall:existing-note",
    },
  ];
  const files = readZip(createBundle(notes, []));
  const manifest = JSON.parse(
    new TextDecoder().decode(files.get("lll.bundle.json")),
  );
  expect(manifest.format).toBe("lll-deck");
  expect(files.has("recall.bundle.json")).toBe(false);

  manifest.format = "recall-deck";
  const legacy = zipSync({
    "recall.bundle.json": encode(JSON.stringify(manifest)),
  });
  const result = parseImport({
    bytes: legacy,
    filename: "existing.recall.zip",
  });
  expect(result.notes[0]).toMatchObject(notes[0]!);
});

const request = (path: string, data?: any) =>
  new Request(`http://localhost${path}`, {
    method: data === undefined ? "GET" : "POST",
    headers: { "Content-Type": "application/json" },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
async function stage(
  db: Repository,
  user: any,
  text: string,
  filename = "words.csv",
) {
  return (await handleImportRequest(
    db,
    request("/api/imports/preview", { text, filename }),
    user,
  ))!.json();
}

test("staged imports are account isolated, preserve hierarchy and deduplicate without resetting progress", async () => {
  const db = repo();
  const alice = db.createUser("alice", "hash", "UTC");
  const bob = db.createUser("bob", "hash", "UTC");
  const preview = await stage(
    db,
    alice,
    "Front,Back,Deck\nHello,Bonjour,Languages::French",
  );
  await expect(
    handleImportRequest(
      db,
      request(`/api/imports/${preview.id}/commit`, {}),
      bob,
    ),
  ).rejects.toMatchObject({ status: 404 });
  const response = await handleImportRequest(
    db,
    request(`/api/imports/${preview.id}/commit`, {}),
    alice,
  );
  expect(await response!.json()).toMatchObject({ imported: 1, duplicates: 0 });
  const library = db.library(alice.id);
  expect(library.decks.map((deck) => deck.name)).toEqual([
    "Languages",
    "French",
  ]);
  expect(library.decks[1]!.parentId).toBe(library.decks[0]!.id);
  const cardId = library.cards[0]!.id;
  db.suspendCard(alice.id, cardId, true);
  const repeated = await stage(
    db,
    alice,
    "Front,Back,Deck\nHello,Bonjour,Languages::French",
  );
  expect(repeated.duplicateCount).toBe(1);
  const repeatedResponse = await handleImportRequest(
    db,
    request(`/api/imports/${repeated.id}/commit`, {}),
    alice,
  );
  expect(await repeatedResponse!.json()).toMatchObject({
    imported: 0,
    duplicates: 1,
  });
  expect(db.library(alice.id).cards[0]).toMatchObject({
    id: cardId,
    suspended: true,
  });
  expect(db.library(bob.id).notes).toHaveLength(0);
});

test("failed import commits roll back new decks, notes and media; skipped rows require acknowledgement", async () => {
  const db = repo();
  const user = db.createUser("alice", "hash", "UTC");
  const preview = await stage(
    db,
    user,
    `Front,Back\nvalid,answer\n${"x".repeat(100_001)},answer`,
  );
  await expect(
    handleImportRequest(
      db,
      request(`/api/imports/${preview.id}/commit`, {}),
      user,
    ),
  ).rejects.toMatchObject({ status: 400 });
  expect(db.library(user.id).decks).toHaveLength(0);
  expect(db.library(user.id).notes).toHaveLength(0);
  const skipped = await stage(db, user, "Front,Back\nvalid,answer\nmissing,");
  const denied = await handleImportRequest(
    db,
    request(`/api/imports/${skipped.id}/commit`, {}),
    user,
  );
  expect(denied!.status).toBe(400);
  const success = await handleImportRequest(
    db,
    request(`/api/imports/${skipped.id}/commit`, { skipUnsupported: true }),
    user,
  );
  expect(await success!.json()).toMatchObject({ imported: 1, skipped: 1 });
});

test("mapping changes can rebuild the persisted preview and survive stage reload", async () => {
  const db = repo();
  const user = db.createUser("alice", "hash", "UTC");
  const preview = await stage(db, user, "Hello,Bonjour", "words.csv");
  const remapped = await handleImportRequest(
    db,
    request(`/api/imports/${preview.id}/preview`, {
      columnMapping: { front: 1, back: 0 },
    }),
    user,
  );
  expect((await remapped!.json()).notes[0]).toMatchObject({
    front: "Bonjour",
    back: "Hello",
  });
  await handleImportRequest(
    db,
    request(`/api/imports/${preview.id}/commit`, {}),
    user,
  );
  expect(db.library(user.id).notes[0]).toMatchObject({
    front: "Bonjour",
    back: "Hello",
  });
});

test("Anki reversed and cloze note templates map to distinct native note types", () => {
  const db = new Database(":memory:");
  db.exec(
    "CREATE TABLE col(ver INTEGER,models TEXT,decks TEXT); CREATE TABLE notes(id INTEGER,guid TEXT,mid INTEGER,flds TEXT,tags TEXT); CREATE TABLE cards(nid INTEGER,did INTEGER,odid INTEGER);",
  );
  const models = {
    "1": {
      name: "Reversed",
      type: 0,
      flds: [{ name: "Front" }, { name: "Back" }],
      tmpls: [
        { qfmt: "{{Front}}", afmt: "{{FrontSide}}<hr>{{Back}}" },
        { qfmt: "{{Back}}", afmt: "{{FrontSide}}<hr>{{Front}}" },
      ],
    },
    "2": {
      name: "Cloze",
      type: 1,
      flds: [{ name: "Text" }, { name: "Back Extra" }],
      tmpls: [
        { qfmt: "{{cloze:Text}}", afmt: "{{cloze:Text}}<br>{{Back Extra}}" },
      ],
    },
  };
  db.query("INSERT INTO col VALUES(11,?,?)").run(
    JSON.stringify(models),
    '{"1":{"name":"Examples"}}',
  );
  db.query("INSERT INTO notes VALUES(1,'reverse-guid',1,?,'')").run(
    "hello\x1fbonjour",
  );
  db.query("INSERT INTO notes VALUES(2,'cloze-guid',2,?,'')").run(
    "The answer is {{c1::42}}\x1fExtra context",
  );
  db.exec("INSERT INTO cards VALUES(1,1,0),(2,1,0)");
  const bytes = zipSync({
    "collection.anki2": db.serialize(),
    media: encode("{}"),
  });
  db.close();
  const result = parseImport({ bytes, filename: "types.apkg" });
  expect(result.notes.map((note) => note.type)).toEqual(["reverse", "cloze"]);
  expect(result.notes[1]).toMatchObject({
    front: "The answer is {{c1::42}}",
    back: "Extra context",
  });
});

test("portable media bundles create independent account copies and deduplicate when reimported", async () => {
  const db = repo();
  const alice = db.createUser("alice", "hash", "UTC");
  const bob = db.createUser("bob", "hash", "UTC");
  const deck = db.createDeck(alice.id, { name: "Images" });
  const id = db.putMedia(alice.id, "pic.png", "image/png", png);
  const original = db.createNote(alice.id, {
    deckId: deck.id,
    type: "basic",
    front: `Picture [[image:${id}]]`,
    back: "Answer",
  });
  const exported = await handleImportRequest(
    db,
    request(`/api/exports?deckId=${deck.id}&format=bundle`),
    alice,
  );
  const bundle = new Uint8Array(await exported!.arrayBuffer());
  const upload = async (user: typeof alice) => {
    const form = new FormData();
    form.set("file", new File([bundle], "images.lll.zip"));
    return (await handleImportRequest(
      db,
      new Request("http://localhost/api/imports/preview", {
        method: "POST",
        body: form,
      }),
      user,
    ))!.json();
  };
  const bobPreview = await upload(bob);
  const bobResult = await handleImportRequest(
    db,
    request(`/api/imports/${bobPreview.id}/commit`, {}),
    bob,
  );
  expect(await bobResult!.json()).toMatchObject({ imported: 1, duplicates: 0 });
  const bobLibrary = db.library(bob.id);
  expect(bobLibrary.notes[0]!.id).not.toBe(original.note.id);
  expect(bobLibrary.cards[0]!.state.reps).toBe(0);
  const bobMedia = db.listMedia(bob.id);
  expect(bobMedia).toHaveLength(1);
  expect(bobMedia[0]!.id).not.toBe(id);
  expect(db.getMedia(alice.id, bobMedia[0]!.id)).toBeNull();
  const alicePreview = await upload(alice);
  expect(alicePreview.duplicateCount).toBe(1);
  const aliceResult = await handleImportRequest(
    db,
    request(`/api/imports/${alicePreview.id}/commit`, {}),
    alice,
  );
  expect(await aliceResult!.json()).toMatchObject({
    imported: 0,
    duplicates: 1,
  });
  expect(db.library(alice.id).notes).toHaveLength(1);
});

test("CSV previews explain media loss and expired jobs cannot commit", async () => {
  const result = parse("Front,Back\nQuestion [[image:1234]],Answer");
  expect(result.notes[0]!.front).toBe("Question [Missing image]");
  expect(result.warnings.join(" ")).toContain("portable bundle");
  const db = repo();
  const user = db.createUser("alice", "hash", "UTC");
  const preview = await stage(db, user, "hello,bonjour");
  db.db.query("UPDATE import_jobs SET expires_at=0 WHERE id=?").run(preview.id);
  await expect(
    handleImportRequest(
      db,
      request(`/api/imports/${preview.id}/commit`, {}),
      user,
    ),
  ).rejects.toMatchObject({ status: 404 });
});

test("isolated parsers cap concurrent work and return format errors without blocking requests", async () => {
  const first = parseImportIsolated({
    bytes: encode("hello,bonjour"),
    filename: "words.csv",
  });
  const second = parseImportIsolated({
    bytes: encode("goodbye,au revoir"),
    filename: "words.csv",
  });
  await expect(
    parseImportIsolated({
      bytes: encode("busy,occupé"),
      filename: "words.csv",
    }),
  ).rejects.toMatchObject({ status: 429 });
  expect((await first).notes[0]!.front).toBe("hello");
  expect((await second).notes[0]!.front).toBe("goodbye");
  await expect(
    parseImportIsolated({
      bytes: encode("not a package"),
      filename: "broken.apkg",
    }),
  ).rejects.toThrow("not a ZIP");
});

test("preview returns detected mappings and commits them without hidden defaults", async () => {
  const db = repo();
  const user = db.createUser("alice", "hash", "UTC");
  const preview = await stage(
    db,
    user,
    "Back,Example,Front\nBonjour,Context,Hello",
  );
  expect(preview.mapping).toMatchObject({
    front: 2,
    back: 0,
    example: 1,
    hasHeader: true,
  });
  const imported = await handleImportRequest(
    db,
    request(`/api/imports/${preview.id}/commit`, {}),
    user,
  );
  expect(imported!.status).toBe(200);
  expect(db.library(user.id).notes[0]).toMatchObject({
    front: "Hello",
    back: "Bonjour",
    example: "Context",
  });
});

test("remapping can exclude detected optional columns and commit the exact preview", async () => {
  const db = repo();
  const user = db.createUser("alice", "hash", "UTC");
  const preview = await stage(
    db,
    user,
    "Front,Back,Example,Tags\nHello,Bonjour,Context,greeting",
  );
  const mapping = { ...preview.mapping };
  delete mapping.example;
  delete mapping.tags;
  const remapped = await handleImportRequest(
    db,
    request(`/api/imports/${preview.id}/preview`, { columnMapping: mapping }),
    user,
  );
  const result = await remapped!.json();
  expect(result.notes[0]).toMatchObject({
    front: "Hello",
    back: "Bonjour",
    example: "",
    tags: [],
  });
  await handleImportRequest(
    db,
    request(`/api/imports/${preview.id}/commit`, {}),
    user,
  );
  expect(db.library(user.id).notes[0]).toMatchObject({ example: "", tags: [] });
});
