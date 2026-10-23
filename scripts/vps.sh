#!/usr/bin/env bash
# Ubuntu/Debian VPS installer. No host Bun installation is needed.
set -Eeuo pipefail
umask 077
SCRIPT_PATH=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && printf '%s/%s\n' "$PWD" "$(basename -- "${BASH_SOURCE[0]}")")

ROOT=/opt/lll
CONFIG=/etc/lll
PROGRAM=/usr/local/bin/lll
PUBLIC_DIRECTORY=/var/lib/lll
NGINX_SITE=/etc/nginx/conf.d/lll.conf
RUNTIME_DIRECTORY=''
REPO_URL='' BRANCH=main DOMAIN='' EMAIL='' CURRENT_SHA='' DATA_PATH=/data/lll.sqlite
PREVIOUS_SHA='' CANDIDATE_SHA='' SNAPSHOT='' ORIGINAL_DATA_PATH=''
ADMIN=admin TIMEZONE=UTC APP_PORT=8080 AGREE_TOS=0 SKIP_ADMIN=0

log() { printf '[lll] %s\n' "$*"; }
die() { printf '[lll] %s\n' "$*" >&2; exit 1; }
usage() {
  cat <<'HELP'
Usage:
  sudo bash scripts/vps.sh install --repo URL --domain cards.example.com \
    --email you@example.com --agree-tos [--branch main] [--admin admin] \
    [--timezone Europe/Moscow] [--app-port 8080] [--skip-admin]

Then, from anywhere on the VPS:
  sudo lll update                  Deploy new commits from the configured branch
  sudo lll status                  Show the revision, services, and timers
  sudo lll start                   Start/resume the current deployment
  sudo lll logs [app|nginx|backup]  Follow service logs
  sudo lll backup                  Take a consistent database snapshot
  sudo lll admin create|reset|invite USERNAME [TIMEZONE]
  sudo lll recover                 Recover an interrupted update before reopening
  sudo lll renew-cert              Renew this certificate and reload nginx
  sudo lll enable-auto-updates     Check the branch hourly (opt-in)
  sudo lll disable-auto-updates    Return to manual application updates

Requires Ubuntu 22.04/24.04/26.04/26.10 or Debian 12/13, systemd, and a domain
pointing at this VPS. The host nginx serves ports 80/443; Docker binds only
127.0.0.1:8080 (or --app-port). Existing nginx sites and SSH stay unchanged.
Private repos require a root-owned read-only SSH deploy key and known_hosts.
--agree-tos accepts the Let's Encrypt subscriber agreement for your domain.
No full OS upgrade, firewall replacement, or reboot is performed.
HELP
}

parse_install() {
  while (($#)); do
    case "$1" in
      --repo|--branch|--domain|--email|--admin|--timezone|--app-port)
        (($# >= 2)) && [[ -n "$2" && "$2" != --* ]] || die "Missing value for $1."
        case "$1" in
          --repo) REPO_URL=$2 ;; --branch) BRANCH=$2 ;; --domain) DOMAIN=$2 ;;
          --email) EMAIL=$2 ;; --admin) ADMIN=$2 ;; --timezone) TIMEZONE=$2 ;;
          --app-port) APP_PORT=$2 ;;
        esac
        shift 2 ;;
      --agree-tos) AGREE_TOS=1; shift ;;
      --skip-admin) SKIP_ADMIN=1; shift ;;
      *) die "Unknown install option: $1. Run --help for usage." ;;
    esac
  done
  validate_config
  [[ "$AGREE_TOS" == 1 ]] || die "Read the Let's Encrypt agreement, then pass --agree-tos."
}

