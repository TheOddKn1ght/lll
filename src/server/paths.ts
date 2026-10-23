import { existsSync } from "node:fs";
import { resolve } from "node:path";

/** Keep an existing installation's data when upgrading from the previous name. */
export function resolveDatabasePath(
  configured?: string,
  projectDirectory = process.cwd(),
): string {
  if (configured) return configured;
  const preferred = resolve(projectDirectory, "data/lll.sqlite");
  const legacy = resolve(projectDirectory, "data/recall.sqlite");
  return !existsSync(preferred) && existsSync(legacy) ? legacy : preferred;
}
