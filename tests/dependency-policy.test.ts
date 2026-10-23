import { expect, test } from "bun:test";
import { parseLockfile, validateRelease } from "../scripts/dependency-policy";
test("dependency age policy fails closed for unknown or missing publication dates", () => {
  const now = Date.UTC(2026, 9, 23);
  const data = {
    time: { "1.0.0": new Date(now - 15 * 86400000).toISOString() },
    versions: {
      "1.0.0": {
        repository: { url: "git+https://github.com/react/react.git" },
        license: "MIT",
      },
    },
  };
  expect(validateRelease("react", "1.0.0", data, now)).toEqual([]);
  data.time["1.0.0"] = new Date(now - 13 * 86400000).toISOString();
  expect(validateRelease("react", "1.0.0", data, now).join()).toContain(
    "less than 14 days",
  );
  expect(validateRelease("unknown", "1.0.0", data, now).join()).toContain(
    "allowlist",
  );
  expect(
    validateRelease("react", "1.0.0", { ...data, time: {} }, now).join(),
  ).toContain("no verifiable publication");
});
test("lock parser handles Bun trailing commas", () =>
  expect(parseLockfile('{"packages":{},}')).toEqual({ packages: {} }));