validate_config() {
  # Restrict values before writing env files or passing them to host tools.
  [[ "$REPO_URL" =~ ^https://[A-Za-z0-9.-]+(/[A-Za-z0-9._~/-]+)+$ ||
     "$REPO_URL" =~ ^git@[A-Za-z0-9.-]+:[A-Za-z0-9._~/-]+$ ]] ||
    die "Use an HTTPS repo URL without credentials, or git@host:owner/repo.git."
  [[ "$BRANCH" =~ ^[A-Za-z0-9][A-Za-z0-9._/-]*$ && "$BRANCH" != *..* &&
     "$BRANCH" != *//* && "$BRANCH" != */ && "$BRANCH" != *.lock ]] || die "Invalid branch."
  [[ ${#DOMAIN} -le 253 && "$DOMAIN" == *.* && "$DOMAIN" != *..* &&
     "$DOMAIN" =~ ^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$ ]] || die "Use a lowercase domain name, without https:// or a port."
  local label
  local -a labels
  IFS=. read -r -a labels <<< "$DOMAIN"
  for label in "${labels[@]}"; do
    [[ ${#label} -le 63 && "$label" != -* && "$label" != *- ]] || die "Invalid domain label."
  done
  [[ "$EMAIL" =~ ^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$ ]] || die "Invalid certificate contact email."
  if [[ ! "$APP_PORT" =~ ^[1-9][0-9]{3,4}$ ]] || ((APP_PORT < 1024 || APP_PORT > 65535)); then
    die "Use an app port between 1024 and 65535."
  fi
  [[ "$DATA_PATH" =~ ^/data/[A-Za-z0-9_-]+\.sqlite$ ]] || die "Invalid managed database path."
  [[ -z "$CURRENT_SHA" || "$CURRENT_SHA" =~ ^[a-f0-9]{40,64}$ ]] || die "Invalid deployed revision."
}

read_config() {
  [[ -f "$CONFIG/settings" ]] || die "Install lll first. Run --help for usage."
  local key value
  while IFS='=' read -r key value; do
    case "$key" in
      REPO_URL) REPO_URL=$value ;; BRANCH) BRANCH=$value ;; DOMAIN) DOMAIN=$value ;;
      EMAIL) EMAIL=$value ;; APP_PORT) APP_PORT=$value ;; *) die "Unrecognized setting: $key." ;;
    esac
  done < "$CONFIG/settings"
  if [[ -f "$ROOT/state" ]]; then
    while IFS='=' read -r key value; do
      case "$key" in
        CURRENT_SHA) CURRENT_SHA=$value ;; DATA_PATH) DATA_PATH=$value ;;
        *) die "Unrecognized deployment state: $key." ;;
      esac
    done < "$ROOT/state"
  fi
  validate_config
}

write_state() {
  printf 'CURRENT_SHA=%s\nDATA_PATH=%s\n' "$CURRENT_SHA" "$DATA_PATH" > "$ROOT/state.tmp"
  mv "$ROOT/state.tmp" "$ROOT/state"
}

require_host() {
  [[ "$(uname -s)" == Linux ]] || die "Run this script on the Ubuntu/Debian VPS."
  [[ $EUID == 0 ]] || die "Run with sudo or as root."
  [[ -d /run/systemd/system ]] || die "This installer requires systemd."
}

lock_deployment() {
  mkdir -p "$ROOT" "$CONFIG"
  chmod 700 "$ROOT" "$CONFIG"
  exec 9>"$ROOT/deploy.lock"
  flock -w 1800 9 || die "Another deployment or certificate operation is still running."
}

assert_not_arcadia() {
  local directory=$1
  while :; do
    [[ ! -f "$directory/.arcconfig" ]] || die "The managed VPS directory cannot be inside Arcadia."
    [[ "$directory" != / ]] || break
    directory=$(dirname "$directory")
  done
}

install_packages() {
  # shellcheck disable=SC1091
  . /etc/os-release
  case "$ID:$VERSION_ID" in
    ubuntu:22.04|ubuntu:24.04|ubuntu:26.04|ubuntu:26.10|debian:12|debian:13) ;;
    *) die "Supported hosts: Ubuntu 22.04+ releases listed in --help, or Debian 12/13." ;;
  esac
  case "$(dpkg --print-architecture)" in
    amd64|arm64) ;;
    *) die "Use an amd64 or arm64 VPS supported by the Bun container image." ;;
  esac
  export DEBIAN_FRONTEND=noninteractive
  apt-get update
  apt-get install -y ca-certificates curl git openssh-client certbot util-linux
  if ! command -v nginx >/dev/null; then apt-get install -y nginx; fi
  nginx -t
  systemctl enable --now nginx
  if ! command -v docker >/dev/null || ! docker compose version >/dev/null 2>&1; then
    # Do not remove or replace another engine/container runtime automatically.
    local package
    for package in docker.io docker-compose docker-compose-v2 podman-docker containerd runc; do
      if dpkg-query -W -f='${Status}' "$package" 2>/dev/null | package_installed; then
        die "Conflicting package $package is installed. Migrate it to official Docker packages first."
      fi
    done
    install -m 0755 -d /etc/apt/keyrings
    curl --proto '=https' --tlsv1.2 -fsSL "https://download.docker.com/linux/$ID/gpg" -o /etc/apt/keyrings/docker.asc
    chmod 644 /etc/apt/keyrings/docker.asc
    cat > /etc/apt/sources.list.d/docker.sources <<SOURCES
