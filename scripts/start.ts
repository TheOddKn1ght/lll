import { fileURLToPath } from "node:url";
import { resolveDatabasePath } from "../src/server/paths";

// Bun's ahead-of-time HTML manifest resolves its artifact paths from cwd.
// Keep application data and public assets anchored to the project directory.
const project = new URL("../", import.meta.url);
process.env.NODE_ENV = "production";
process.env.PUBLIC_DIRECTORY ||= fileURLToPath(new URL("public/", project));
process.env.DATABASE_PATH = resolveDatabasePath(
  process.env.DATABASE_PATH,
  fileURLToPath(project),
);
const entry = new URL("dist/index.js", project);
if (!(await Bun.file(entry).exists()))
  throw new Error("Production build is missing. Run bun run build first.");
process.chdir(fileURLToPath(new URL("dist/", project)));
await import(entry.href);
