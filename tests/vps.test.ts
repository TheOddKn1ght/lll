import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const installer = new URL("../scripts/vps.sh", import.meta.url).pathname;
const previous = "a".repeat(40);
const candidate = "b".repeat(40);

/** Exercise the installer without access to provisioning or deployment tools. */
function shell(body: string, args: string[] = []) {
  const directory = mkdtempSync(join(tmpdir(), "lll-vps-test-"));
  try {
    const command = Bun.spawnSync({
      cmd: [
        "bash",
        "-c",
        `source "$1"
REAL_RECOVER_UPDATE=$(declare -f recover_update)
REAL_RELOAD_CERTIFICATE=$(declare -f reload_certificate)
REAL_CONFIGURE_NGINX=$(declare -f configure_nginx)
REAL_BUILD_RELEASE=$(declare -f build_release)
REAL_VERIFY_MAINTENANCE=$(declare -f verify_maintenance)
SOURCE_DIRECTORY=$(dirname "$(dirname "$1")")
shift
ROOT=$1
CONFIG="$ROOT/config"
PROGRAM="$ROOT/lll"
shift
CURRENT_SHA=${previous}
record() { printf '%s\\n' "$*" >> "$ROOT/events"; }
# These functions fail closed if a test accidentally reaches a host operation.
docker() { die 'Unexpected real Docker operation.'; }
git() { die 'Unexpected repository operation.'; }
systemctl() { die 'Unexpected system service operation.'; }
apt-get() { die 'Unexpected package installation.'; }
certbot() { die 'Unexpected certificate operation.'; }
curl() { die 'Unexpected network operation.'; }
ss() { die 'Unexpected host network inspection.'; }
install() { die 'Unexpected host file installation.'; }
nginx() { die 'Unexpected host nginx operation.'; }
sleep() { die 'Unexpected retry delay.'; }
require_host() { record require-host; }
check_docker() { record check-docker; }
lock_deployment() { record lock; }
install_packages() { die 'Unexpected host package provisioning.'; }
fetch_revision() { record fetch; CANDIDATE_SHA=${candidate}; }
prepare_release() { record "prepare $*"; }
build_release() { record "build $*"; }
compose() { record "compose $*"; }
take_snapshot() { record "snapshot $*"; printf '/backups/lll-test.sqlite\\n'; }
save_pending() { record save-pending; printf 'pending\\n' > "$ROOT/pending"; }
write_state() { record "state $CURRENT_SHA"; }
install_program() { record "program $*"; }
install_timers() { record timers; }
enable_maintenance() { record maintenance-on; }
disable_maintenance() { record maintenance-off; }
ensure_native_updater() { record native-updater; }
verify_maintenance() { record verify-maintenance; }
configure_nginx() { record "nginx $*"; }
remove_legacy_proxy() { record remove-legacy; }
sync_runtime_configuration() { record "runtime $*"; }
recover_update() { record recover; rm -f "$ROOT/pending"; }
${body}`,
        "lll-vps-test",
        installer,
        directory,
        ...args,
      ],
      stdout: "pipe",
      stderr: "pipe",
      timeout: 10_000,
    });
    let events: string[] = [];
    try {
      events = readFileSync(join(directory, "events"), "utf8")
        .trim()
        .split("\n");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return {
      status: command.exitCode,
      output: command.stdout.toString() + command.stderr.toString(),
      events,
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

const validOptions = [
  "--repo",
  "https://github.com/example/lll.git",
  "--domain",
  "cards.example.com",
  "--email",
  "admin@example.com",
  "--agree-tos",
];

test("VPS help and unknown commands need no host access", () => {
  const help = shell("main --help");
  expect(help.status, help.output).toBe(0);
  expect(help.output).toContain("sudo lll update");
  expect(help.events).toEqual([]);
  const invalid = shell("main nonsense");
  expect(invalid.status).toBe(1);
  expect(invalid.output).toContain("Unknown command: nonsense");
  expect(invalid.events).toEqual([]);
  const unexpected = shell("main update --surprise");
  expect(unexpected.status).toBe(1);
  expect(unexpected.output).toContain("Unexpected arguments for update");
  expect(unexpected.events).toEqual([]);
});

test("VPS install rejects unknown flags and absent values before provisioning", () => {
  for (const flags of [["--surprise"], ["--repo"], ["--repo", "--domain"]]) {
    const result = shell('parse_install "$@"', flags);
    expect(result.status, result.output).toBe(1);
    expect(result.output).toMatch(/Unknown install option|Missing value/);
    expect(result.events).toEqual([]);
  }
});

test("VPS settings reject unsafe repository, branch, and domain values", () => {
  const unsafe = [
    ["--repo", "https://user:token@github.com/example/lll.git"],
    ["--repo", "https://github.com/example/lll.git\nINJECTED=yes"],
    ["--repo", "file:///tmp/lll"],
    ["--branch", "../main"],
    ["--branch", "main;touch /tmp/lll-unsafe"],
    ["--domain", "cards.example.com:443"],
    ["--domain", "cards.example.com;touch /tmp/lll-unsafe"],
    ["--domain", "Cards.example.com"],
    ["--domain", "cards..example.com"],
    ["--domain", "-cards.example.com"],
  ];
  for (const pair of unsafe) {
    const result = shell('parse_install "$@"', [...validOptions, ...pair]);
    expect(result.status, pair.join(" ")).toBe(1);
    expect(result.events).toEqual([]);
  }
  const valid = shell('parse_install "$@"', validOptions);
  expect(valid.status, valid.output).toBe(0);
});

test("VPS update leaves services alone when the branch has no new commit", () => {
  const result =
    shell(`fetch_revision() { record fetch; CANDIDATE_SHA=$CURRENT_SHA; }
deploy_update`);
  expect(result.status, result.output).toBe(0);
  expect(result.output).toContain("Already up to date");
  expect(result.events).toEqual(["fetch"]);
});

test("VPS candidate build failure does not stop or change live services", () => {
  const result = shell(`build_release() { record "build $*"; return 1; }
deploy_update`);
  expect(result.status).not.toBe(0);
  expect(result.events).toEqual([
    "fetch",
    `prepare ${candidate}`,
    `build ${candidate}`,
  ]);
});

test("VPS snapshot failure restarts the previous revision without launching the candidate", () => {
  const result = shell(`take_snapshot() { record "snapshot $*"; return 1; }
deploy_update`);
  expect(result.status).toBe(1);
  expect(result.output).toContain("Backup failed");
  expect(result.events).toEqual([
    "fetch",
    `prepare ${candidate}`,
    `build ${candidate}`,
    "native-updater",
    "maintenance-on",
    "remove-legacy",
    `nginx ${candidate} tls`,
    "verify-maintenance",
    `compose ${previous} stop backup app`,
    `snapshot ${previous}`,
    `compose ${previous} up -d --no-build --pull never --wait --wait-timeout 180 app backup`,
    "maintenance-off",
  ]);
});

test("VPS update snapshots before migration and waits for app health before opening ingress", () => {
  const result = shell(`deploy_update
[[ ! -f "$ROOT/pending" && -f "$ROOT/last-update" ]]`);
  expect(result.status, result.output).toBe(0);
  expect(result.events).toEqual([
    "fetch",
    `prepare ${candidate}`,
    `build ${candidate}`,
    "native-updater",
    "maintenance-on",
    "remove-legacy",
    `nginx ${candidate} tls`,
    "verify-maintenance",
    `compose ${previous} stop backup app`,
    `snapshot ${previous}`,
    "save-pending",
    `compose ${candidate} up -d --no-build --pull never --wait --wait-timeout 180 app`,
    `state ${candidate}`,
    `program ${candidate}`,
    "timers",
    `compose ${candidate} up -d --no-build --pull never --wait --wait-timeout 180 backup`,
    "maintenance-off",
  ]);
});

test("VPS unhealthy candidate invokes recovery before opening ingress", () => {
  const result = shell(`compose() {
  record "compose $*"
  if [[ "$*" == '${candidate} up -d --no-build --pull never --wait --wait-timeout 180 app' ]]; then return 1; fi
}
deploy_update`);
  expect(result.status).toBe(1);
  expect(result.output).toContain("previous version has been recovered");
  expect(result.events).toEqual([
    "fetch",
    `prepare ${candidate}`,
    `build ${candidate}`,
    "native-updater",
    "maintenance-on",
    "remove-legacy",
    `nginx ${candidate} tls`,
    "verify-maintenance",
    `compose ${previous} stop backup app`,
    `snapshot ${previous}`,
    "save-pending",
    `compose ${candidate} up -d --no-build --pull never --wait --wait-timeout 180 app`,
    "recover",
  ]);
});

test("VPS update refuses an interrupted deployment before fetching or changing services", () => {
  const result = shell(`printf pending > "$ROOT/pending"
deploy_update`);
  expect(result.status).toBe(1);
  expect(result.output).toContain("sudo lll recover");
  expect(result.events).toEqual([]);
});

test("VPS queued mutation reloads revision and database path after taking the deployment lock", () => {
  const result = shell(`reads=0
read_config() {
  reads=$((reads + 1))
  if [[ "$reads" == 1 ]]; then
    CURRENT_SHA=${previous}
    DATA_PATH=/data/lll.sqlite
  else
    CURRENT_SHA=${candidate}
    DATA_PATH=/data/lll-recovered-new.sqlite
  fi
  record "read $CURRENT_SHA $DATA_PATH"
}
deploy_update() {
  [[ "$CURRENT_SHA" == ${candidate} && "$DATA_PATH" == /data/lll-recovered-new.sqlite ]] || die 'Stale deployment state.'
  record "deploy $CURRENT_SHA $DATA_PATH"
}
main update`);
  expect(result.status, result.output).toBe(0);
  expect(result.events).toEqual([
    "require-host",
    `read ${previous} /data/lll.sqlite`,
    "check-docker",
    "lock",
    `read ${candidate} /data/lll-recovered-new.sqlite`,
    `deploy ${candidate} /data/lll-recovered-new.sqlite`,
  ]);
});

test("VPS start waits for application health before reopening native nginx", () => {
  const result = shell(`read_config() { record read; }
main start`);
  expect(result.status, result.output).toBe(0);
  expect(result.events).toEqual([
    "require-host",
    "read",
    "check-docker",
    "lock",
    "read",
    "native-updater",
    "maintenance-on",
    "remove-legacy",
    `nginx ${previous} tls`,
    "verify-maintenance",
    `compose ${previous} up -d --no-build --pull never --wait --wait-timeout 180 app`,
    `compose ${previous} up -d --no-build --pull never --wait --wait-timeout 180 backup`,
    "maintenance-off",
  ]);
});

test("VPS start preserves maintenance when an interrupted update needs recovery", () => {
  const result = shell(`read_config() { record read; }
printf pending > "$ROOT/pending"
main start`);
  expect(result.status).toBe(1);
  expect(result.output).toContain("sudo lll recover");
  expect(result.events).toEqual([
    "require-host",
    "read",
    "check-docker",
    "lock",
    "read",
  ]);
});

test("VPS certificate renewal hook validates and reloads native nginx before the app is installed", () => {
  const result = shell(`eval "$REAL_RELOAD_CERTIFICATE"
CURRENT_SHA=''
nginx() { record "native-nginx $*"; }
systemctl() { record "systemctl $*"; }
reload_certificate`);
  expect(result.status, result.output).toBe(0);
  expect(result.events).toEqual(["native-nginx -t", "systemctl reload nginx"]);
});

test("VPS certificate renewal leaves nginx running unchanged when validation fails", () => {
  const result = shell(`eval "$REAL_RELOAD_CERTIFICATE"
nginx() { record "native-nginx $*"; return 1; }
systemctl() { record "systemctl $*"; }
reload_certificate`);
  expect(result.status).toBe(1);
  expect(result.events).toEqual(["native-nginx -t"]);
});

const pendingRecord = `printf '%s\\n' \
  'PREVIOUS_SHA=${previous}' \
  'CANDIDATE_SHA=${candidate}' \
  'SNAPSHOT=/backups/lll-before-update.sqlite' \
  'ORIGINAL_DATA_PATH=/data/lll.sqlite' > "$ROOT/pending"`;

test("VPS recovery uses the previous image and a new database before reopening ingress", () => {
  const result = shell(`eval "$REAL_RECOVER_UPDATE"
${pendingRecord}
write_state() {
  record "state $CURRENT_SHA $DATA_PATH"
  printf '%s\\n' "$CURRENT_SHA" "$DATA_PATH" > "$ROOT/state"
}
compose() {
  record "compose $*"
  if [[ "$*" == '${previous} up -d --no-build --pull never --wait --wait-timeout 180 backup' ]]; then
    [[ -f "$ROOT/state" && ! -f "$ROOT/pending" && -f "$ROOT/last-recovery" ]] || die 'Ingress opened before recovery was committed.'
  fi
}
recover_update
[[ "$ORIGINAL_DATA_PATH" == /data/lll.sqlite && "$DATA_PATH" != "$ORIGINAL_DATA_PATH" ]] || die 'Original database path was lost or reused.'
record "original $ORIGINAL_DATA_PATH"`);
  expect(result.status, result.output).toBe(0);
  const restore = result.events[6]!;
  expect(restore).toMatch(
    new RegExp(
      `^compose ${previous} run --rm -T --no-deps app bun scripts/backup\\.ts restore /backups/lll-before-update\\.sqlite /data/lll-recovered-[0-9]{8}T[0-9]{6}-[0-9]+\\.sqlite$`,
    ),
  );
  const recoveredPath = restore.split(" ").at(-1)!;
  expect(result.events).toEqual([
    "native-updater",
    "maintenance-on",
    "remove-legacy",
    `nginx ${previous} tls`,
    "verify-maintenance",
    `compose ${candidate} stop backup app`,
    restore,
    `compose ${previous} up -d --no-build --pull never --wait --wait-timeout 180 app`,
    `state ${previous} ${recoveredPath}`,
    `compose ${previous} up -d --no-build --pull never --wait --wait-timeout 180 backup`,
    "maintenance-off",
    "original /data/lll.sqlite",
  ]);
});

test("VPS failed snapshot restore retains recovery record and never opens ingress", () => {
  const result = shell(`eval "$REAL_RECOVER_UPDATE"
${pendingRecord}
compose() {
  record "compose $*"
  if [[ "$2" == run ]]; then return 42; fi
}
trap '[[ -f "$ROOT/pending" ]] && record pending-preserved' EXIT
recover_update`);
  expect(result.status, result.output).toBe(42);
  expect(result.events).toHaveLength(8);
  expect(result.events.slice(0, 6)).toEqual([
    "native-updater",
    "maintenance-on",
    "remove-legacy",
    `nginx ${previous} tls`,
    "verify-maintenance",
    `compose ${candidate} stop backup app`,
  ]);
  expect(result.events[6]).toStartWith(
    `compose ${previous} run --rm -T --no-deps app bun scripts/backup.ts restore /backups/lll-before-update.sqlite /data/lll-recovered-`,
  );
  expect(result.events[7]).toBe("pending-preserved");
});

test("VPS recovery rejects shell-looking or invalid pending settings without evaluation", () => {
  const result = shell(`eval "$REAL_RECOVER_UPDATE"
${pendingRecord}
printf '%s\\n' 'SNAPSHOT=$(record injected)' >> "$ROOT/pending"
recover_update`);
  expect(result.status).toBe(1);
  expect(result.output).toContain("Invalid interrupted deployment record");
  expect(result.events).toEqual([]);
});

test("VPS app ports must be unprivileged numeric ports", () => {
  for (const port of [
    "80",
    "443",
    "1023",
    "65536",
    "08080",
    "8080;id",
    "1e4",
  ]) {
    const result = shell('parse_install "$@"', [
      ...validOptions,
      "--app-port",
      port,
    ]);
    expect(result.status, port).toBe(1);
    expect(result.events).toEqual([]);
  }
  for (const port of ["1024", "8080", "65535"]) {
    const result = shell('parse_install "$@"', [
      ...validOptions,
      "--app-port",
      port,
    ]);
    expect(result.status, result.output).toBe(0);
  }
});

test("VPS failed runtime validation, build, or policy preserves active configuration", () => {
  for (const stage of ["runtime", "validation", "build", "policy"]) {
    const result = shell(
      `eval "$REAL_BUILD_RELEASE"
FAILURE_STAGE=$1
mkdir -p "$CONFIG/runtime-old"
for file in compose.vps.yaml nginx.tls.conf nginx.bootstrap.conf; do
  printf 'previous %s\n' "$file" > "$CONFIG/runtime-old/$file"
done
ln -s "$CONFIG/runtime-old" "$CONFIG/runtime"
sync_runtime_configuration() {
  record runtime
  for file in compose.vps.yaml nginx.tls.conf nginx.bootstrap.conf; do
    printf 'candidate %s\n' "$file" > "$2/$file"
  done
  [[ "$FAILURE_STAGE" != runtime ]]
}
compose() { record validation; [[ "$FAILURE_STAGE" != validation ]]; }
docker() {
  case "$1" in
    build) record build; [[ "$FAILURE_STAGE" != build ]] ;;
    run) record policy; [[ "$FAILURE_STAGE" != policy ]] ;;
    *) die 'Unexpected Docker operation.' ;;
  esac
}
if build_release '${candidate}'; then die 'The failing candidate was promoted.'; fi
[[ "$(readlink "$CONFIG/runtime")" == "$CONFIG/runtime-old" ]] || die 'Active configuration changed.'
for file in compose.vps.yaml nginx.tls.conf nginx.bootstrap.conf; do
  [[ "$(cat "$CONFIG/runtime/$file")" == "previous $file" ]] || die 'An active file changed.'
done
if compgen -G "$CONFIG/runtime.*" > /dev/null; then die 'Staging files were not cleaned up.'; fi`,
      [stage],
    );
    expect(result.status, `${stage}: ${result.output}`).toBe(0);
    const stages = ["runtime", "validation", "build", "policy"];
    expect(result.events).toEqual(stages.slice(0, stages.indexOf(stage) + 1));
  }
});

test("VPS maintenance verification requires the exact 503 marker", () => {
  for (const [status, body, accepted] of [
    ["503", "lll-maintenance\n", true],
    ["200", "lll-maintenance\n", false],
    ["503", "another site's error page", false],
    ["503", "lll-maintenance extra", false],
  ] as const) {
    const result = shell(
      `eval "$REAL_VERIFY_MAINTENANCE"
DOMAIN=cards.example.com
PROBE_STATUS=$1 PROBE_BODY=$2
sleep() { :; }
curl() {
  local output=''
  while (($#)); do
    if [[ "$1" == --output ]]; then output=$2; shift; fi
    shift
  done
  [[ "$output" == "$ROOT"/maintenance-probe.* ]] || die 'Unexpected output path.'
  record probe
  printf '%s' "$PROBE_BODY" > "$output"
  printf '%s' "$PROBE_STATUS"
}
verify_maintenance`,
      [status, body],
    );
    expect(result.status, result.output).toBe(accepted ? 0 : 1);
    expect(result.events).toEqual(Array(accepted ? 1 : 10).fill("probe"));
  }
});

test("VPS failed maintenance verification leaves the database untouched", () => {
  for (const command of ["deploy_update", "recover_update"]) {
    const result = shell(`eval "$REAL_RECOVER_UPDATE"
${command === "recover_update" ? pendingRecord : ""}
DATA_PATH="$ROOT/live.sqlite"
printf 'existing database' > "$DATA_PATH"
verify_maintenance() { record verify-maintenance; return 1; }
trap '[[ "$DATA_PATH" == "$ROOT/live.sqlite" && "$(cat "$ROOT/live.sqlite")" == "existing database" ]] && record database-preserved' EXIT
${command}`);
    expect(result.status, result.output).toBe(1);
    expect(result.events.at(-1)).toBe("database-preserved");
    expect(result.events).toContain("verify-maintenance");
    expect(
      result.events.some((event) =>
        /^(compose|snapshot|state|save-pending)/.test(event),
      ),
    ).toBe(false);
  }
});

const nativeNginxFixture = `eval "$REAL_CONFIGURE_NGINX"
mkdir -p "$CONFIG" "$ROOT/releases/${candidate}/nginx"
NGINX_SITE="$ROOT/lll.conf"
DOMAIN=cards.example.com APP_PORT=9080
cp "$SOURCE_DIRECTORY/nginx/vps.conf" "$ROOT/releases/${candidate}/nginx/vps.conf"
nginx() { record "native-nginx $*"; }
systemctl() { record "systemctl $*"; }`;

test("VPS nginx configuration renders the domain and loopback app port", () => {
  const result = shell(`${nativeNginxFixture}
configure_nginx '${candidate}' tls
cat "$NGINX_SITE"`);
  expect(result.status, result.output).toBe(0);
  expect(result.output).toContain("server_name cards.example.com;");
  expect(result.output).toContain("proxy_pass http://127.0.0.1:9080;");
  expect(result.output).not.toContain("__DOMAIN__");
  expect(result.output).not.toContain("__APP_PORT__");
  expect(result.output).toContain('return 503 "lll-maintenance\\n";');
  expect(result.events).toEqual([
    "native-nginx -t",
    "native-nginx -t",
    "systemctl is-active --quiet nginx",
    "systemctl reload nginx",
  ]);
});

test("VPS recovery uses the stable native template for an old Docker nginx release", () => {
  const result = shell(`${nativeNginxFixture}
eval "$REAL_RECOVER_UPDATE"
${pendingRecord}
mkdir -p "$ROOT/releases/${previous}/nginx" "$CONFIG/runtime"
printf '# Old container-only nginx\nproxy_pass http://app:3000;\n' > "$ROOT/releases/${previous}/nginx/vps.conf"
cp "$SOURCE_DIRECTORY/nginx/vps.conf" "$CONFIG/runtime/nginx.tls.conf"
recover_update
cat "$NGINX_SITE"`);
  expect(result.status, result.output).toBe(0);
  expect(result.output).toContain("proxy_pass http://127.0.0.1:9080;");
  expect(result.output).not.toContain("proxy_pass http://app:3000;");
  expect(result.events.indexOf("systemctl reload nginx")).toBeLessThan(
    result.events.indexOf("verify-maintenance"),
  );
  expect(result.events.indexOf("verify-maintenance")).toBeLessThan(
    result.events.indexOf(`compose ${candidate} stop backup app`),
  );
});

test("VPS invalid nginx configuration restores the previous site without reloading", () => {
  const result = shell(`${nativeNginxFixture}
printf '# Managed by lll\nprevious site\n' > "$NGINX_SITE"
checks=0
nginx() { checks=$((checks + 1)); record "native-nginx $*"; [[ "$checks" != 2 ]]; }
if configure_nginx '${candidate}' tls; then die 'Invalid nginx configuration accepted.'; fi
[[ "$(cat "$NGINX_SITE")" == $'# Managed by lll\nprevious site' ]] || die 'Previous configuration was lost.'`);
  expect(result.status, result.output).toBe(0);
  expect(result.output).toContain("previous file was restored");
  expect(result.events).toEqual(["native-nginx -t", "native-nginx -t"]);
});

test("VPS failed nginx reload restores and reapplies the previous configuration", () => {
  const result = shell(`${nativeNginxFixture}
printf '# Managed by lll\nprevious site\n' > "$NGINX_SITE"
reloads=0
systemctl() {
  record "systemctl $*"
  if [[ "$1" == reload ]]; then
    reloads=$((reloads + 1))
    [[ "$reloads" != 1 ]]
  fi
}
if configure_nginx '${candidate}' tls; then die 'Failed reload was accepted.'; fi
[[ "$(cat "$NGINX_SITE")" == $'# Managed by lll\nprevious site' ]] || die 'Previous configuration was lost.'`);
  expect(result.status, result.output).toBe(0);
  expect(result.events).toEqual([
    "native-nginx -t",
    "native-nginx -t",
    "systemctl is-active --quiet nginx",
    "systemctl reload nginx",
    "native-nginx -t",
    "systemctl reload nginx",
  ]);
});

test("VPS nginx configuration refuses unmanaged files and symlinks", () => {
  for (const type of ["file", "symlink"]) {
    const result = shell(
      `${nativeNginxFixture}
printf '# Unmanaged site\nkeep this site\n' > "$ROOT/original.conf"
if [[ "$1" == symlink ]]; then
  ln -s "$ROOT/original.conf" "$NGINX_SITE"
else
  cp "$ROOT/original.conf" "$NGINX_SITE"
fi
trap '[[ "$(cat "$NGINX_SITE")" == "$(cat "$ROOT/original.conf")" ]] && record unmanaged-preserved' EXIT
configure_nginx '${candidate}' tls`,
      [type],
    );
    expect(result.status, result.output).toBe(1);
    expect(result.output).toContain("Refusing to replace an unmanaged");
    expect(result.events).toEqual(["unmanaged-preserved"]);
  }
});