Types: deb
URIs: https://download.docker.com/linux/$ID
Suites: $VERSION_CODENAME
Components: stable
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/docker.asc
SOURCES
    apt-get update
    apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  fi
  systemctl enable --now docker
  check_docker
}

# Match package status using Bash; no additional text-search tool on the VPS.
package_installed() { local status; status=$(cat); [[ "$status" == 'install ok installed' ]]; }

check_docker() {
  docker info >/dev/null
  local version major minor patch
  version=$(docker compose version --short)
  version=${version#v}
  [[ "$version" =~ ^([0-9]+)\.([0-9]+)\.([0-9]+)$ ]] || die "Use a stable Docker Compose release."
  major=${BASH_REMATCH[1]}; minor=${BASH_REMATCH[2]}; patch=${BASH_REMATCH[3]}
  ((major > 2 || (major == 2 && (minor > 24 || (minor == 24 && patch >= 4))))) ||
    die "Docker Compose 2.24.4 or later is required."
}

fetch_revision() {
  assert_not_arcadia "$ROOT"
  cd "$ROOT"
  if [[ ! -d "$ROOT/repository.git" ]]; then
    git init --bare "$ROOT/repository.git" >&2
    git --git-dir="$ROOT/repository.git" remote add origin "$REPO_URL"
  fi
  git --git-dir="$ROOT/repository.git" check-ref-format "refs/heads/$BRANCH"
  GIT_TERMINAL_PROMPT=0 GIT_SSH_COMMAND='ssh -o BatchMode=yes -o StrictHostKeyChecking=yes' \
    git --git-dir="$ROOT/repository.git" fetch --prune origin \
    "+refs/heads/$BRANCH:refs/remotes/origin/$BRANCH" >&2
  CANDIDATE_SHA=$(git --git-dir="$ROOT/repository.git" rev-parse "refs/remotes/origin/$BRANCH^{commit}")
  [[ "$CANDIDATE_SHA" =~ ^[a-f0-9]{40,64}$ ]] || die "Invalid repository revision."
  if [[ -n "$CURRENT_SHA" && "$CURRENT_SHA" != "$CANDIDATE_SHA" ]]; then
    git --git-dir="$ROOT/repository.git" merge-base --is-ancestor "$CURRENT_SHA" "$CANDIDATE_SHA" ||
      die "The configured branch was rewritten. Refusing a non-fast-forward deployment."
  fi
}

prepare_release() {
  local sha=$1 directory="$ROOT/releases/$1" staging required
  if [[ ! -d "$directory" ]]; then
    mkdir -p "$ROOT/releases"
    staging=$(mktemp -d "$ROOT/releases/.staging.XXXXXX")
    git --git-dir="$ROOT/repository.git" archive "$sha" | tar -x -C "$staging"
    mv "$staging" "$directory"
  fi
  for required in Dockerfile compose.yaml compose.vps.yaml nginx/vps.conf nginx/bootstrap.conf \
    scripts/vps.sh deploy/lll-update.service deploy/lll-update.timer; do
    [[ -f "$directory/$required" ]] ||
      die "The repo revision is missing $required. Push the deployment files first."
  done
  bash -n "$directory/scripts/vps.sh"
}

compose() {
  local sha=$1; shift
  local release="$ROOT/releases/$sha" runtime
  runtime=$(runtime_directory)
  LLL_REVISION="$sha" DATABASE_PATH="$DATA_PATH" APP_PORT="$APP_PORT" PUBLIC_ORIGIN="https://$DOMAIN" \
    BOOTSTRAP_TOKEN='' COMPOSE_DISABLE_ENV_FILE=true \
    docker compose --project-name lll --project-directory "$release" \
    --env-file "$CONFIG/app.env" -f "$release/compose.yaml" \
    -f "$runtime/compose.vps.yaml" \
    --profile backup "$@"
}

build_release() {
  local sha=$1 staged
  staged=$(mktemp -d "$CONFIG/runtime.XXXXXX")
  if ! sync_runtime_configuration "$sha" "$staged"; then rm -rf "$staged"; return 1; fi
  if ! RUNTIME_DIRECTORY="$staged" compose "$sha" config --quiet; then rm -rf "$staged"; return 1; fi
  if ! docker build --pull --tag "lll:$sha" "$ROOT/releases/$sha"; then rm -rf "$staged"; return 1; fi
  # Recheck the committed lockfile, including dependencies Bun's age gate skips.
  if ! docker run --rm "lll:$sha" bun scripts/dependency-policy.ts; then rm -rf "$staged"; return 1; fi
  # Keep the prior runtime usable when a candidate fails. Promote this complete
  # directory atomically only after validation, build, and policy checks pass.
  rm -f "$CONFIG/runtime.next"
  ln -s "$staged" "$CONFIG/runtime.next"
  mv -Tf "$CONFIG/runtime.next" "$CONFIG/runtime"
}

take_snapshot() {
  local sha=$1
  compose "$sha" run --rm -T --no-deps app bun -e \
    'import { backup } from "./scripts/backup.ts"; console.log(await backup(process.env.DATABASE_PATH, "/backups"));'
}

save_pending() {
  printf 'PREVIOUS_SHA=%s\nCANDIDATE_SHA=%s\nSNAPSHOT=%s\nORIGINAL_DATA_PATH=%s\n' \
    "$CURRENT_SHA" "$CANDIDATE_SHA" "$SNAPSHOT" "$DATA_PATH" > "$ROOT/pending.tmp"
  mv "$ROOT/pending.tmp" "$ROOT/pending"
}

read_pending() {
  local key value
  while IFS='=' read -r key value; do
    case "$key" in
      PREVIOUS_SHA) PREVIOUS_SHA=$value ;; CANDIDATE_SHA) CANDIDATE_SHA=$value ;;
      SNAPSHOT) SNAPSHOT=$value ;; ORIGINAL_DATA_PATH) ORIGINAL_DATA_PATH=$value ;;
      *) die "Invalid interrupted deployment record." ;;
    esac
  done < "$ROOT/pending"
  [[ "$PREVIOUS_SHA" =~ ^[a-f0-9]{40,64}$ && "$CANDIDATE_SHA" =~ ^[a-f0-9]{40,64}$ &&
     "$SNAPSHOT" =~ ^/backups/lll-[A-Za-z0-9-]+\.sqlite$ &&
     "$ORIGINAL_DATA_PATH" =~ ^/data/[A-Za-z0-9_-]+\.sqlite$ ]] || die "Invalid interrupted deployment record."
}

