import { Repository, validTimeZone } from "../src/server/database";

async function readPassword(): Promise<string> {
  if (!process.stdin.isTTY)
    return (await Bun.stdin.text()).replace(/[\r\n]+$/, "");
  process.stdout.write("Password (at least 12 characters): ");
  return new Promise((resolve, reject) => {
    let password = "";
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");
    const finish = () => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.off("data", input);
      process.stdout.write("\n");
    };
    const input = (chunk: string) => {
      for (const character of chunk) {
        if (character === "\u0003") {
          finish();
          reject(new Error("Cancelled."));
          return;
        }
        if (character === "\r" || character === "\n") {
          finish();
          resolve(password);
          return;
        }
        if (character === "\u007f" || character === "\b")
          password = [...password].slice(0, -1).join("");
        else if (character >= " ") password += character;
      }
    };
    process.stdin.on("data", input);
  });
}
const [command, username, zone = "UTC"] = Bun.argv.slice(2);
if (
  !["create", "reset", "invite"].includes(command || "") ||
  !username ||
  !/^[\p{L}\p{N}_.-]{3,40}$/u.test(username) ||
  !validTimeZone(zone)
) {
  console.error(
    "Usage: bun run admin create|reset|invite USERNAME [TIMEZONE]\nPasswords are read without echo or from standard input. Invitations require an existing administrator username.",
  );
  process.exitCode = 1;
} else {
  const repo = new Repository();
  try {
    if (command === "invite") {
      const admin = repo.userByName(username);
      if (!admin?.admin) throw new Error("Choose an existing administrator.");
      const token = Buffer.from(
        crypto.getRandomValues(new Uint8Array(32)),
      ).toString("base64url");
      const hash = new Bun.CryptoHasher("sha256").update(token).digest("hex");
      repo.db
        .query(
          "INSERT INTO invites(id,hash,created_by,expires_at,created_at) VALUES(?,?,?,?,?)",
        )
        .run(
          crypto.randomUUID(),
          hash,
          admin.id,
          Date.now() + 7 * 86400000,
          Date.now(),
        );
      console.log(
        new URL(
          `/#invite=${encodeURIComponent(token)}`,
          process.env.PUBLIC_ORIGIN || "http://localhost:3000",
        ).href,
      );
    } else {
      if (command === "create" && repo.userCount())
        throw new Error(
          "The administrator already exists. Create other accounts using invitations.",
        );
      if (command === "reset" && !repo.userByName(username))
        throw new Error("Account not found.");
      const password = await readPassword();
      if (password.length < 12 || password.length > 256)
        throw new Error("Use a password of 12–256 characters.");
      const hash = await Bun.password.hash(password, {
        algorithm: "argon2id",
        memoryCost: 65536,
        timeCost: 3,
      });
      repo.transaction(() => {
        if (command === "create") {
          if (repo.userCount())
            throw new Error("Setup was completed by another process.");
          repo.createUser(username, hash, zone, true);
        } else {
          const user = repo.userByName(username)!;
          repo.db
            .query("UPDATE users SET password_hash=? WHERE id=?")
            .run(hash, user.id);
          repo.db.query("DELETE FROM sessions WHERE user_id=?").run(user.id);
        }
      });
      console.log(
        command === "create"
          ? "Administrator created."
          : "Password changed. Existing sessions were revoked.",
      );
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  } finally {
    repo.close();
  }
}
