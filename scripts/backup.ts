import { Database } from "bun:sqlite";
import { mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { resolve, join } from "node:path";
import { resolveDatabasePath } from "../src/server/paths";

export async function backup(
  databasePath: string,
  destination: string,
  at = new Date(),
): Promise<string> {
  mkdirSync(destination, { recursive: true });
  const stamp = at.toISOString().replace(/[:.]/g, "-");
  const target = resolve(destination, `lll-${stamp}.sqlite`);
  const db = new Database(databasePath, { readonly: true, strict: true });
  try {
    db.exec("PRAGMA busy_timeout=30000");
    // VACUUM INTO is a consistent live snapshot, including media BLOBs and WAL.
    db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
  } finally {
    db.close();
  }
  const file = Bun.file(target);
  const digest = new Bun.CryptoHasher("sha256")
    .update(await file.arrayBuffer())
    .digest("hex");
  await Bun.write(
    `${target}.json`,
    JSON.stringify(
      {
        formatVersion: 1,
        createdAt: at.toISOString(),
        filename: file.name?.split("/").at(-1),
        bytes: file.size,
        sha256: digest,
      },
      null,
      2,
    ),
  );
  return target;
}

export async function restore(
  snapshot: string,
  destination: string,
): Promise<void> {
  // Restore is deliberately a separate offline operation; never overwrite a DB.
  if (
    (await Bun.file(destination).exists()) ||
    (await Bun.file(`${destination}-wal`).exists()) ||
    (await Bun.file(`${destination}-shm`).exists())
  )
    throw new Error(
      "Destination database or WAL already exists. Stop the app and move the old database files aside first.",
    );
  const manifest = await Bun.file(`${snapshot}.json`).json();
  const content = await Bun.file(snapshot).arrayBuffer();
  const hash = new Bun.CryptoHasher("sha256").update(content).digest("hex");
  if (
    manifest.formatVersion !== 1 ||
    manifest.sha256 !== hash ||
    manifest.bytes !== content.byteLength
  )
    throw new Error("Backup checksum or manifest is invalid.");
  const check = new Database(snapshot, { readonly: true });
  try {
    const row = check.query("PRAGMA integrity_check").get() as Record<
      string,
      string
    >;
    if (Object.values(row)[0] !== "ok")
      throw new Error("Backup database integrity check failed.");
  } finally {
    check.close();
  }
  await Bun.write(destination, content);
}

function retain(directory: string) {
  // Keep pre-rename snapshots in the same chronological retention policy.
  const stamp = (name: string) => name.replace(/^(?:lll|recall)-/, "");
  const files = readdirSync(directory)
    .filter((name) => /^(?:lll|recall)-.*\.sqlite$/.test(name))
    .sort((left, right) => stamp(right).localeCompare(stamp(left)));
  const keep = new Set(files.slice(0, 7));
  const weeks = new Set<string>();
  for (const file of files) {
    const date = new Date(stamp(file).slice(0, 10));
    const week = Math.floor(date.getTime() / (7 * 86400000)).toString();
    if (!weeks.has(week) && weeks.size < 4) {
      weeks.add(week);
      keep.add(file);
    }
  }
  for (const file of files)
    if (!keep.has(file))
      for (const suffix of ["", ".json"]) {
        try {
          unlinkSync(join(directory, file + suffix));
        } catch {
          /* absent sidecars can be cleaned on the next run */
        }
      }
}

if (import.meta.main) {
  const [command, source, destination] = Bun.argv.slice(2);
  try {
    if (command === "restore") {
      if (!source || !destination)
        throw new Error(
          "Usage: bun run backup restore SNAPSHOT DESTINATION (stop app first)",
        );
      await restore(source, destination);
      console.log(
        "Backup restored. Start the app to run any required migrations.",
      );
    } else {
      const path = resolveDatabasePath(process.env.DATABASE_PATH);
      const directory = process.env.BACKUP_DIRECTORY || "backups";
      do {
        const target = await backup(path, directory);
        retain(directory);
        console.log(
          JSON.stringify({
            level: "info",
            message: "Backup complete",
            path: target,
          }),
        );
        if (command !== "watch") break;
        await Bun.sleep(24 * 60 * 60 * 1000);
      } while (true);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