recover_update() {
  [[ -f "$ROOT/pending" ]] || die "There is no interrupted update to recover."
  read_pending
  log "Recovering the pre-update snapshot. The failed database will be preserved."
  ensure_native_updater
  enable_maintenance
  remove_legacy_proxy
  configure_nginx "$PREVIOUS_SHA" tls
  verify_maintenance
  compose "$CANDIDATE_SHA" stop backup app
  DATA_PATH="/data/lll-recovered-$(date -u +%Y%m%dT%H%M%S)-$$.sqlite"
  compose "$PREVIOUS_SHA" run --rm -T --no-deps app bun scripts/backup.ts restore "$SNAPSHOT" "$DATA_PATH"
  CURRENT_SHA=$PREVIOUS_SHA
  compose "$CURRENT_SHA" up -d --no-build --pull never --wait --wait-timeout 180 app
  write_state
  mv "$ROOT/pending" "$ROOT/last-recovery"
  compose "$CURRENT_SHA" up -d --no-build --pull never --wait --wait-timeout 180 backup
  disable_maintenance
  log "Recovered $CURRENT_SHA at $DATA_PATH; retained $ORIGINAL_DATA_PATH and $SNAPSHOT."
}

deploy_update() {
  [[ ! -f "$ROOT/pending" ]] || die "An earlier update was interrupted. Run sudo lll recover first."
  fetch_revision
  if [[ "$CANDIDATE_SHA" == "$CURRENT_SHA" ]]; then
    log "Already up to date ($CURRENT_SHA)."
    return
  fi
  prepare_release "$CANDIDATE_SHA"
  build_release "$CANDIDATE_SHA"
  ensure_native_updater
  # Gate only this site's traffic; the host nginx and its other sites stay up.
  # Existing requests drain when the app stops, before taking the snapshot.
  enable_maintenance
  remove_legacy_proxy
  configure_nginx "$CANDIDATE_SHA" tls
  verify_maintenance
  compose "$CURRENT_SHA" stop backup app
  if ! SNAPSHOT=$(take_snapshot "$CURRENT_SHA"); then
    compose "$CURRENT_SHA" up -d --no-build --pull never --wait --wait-timeout 180 app backup
    disable_maintenance
    die "Backup failed; the update was not started."
  fi
  [[ "$SNAPSHOT" =~ ^/backups/lll-[A-Za-z0-9-]+\.sqlite$ ]] || die "Unexpected backup output. The site remains stopped."
  save_pending
  if ! compose "$CANDIDATE_SHA" up -d --no-build --pull never --wait --wait-timeout 180 app; then
    log "The candidate failed its health check. Recovering before public ingress opens."
    recover_update
    die "Update failed; the previous version has been recovered."
  fi
  # Commit before removing maintenance. A crash after commit is resumed by start;
  # it must never restore an older snapshot after public writes become possible.
  CURRENT_SHA=$CANDIDATE_SHA
  write_state
  mv "$ROOT/pending" "$ROOT/last-update"
  install_program "$CURRENT_SHA"
  install_timers
  compose "$CURRENT_SHA" up -d --no-build --pull never --wait --wait-timeout 180 backup
  disable_maintenance
  log "Updated to $CURRENT_SHA. Pre-update snapshot: $SNAPSHOT"
}

