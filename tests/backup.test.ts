import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backup, restore } from "../scripts/backup";

test("live WAL backup includes media, verifies checksums, and restores without overwrite", async () => {
  const directory = mkdtempSync(join(tmpdir(), "lll-backup-"));
  const path = join(directory, "source.sqlite"),
    destination = join(directory, "restored.sqlite");
  const db = new Database(path, { create: true });
  try {
    db.exec("PRAGMA journal_mode=WAL; CREATE TABLE sample (value BLOB)");
    db.query("INSERT INTO sample(value) VALUES(?)").run(
      new Uint8Array([1, 2, 3]),
    );
    const snapshot = await backup(path, directory);
    expect(snapshot).toMatch(/\/lll-.*\.sqlite$/);
    await restore(snapshot, destination);
    const restored = new Database(destination);
    try {
      expect(
        (
          restored.query("SELECT value FROM sample").get() as {
            value: Uint8Array;
          }
        ).value,
      ).toEqual(new Uint8Array([1, 2, 3]));
    } finally {
      restored.close();
    }
    await expect(restore(snapshot, destination)).rejects.toThrow(
      "already exists",
    );
    const manifest = await Bun.file(`${snapshot}.json`).json();
    await Bun.write(
      `${snapshot}.json`,
      JSON.stringify({ ...manifest, sha256: "invalid" }),
    );
    await expect(
      restore(snapshot, join(directory, "tampered.sqlite")),
    ).rejects.toThrow("checksum");
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("backup retention keeps the newest snapshots across current and legacy names", async () => {
  const directory = mkdtempSync(join(tmpdir(), "lll-backup-retention-"));
  const path = join(directory, "source.sqlite");
  const db = new Database(path, { create: true });
  db.exec("CREATE TABLE sample (value INTEGER)");
  db.close();
  try {
    const names: string[] = [];
    for (let age = 1; age <= 30; age++) {
      const stamp = new Date(Date.now() - age * 86400000)
        .toISOString()
        .replace(/[:.]/g, "-");
      const name = `${age % 2 ? "recall" : "lll"}-${stamp}.sqlite`;
      names.push(name);
      await Bun.write(join(directory, name), "old snapshot");
      await Bun.write(join(directory, `${name}.json`), "{}");
    }
    const command = Bun.spawn({
      cmd: [
        process.execPath,
        new URL("../scripts/backup.ts", import.meta.url).pathname,
      ],
      env: {
        ...process.env,
        DATABASE_PATH: path,
        BACKUP_DIRECTORY: directory,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const errors = await new Response(command.stderr).text();
    expect(await command.exited, errors).toBe(0);
    const remaining = readdirSync(directory);
    for (const name of names.slice(0, 6)) expect(remaining).toContain(name);
    expect(remaining).not.toContain(names.at(-1)!);
    expect(remaining).not.toContain(`${names.at(-1)!}.json`);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
