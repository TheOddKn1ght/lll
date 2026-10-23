/** Reviewed upstreams, not Bun's lifecycle-script trust list. New packages fail
 * closed until deliberately added here after source/provenance review. */
export const approvedSources: Record<string, string> = {
  react: "react/react",
  "react-dom": "react/react",
  scheduler: "react/react",
  "ts-fsrs": "open-spaced-repetition/ts-fsrs",
  fflate: "101arrowz/fflate",
  "@types/react": "DefinitelyTyped/DefinitelyTyped",
  "@types/react-dom": "DefinitelyTyped/DefinitelyTyped",
  "@types/bun": "DefinitelyTyped/DefinitelyTyped",
  "@types/node": "DefinitelyTyped/DefinitelyTyped",
  "bun-types": "oven-sh/bun",
  "undici-types": "nodejs/undici",
  csstype: "frenic/csstype",
  typescript: "microsoft/TypeScript",
};
for (const platform of [
  "aix-ppc64",
  "darwin-arm64",
  "darwin-x64",
  "freebsd-arm64",
  "freebsd-x64",
  "linux-arm",
  "linux-arm64",
  "linux-loong64",
  "linux-mips64el",
  "linux-ppc64",
  "linux-riscv64",
  "linux-s390x",
  "linux-x64",
  "netbsd-arm64",
  "netbsd-x64",
  "openbsd-arm64",
  "openbsd-x64",
  "sunos-x64",
  "win32-arm64",
  "win32-x64",
])
  approvedSources[`@typescript/typescript-${platform}`] =
    "microsoft/TypeScript";

export function parseLockfile(source: string): {
  packages: Record<string, [string, string, unknown, string]>;
} {
  return JSON.parse(source.replace(/,\s*([}\]])/g, "$1"));
}
export function validateRelease(
  name: string,
  version: string,
  metadata: any,
  now = Date.now(),
): string[] {
  const errors: string[] = [];
  const expected = approvedSources[name];
  if (!expected) return [`${name}: not on the reviewed dependency allowlist`];
  const published = Date.parse(metadata.time?.[version]);
  if (!Number.isFinite(published))
    errors.push(`${name}@${version}: no verifiable publication timestamp`);
  else if (published > now - 14 * 86400000)
    errors.push(
      `${name}@${version}: published less than 14 days ago (${metadata.time[version]})`,
    );
  const release = metadata.versions?.[version];
  if (!release)
    return [
      ...errors,
      `${name}@${version}: version is missing from registry metadata`,
    ];
  const repository =
    typeof release.repository === "string"
      ? release.repository
      : release.repository?.url;
  const source = String(repository || "")
    .replace(/^git\+/, "")
    .replace(/\.git$/, "")
    .toLowerCase();
  if (
    source !== `https://github.com/${expected}`.toLowerCase() &&
    source !== `git://github.com/${expected}`.toLowerCase()
  )
    errors.push(
      `${name}@${version}: unexpected source ${repository || "(none)"}`,
    );
  if (!["MIT", "Apache-2.0"].includes(release.license))
    errors.push(`${name}@${version}: unreviewed license ${release.license}`);
  if (release.deprecated)
    errors.push(`${name}@${version}: deprecated: ${release.deprecated}`);
  return errors;
}

if (import.meta.main) {
  const root = new URL("../", import.meta.url);
  const manifest = await Bun.file(new URL("package.json", root)).json();
  const config = Bun.TOML.parse(
    await Bun.file(new URL("bunfig.toml", root)).text(),
  ) as {
    install: {
      minimumReleaseAge: number;
      minimumReleaseAgeExcludes: unknown[];
      ignoreScripts: boolean;
    };
  };
  const errors: string[] = [];
  if (
    config.install.minimumReleaseAge !== 1209600 ||
    config.install.minimumReleaseAgeExcludes.length ||
    !config.install.ignoreScripts
  )
    errors.push(
      "bunfig.toml must enforce 14 days, no exemptions, and disabled install scripts",
    );
  if (
    !Array.isArray(manifest.trustedDependencies) ||
    manifest.trustedDependencies.length
  )
    errors.push("trustedDependencies must be an explicit empty list");
  for (const [name, version] of Object.entries({
    ...manifest.dependencies,
    ...manifest.devDependencies,
  }))
    if (!/^\d+\.\d+\.\d+$/.test(String(version)))
      errors.push(`${name}: pin a stable exact version`);
  const lock = parseLockfile(await Bun.file(new URL("bun.lock", root)).text());
  const metadata = new Map<string, any>();
  for (const [entry, descriptor] of Object.entries(lock.packages)) {
    const resolved = descriptor[0];
    const index = resolved.lastIndexOf("@");
    const name = resolved.slice(0, index),
      version = resolved.slice(index + 1);
    if (
      descriptor[1] ||
      !/^\d+\.\d+\.\d+$/.test(version) ||
      !descriptor[3]?.startsWith("sha512-")
    ) {
      errors.push(
        `${entry}: registry package with stable version and SHA-512 integrity required`,
      );
      continue;
    }
    if (!approvedSources[name]) {
      errors.push(`${name}: not on the reviewed dependency allowlist`);
      continue;
    }
    try {
      let info = metadata.get(name);
      if (!info) {
        const response = await fetch(
          `https://registry.npmjs.org/${encodeURIComponent(name)}`,
          { signal: AbortSignal.timeout(15000) },
        );
        if (!response.ok)
          throw new Error(`registry returned ${response.status}`);
        info = await response.json();
        metadata.set(name, info);
      }
      errors.push(...validateRelease(name, version, info));
      console.log(`${name}@${version} · ${info.time?.[version] || "unknown"}`);
    } catch (error) {
      errors.push(`${name}: cannot verify registry metadata: ${error}`);
    }
  }
  if (errors.length) {
    console.error(
      `\nDependency policy failed:\n${errors.map((error) => `• ${error}`).join("\n")}`,
    );
    process.exitCode = 1;
  } else
    console.log(
      `\nVerified ${Object.keys(lock.packages).length} locked dependencies: reviewed upstreams, stable releases ≥14 days, integrity, and disabled install scripts.`,
    );
}