install_program() {
  install -m 0755 "$ROOT/releases/$1/scripts/vps.sh" "$PROGRAM.tmp"
  mv "$PROGRAM.tmp" "$PROGRAM"
}

runtime_directory() {
  if [[ -n "${RUNTIME_DIRECTORY:-}" ]]; then printf '%s\n' "$RUNTIME_DIRECTORY"
  elif [[ -d "$CONFIG/runtime" ]]; then printf '%s\n' "$CONFIG/runtime"
  else printf '%s\n' "$CONFIG"; fi
}

sync_runtime_configuration() {
  local sha=$1 target=$2
  install -m 0600 "$ROOT/releases/$sha/compose.vps.yaml" "$target/compose.vps.yaml" || return 1
  install -m 0600 "$ROOT/releases/$sha/nginx/vps.conf" "$target/nginx.tls.conf" || return 1
  install -m 0600 "$ROOT/releases/$sha/nginx/bootstrap.conf" "$target/nginx.bootstrap.conf"
}

ensure_native_updater() {
  # During the first migration the installed helper may still use Docker nginx.
  # Persist this running native helper before removing that proxy, so recovery
  # and Certbot hooks also work if the application update is interrupted.
  if [[ "$SCRIPT_PATH" != "$PROGRAM" ]]; then
    install -m 0755 "$SCRIPT_PATH" "$PROGRAM.tmp"
    mv "$PROGRAM.tmp" "$PROGRAM"
  fi
}

prepare_public_directory() {
  # nginx workers can traverse this directory; settings and keys stay private.
  install -d -m 0755 "$PUBLIC_DIRECTORY" "$PUBLIC_DIRECTORY/acme" \
    "$PUBLIC_DIRECTORY/acme/.well-known" "$PUBLIC_DIRECTORY/acme/.well-known/acme-challenge"
  # Older certificate lineages still write to /etc/lll/acme. Keep that path
  # usable by root while nginx serves the same files from the public directory.
  if [[ -L "$CONFIG/acme" ]]; then
    [[ "$(readlink "$CONFIG/acme")" == "$PUBLIC_DIRECTORY/acme" ]] || die "Unexpected legacy ACME link."
  else
    if [[ -e "$CONFIG/acme" ]]; then
      [[ -d "$CONFIG/acme" ]] || die "The legacy ACME path is not a directory."
      cp -a "$CONFIG/acme/." "$PUBLIC_DIRECTORY/acme/"
      mv "$CONFIG/acme" "$CONFIG/acme.before-native-$(date -u +%Y%m%dT%H%M%S)-$$"
    fi
    ln -s "$PUBLIC_DIRECTORY/acme" "$CONFIG/acme"
  fi
  chmod 755 "$PUBLIC_DIRECTORY/acme" "$PUBLIC_DIRECTORY/acme/.well-known" \
    "$PUBLIC_DIRECTORY/acme/.well-known/acme-challenge"
}

enable_maintenance() {
  prepare_public_directory
  touch "$PUBLIC_DIRECTORY/maintenance"
  chmod 644 "$PUBLIC_DIRECTORY/maintenance"
}

disable_maintenance() { rm -f "$PUBLIC_DIRECTORY/maintenance"; }

verify_maintenance() {
  local response status attempt ready=0
  response=$(mktemp "$ROOT/maintenance-probe.XXXXXX")
  for ((attempt = 0; attempt < 10; attempt++)); do
    status=$(curl --noproxy '*' --silent --show-error --max-time 5 \
      --resolve "$DOMAIN:443:127.0.0.1" --output "$response" --write-out '%{http_code}' \
      "https://$DOMAIN/api/health" 2>/dev/null || true)
    if [[ "$status" == 503 && "$(cat "$response")" == lll-maintenance ]]; then ready=1; break; fi
    sleep 1
  done
  rm "$response"
  [[ "$ready" == 1 ]] || die "The domain does not reach lll's maintenance gate. Check for another nginx site with this server_name. The database was not reopened."
}

remove_legacy_proxy() {
  # Only remove containers belonging to the old managed lll proxy. Never stop
  # the host nginx or another project's containers during this migration.
  local ids id
  ids=$(docker ps -aq --filter label=com.docker.compose.project=lll --filter label=com.docker.compose.service=nginx)
  for id in $ids; do docker rm -f "$id" >/dev/null; done
  if [[ "$(docker inspect --format '{{index .Config.Labels "io.lll.bootstrap"}}' lll-acme 2>/dev/null || true)" == "$ROOT" ]]; then
    docker rm -f lll-acme >/dev/null
  fi
}

configure_nginx() {
  local sha=$1 mode=${2:-tls} template="$ROOT/releases/$1/nginx/vps.conf"
  local candidate previous='' first ipv6_http='' ipv6_https=''
  [[ "$mode" == tls || "$mode" == bootstrap ]] || die "Invalid nginx configuration mode."
  [[ "$mode" == tls ]] || template="$ROOT/releases/$sha/nginx/bootstrap.conf"
  # A pre-migration image can still be recovered, but its Docker-only nginx
  # template must never be installed into the host's nginx.
  first=''
  if [[ -f "$template" ]]; then IFS= read -r first < "$template"; fi
  if [[ "$first" != '# Managed by lll' ]]; then template="$(runtime_directory)/nginx.$mode.conf"; fi
  [[ -f "$template" ]] || die "The native nginx template is missing. Run the updated repo's deployment script."
  if [[ -e "$NGINX_SITE" || -L "$NGINX_SITE" ]]; then
    IFS= read -r first < "$NGINX_SITE"
    [[ "$first" == '# Managed by lll' && ! -L "$NGINX_SITE" ]] || die "Refusing to replace an unmanaged $NGINX_SITE."
  fi
  # Test the existing host setup first so unrelated configuration errors are
  # reported before changing this site's file.
  nginx -t || return 1
  if [[ -r /proc/net/if_inet6 && -n "$(cat /proc/net/if_inet6)" ]]; then
    ipv6_http='listen [::]:80;'
    ipv6_https='listen [::]:443 ssl;'
  fi
  candidate=$(mktemp "${NGINX_SITE}.candidate.XXXXXX")
  sed -e "s/__DOMAIN__/$DOMAIN/g" -e "s/__APP_PORT__/$APP_PORT/g" \
    -e "s/__IPV6_HTTP__/$ipv6_http/g" -e "s/__IPV6_HTTPS__/$ipv6_https/g" \
    "$template" > "$candidate"
  chmod 644 "$candidate"
  if [[ -f "$NGINX_SITE" ]]; then
    previous=$(mktemp "$CONFIG/nginx.previous.XXXXXX")
    cp -p "$NGINX_SITE" "$previous"
  fi
  mv "$candidate" "$NGINX_SITE"
  if ! nginx -t; then
    if [[ -n "$previous" ]]; then mv "$previous" "$NGINX_SITE"; else rm "$NGINX_SITE"; fi
    log "The candidate nginx configuration was rejected; the previous file was restored." >&2
    return 1
  fi
  local action=reload
  if ! systemctl is-active --quiet nginx; then action=start; fi
  if ! systemctl "$action" nginx; then
    if [[ -n "$previous" ]]; then mv "$previous" "$NGINX_SITE"; else rm "$NGINX_SITE"; fi
    nginx -t && systemctl reload nginx || true
    log "nginx could not apply the candidate; the previous file was restored." >&2
    return 1
  fi
  [[ -z "$previous" ]] || rm "$previous"
}

issue_certificate() {
  prepare_public_directory
  remove_legacy_proxy
  configure_nginx "$CANDIDATE_SHA" bootstrap
  local attempt ready=0
  printf 'lll-acme-ready\n' > "$PUBLIC_DIRECTORY/acme/.well-known/acme-challenge/lll-probe"
  chmod 644 "$PUBLIC_DIRECTORY/acme/.well-known/acme-challenge/lll-probe"
  for ((attempt = 0; attempt < 30; attempt++)); do
    if [[ "$(curl -fsS --max-time 2 -H "Host: $DOMAIN" http://127.0.0.1/.well-known/acme-challenge/lll-probe 2>/dev/null || true)" == lll-acme-ready ]]; then
      ready=1; break
    fi
    sleep 1
  done
  rm "$PUBLIC_DIRECTORY/acme/.well-known/acme-challenge/lll-probe"
  [[ "$ready" == 1 ]] || die "The certificate challenge server did not become ready."
  # Challenge files must be readable by nginx workers; Certbot separately
  # protects private keys. Keep the installer's other files private.
  (umask 022
    certbot certonly --non-interactive --agree-tos --no-eff-email --email "$EMAIL" \
      --cert-name lll --domain "$DOMAIN" --webroot --webroot-path "$PUBLIC_DIRECTORY/acme" \
      --keep-until-expiring --deploy-hook "$PROGRAM reload-cert")
}

install_timers() {
  # Read units from the deployed release so future repo changes take effect.
  # Replacing their contents preserves the operator's enabled/disabled choice.
  install -m 0644 "$ROOT/releases/$CURRENT_SHA/deploy/lll-update.service" /etc/systemd/system/lll-update.service
  install -m 0644 "$ROOT/releases/$CURRENT_SHA/deploy/lll-update.timer" /etc/systemd/system/lll-update.timer
  systemctl daemon-reload
  # certbot stores the deploy hook with this certificate; distro renewal also
  # reloads the host nginx after a successful webroot renewal.
  systemctl enable --now certbot.timer
}

install_vps() {
  parse_install "$@"
  install_packages
  lock_deployment
  [[ ! -f "$ROOT/state" ]] || die "lll is already installed. Use sudo lll update."
  if [[ -f "$CONFIG/settings" ]]; then
    local expected="$REPO_URL|$BRANCH|$DOMAIN|$EMAIL|$APP_PORT"
    read_config
    [[ "$expected" == "$REPO_URL|$BRANCH|$DOMAIN|$EMAIL|$APP_PORT" ]] || die "The saved installation settings differ. Resume with the original options."
  else
    [[ -z "$(docker ps -aq --filter label=com.docker.compose.project=lll)" ]] || die "An unmanaged lll Compose project already exists."
    if docker volume inspect lll_lll-data >/dev/null 2>&1; then die "An existing lll data volume needs a manual migration; it will not be replaced."; fi
    printf 'REPO_URL=%s\nBRANCH=%s\nDOMAIN=%s\nEMAIL=%s\nAPP_PORT=%s\n' "$REPO_URL" "$BRANCH" "$DOMAIN" "$EMAIL" "$APP_PORT" > "$CONFIG/settings"
  fi
  cat > "$CONFIG/app.env" <<ENV
PUBLIC_ORIGIN=https://$DOMAIN
APP_PORT=$APP_PORT
BOOTSTRAP_TOKEN=
ENV
  fetch_revision
  prepare_release "$CANDIDATE_SHA"
  build_release "$CANDIDATE_SHA"
  install_program "$CANDIDATE_SHA"
  enable_maintenance
  issue_certificate
  CURRENT_SHA=$CANDIDATE_SHA
  compose "$CURRENT_SHA" up -d --no-build --pull never --wait --wait-timeout 180 app
  write_state
  install_timers
  configure_nginx "$CURRENT_SHA" tls
  verify_maintenance
  compose "$CURRENT_SHA" up -d --no-build --pull never --wait --wait-timeout 180 backup
  disable_maintenance
  log "Ready at https://$DOMAIN. Application updates are manual."
  if [[ "$SKIP_ADMIN" == 0 && -t 0 ]]; then
    compose "$CURRENT_SHA" exec app bun scripts/admin.ts create "$ADMIN" "$TIMEZONE"
  else
    log "Create the first administrator: sudo lll admin create $ADMIN $TIMEZONE"
  fi
  [[ ! -f /var/run/reboot-required ]] || log "The host reports a pending reboot. Schedule it separately."
}

reload_certificate() {
  nginx -t || return 1
  systemctl reload nginx
}

main() {
  local command=${1:---help}; (($# == 0)) || shift
  case "$command" in -h|--help|help) usage; return ;; esac
  case "$command" in
    install|update|start|status|logs|backup|admin|recover|renew-cert|reload-cert|enable-auto-updates|disable-auto-updates) ;;
    *) die "Unknown command: $command. Run --help for usage." ;;
  esac
  case "$command" in
    install|logs|admin) ;;
    *) (($# == 0)) || die "Unexpected arguments for $command." ;;
  esac
  require_host
  if [[ "$command" == install ]]; then install_vps "$@"; return; fi
  # Certbot's hook must also work during first issuance, while installation holds
  # the deployment lock and no app state exists. It does not need Docker.
  if [[ "$command" == reload-cert ]]; then reload_certificate; return; fi
  read_config
  [[ -n "$CURRENT_SHA" ]] || die "Installation is incomplete. Rerun the install command."
  check_docker
  case "$command" in logs|status) ;; *) lock_deployment ;; esac
  # A queued operation may have waited while another update recovered to a new
  # database. Never mutate using state captured before acquiring the lock.
  case "$command" in logs|status) ;; *) read_config ;; esac
  case "$command" in
    update) deploy_update ;;
    start)
      [[ ! -f "$ROOT/pending" ]] || die "An update was interrupted. Run sudo lll recover first."
      ensure_native_updater
      enable_maintenance
      remove_legacy_proxy
      configure_nginx "$CURRENT_SHA" tls
      verify_maintenance
      compose "$CURRENT_SHA" up -d --no-build --pull never --wait --wait-timeout 180 app
      compose "$CURRENT_SHA" up -d --no-build --pull never --wait --wait-timeout 180 backup
      disable_maintenance ;;
    status)
      log "https://$DOMAIN | branch $BRANCH | revision $CURRENT_SHA | database $DATA_PATH"
      compose "$CURRENT_SHA" ps
      systemctl --no-pager status nginx
      systemctl list-timers --all certbot.timer lll-update.timer ;;
    logs)
      [[ $# -le 1 && ( $# == 0 || "$1" =~ ^(app|nginx|backup)$ ) ]] || die "Choose app, nginx, or backup."
      if [[ "${1:-}" == nginx ]]; then
        journalctl -u nginx.service -n 100 -f
      elif [[ $# == 0 ]]; then
        compose "$CURRENT_SHA" logs --tail 100 -f app backup
      else
        compose "$CURRENT_SHA" logs --tail 100 -f "$@"
      fi ;;
    backup) take_snapshot "$CURRENT_SHA" ;;
    admin) compose "$CURRENT_SHA" exec app bun scripts/admin.ts "$@" ;;
    recover) recover_update ;;
    renew-cert)
      (umask 022; certbot renew --cert-name lll --non-interactive --deploy-hook /bin/true)
      reload_certificate ;;
    reload-cert) reload_certificate ;;
    enable-auto-updates) systemctl enable --now lll-update.timer; log "Hourly application updates enabled." ;;
    disable-auto-updates) systemctl disable --now lll-update.timer; log "Application updates are manual." ;;
  esac
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then main "$@"; fi
