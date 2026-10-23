# lll

Self-hosted spaced repetition flashcards. React, Bun, SQLite, and system nginx; private accounts, Anki/CSV imports, offline review, and study statistics.

## Local development

Requires Bun 1.4.4 or later.

```sh
bun install --frozen-lockfile
bun run dev
```

Open [localhost:3000](http://localhost:3000) and create the first account. It becomes the administrator. Accounts require usernames and passwords of at least 12 characters; no email provider is required. In local development, leave `PUBLIC_ORIGIN` unset or set it to `http://localhost:3000`. Application data is stored in `data/lll.sqlite` and excluded from source control.

```sh
bun check
bun test
bun run build
bun run start
```

The production build includes the browser bundle, API server, and a separate import worker. It does not enable the development server or runtime compilation of the frontend.

## VPS installation (Ubuntu / Debian)

Use `scripts/vps.sh` on an Ubuntu or Debian VPS with systemd. Run `bash scripts/vps.sh --help` for supported releases and all options. Point your domain's DNS A record at the VPS; if an AAAA record exists, it must also reach this server. Allow inbound TCP ports 80 and 443 in your provider's network rules and host firewall. The installer uses the system's native nginx service, installs the distro nginx package only when nginx is absent, and adds this site's configuration without replacing other sites. The installer does not change SSH, firewall rules, or perform a full operating-system upgrade or reboot.

Push the deployment files to your repository first. Copy this checkout to the VPS, or clone it if Git is already installed, then replace `REPO_URL` and the example domain/email below:

```sh
sudo bash scripts/vps.sh install \
  --repo REPO_URL \
  --domain cards.example.com \
  --email you@example.com \
  --agree-tos \
  --timezone Europe/Moscow
```

`--agree-tos` accepts the [Let's Encrypt subscriber agreement](https://letsencrypt.org/repository/) for your domain. The default branch is `main` and first administrator username is `admin`; use `--branch` and `--admin` to change them. At the end, an interactive terminal prompts for the administrator password without displaying it. With `--skip-admin` or noninteractive input, create the administrator afterward:

```sh
sudo lll admin create yourname Europe/Moscow
```

The script refreshes apt package indexes and installs required packages, including Git and Certbot. If Docker and Compose are missing, it uses [Docker's official signed apt repository](https://docs.docker.com/engine/install/ubuntu/). It refuses to replace conflicting container packages automatically. Bun runs inside the app image; no host Bun installation is needed. The app listens on `127.0.0.1:8080`; use `--app-port` if that port is occupied. System nginx handles public HTTP/HTTPS through `/etc/nginx/conf.d/lll.conf`. This filename is reserved for the installer, which refuses to overwrite an existing file without its ownership marker.

The installer obtains an HTTPS certificate, enables [Certbot renewal](https://eff-certbot.readthedocs.io/en/stable/using.html#renewing-certificates) with a system nginx reload hook, starts the app, and enables daily database backups. ACME challenge files live in `/var/lib/lll/acme` and remain public during application maintenance. Configuration is stored in `/etc/lll`, releases and deployment state in `/opt/lll`, and the `lll` command in `/usr/local/bin`. Library data and snapshots persist in Docker volumes `lll_lll-data` and `lll_lll-backups` across updates. Copy snapshots and their checksum sidecars off the VPS; these volumes do not protect against host loss.

For a private repository, use `--repo git@YOUR_GIT_HOST:OWNER/REPOSITORY.git` with a read-only SSH deploy key available to root. Configure root's SSH identity and `known_hosts` before installation, verifying the Git host's fingerprint through a trusted source. Fetches require strict host-key checks and never prompt for credentials. Do not put tokens or passwords in a repository URL. This installer does not adopt an existing manual Compose deployment or its data automatically; migrate it explicitly before using this path.

Application updates are manual by default. After pushing changes to the configured branch, run:

```sh
sudo lll update
sudo lll status
```

Updates accept only fast-forward changes. The script stages the candidate configuration, builds the image, and checks its locked dependencies against the 14-day age and reviewed-source policy while the existing app remains available. Rejected builds retain the working runtime configuration. It then enables this site's maintenance response and verifies HTTPS requests for the domain reach that response before stopping the app and scheduled backups. After taking a database snapshot, it starts the candidate app while maintenance remains active. A failed app health check restores the previous image and snapshot to a new database path before lifting maintenance; it preserves the failed database for inspection. Updates briefly interrupt this site's service during this stage. The system nginx service and unrelated sites stay running.

If the process is interrupted with an update pending, run `sudo lll recover` to restore that saved state. Once a healthy candidate is committed, the script does not automatically restore an older database: new public writes must be preserved. If system nginx validation or reload fails at that point, fix the reported cause and run `sudo lll start`. Use `sudo lll logs app` for container logs and `sudo lll logs nginx` for the native nginx service journal. Request logs are in `/var/log/nginx/lll.access.log` and `/var/log/nginx/lll.error.log`.

To opt into hourly checks, or return to manual updates:

```sh
sudo lll enable-auto-updates
sudo lll disable-auto-updates
```

The timer uses the same deployment checks and recovery behavior as `sudo lll update`; inspect its runs with `journalctl -u lll-update.service`. Certificate renewal remains automatic independently of the application update timer. `sudo lll backup` creates an extra snapshot, and `sudo lll renew-cert` checks certificate renewal and reloads nginx.

Treat write access to the configured repository branch as administrative VPS access. Deployments execute its Docker build and replace the root-owned updater with the repository's version. Protect that branch and review changes before pushing or enabling the timer. The installer is designed for this stack; an actual remote VPS provisioning run has not been verified in this repository's local checks.

If you already deployed with the older installer that ran nginx in Docker, copy or check out the updated repository and run `sudo bash scripts/vps.sh update` from that checkout for the first migration. The old installed `lll` command refers to the obsolete HTTPS Compose file. The updated script removes only the old nginx container belonging to the managed `lll` Compose project, publishes the app on localhost, and configures the native service. Existing application volumes are retained. Subsequent updates use `sudo lll update` normally.

## Docker and system nginx

For a deployment you manage directly with Compose, install Docker Engine, Docker Compose, and native nginx first. The app and optional backup process run in containers; nginx runs on the host. The managed VPS overlay requires Compose 2.24.4 or later.

```sh
cp .env.example .env
docker compose up -d --build
docker compose exec app bun run admin create yourname Europe/Moscow
```

The administrator command reads the password without displaying it. The app is available at [localhost:8080](http://localhost:8080) on the Docker host only. `APP_PORT` changes this localhost port; Compose always binds to `127.0.0.1`. SQLite, media, and pending import previews persist in the `lll-data` volume. Only run one app instance against this database.

Browser setup is disabled in production unless `BOOTSTRAP_TOKEN` is configured. Prefer the administrator command above; if enabling browser setup, enter that token when creating the first administrator, then remove it from your environment. Administrator creation is atomic and cannot run again after setup.

For an existing HTTPS nginx site, proxy to `http://127.0.0.1:8080`, preserve the `Host` header, set `X-Forwarded-Proto` to `https`, and set `PUBLIC_ORIGIN` to the exact external origin in `.env`. `nginx/default.conf` is a native HTTP proxy template, and `nginx/vps.conf` is the native HTTPS template used by the installer. Before copying either into the system nginx `conf.d` directory, replace `__DOMAIN__` and `__APP_PORT__`; replace `__IPV6_HTTP__` with `listen [::]:80;` (or remove it), and `__IPV6_HTTPS__` with `listen [::]:443 ssl;` (or remove it). The HTTPS template expects the certificate and key under `/etc/letsencrypt/live/lll/`. Configure certificate issuance and renewal with your host tooling before enabling that template, then validate with `sudo nginx -t` and reload the system service. Install only one lll site template at a time. The installer performs these steps automatically.

Production cookies require HTTPS; browsers treat localhost specially for local testing. Remote installation and offline PWA functionality require a valid HTTPS deployment. For this manual Compose path, supply and renew certificates using your existing certificate tooling. The VPS installer above handles certificate issuance and renewal with Certbot; the app itself does not request certificates.

Use `docker compose logs -f app` for app logs and `sudo journalctl -u nginx` for the native nginx service. `GET /api/health` is the application readiness endpoint. Uploads are limited to 50 MiB at nginx and by the importer. The app runs as an unprivileged container user.

## Accounts and recovery

Administrators can generate single-use invitations in Settings. Each invited account receives an independent private library and study history. Invitations expire after seven days. Password resets are available in the administrator section and revoke the account's existing sessions.

Operator recovery and invitation commands:

```sh
docker compose exec app bun run admin reset yourname
docker compose exec app bun run admin invite yourname
```

The second command prints an invitation link using `PUBLIC_ORIGIN`. Generated invitation links put their token in the URL fragment, which is not sent to the server. nginx access logs omit query strings and referrers. Invitation tokens and passwords should not be added to source control or logs.

## Cards, imports, and exports

- Create Basic cards, reverse pairs, vocabulary cards, or Cloze notes such as `The capital is {{c1::Paris::city}}.` Repeated deletion numbers generate one card per distinct number.
- Vocabulary cards support examples, language tags, optional device pronunciation, and optional typed recall. Typing is advisory; the learner always chooses the rating.
- Paste a CSV/TSV list or upload `.csv`, `.tsv`, `.txt`, `.apkg`, or an lll `.zip` bundle. Preview and map columns before committing. Quoted multiline CSV and UTF-8 BOM are supported.
- Anki import supports legacy schema 11 (`collection.anki2` / `collection.anki21`) and modern schema 18 (`collection.anki21b`), including protobuf metadata, Zstandard compression, hierarchy, tags, image/audio media, and supported Basic/reverse/Cloze templates. Custom templates require explicit field mapping or an acknowledged skip. JavaScript, add-ons, image occlusion, and arbitrary template execution are not imported. Unknown schemas and damaged archives produce an error.
- Imports start fresh FSRS study progress. Existing source identities or exact content in the destination deck are skipped as duplicates without resetting progress. Preview warnings identify missing or unsupported media.
- Export a deck as CSV for text interchange or as a portable lll ZIP containing note content and media. Importing the ZIP into another account makes a separate copy. Exports contain no account credentials or study history; use operator backups for complete recovery.

Imports are parsed in isolated workers with a 10-second deadline and at most two concurrent parsers. Limits: 50 MiB compressed, 200 MiB expanded, 50 MiB per entry, 20,000 archive entries, and 50,000 notes. Archive paths, expansion, CRC, Zstandard output, media signatures, and modern Anki media hashes are checked before commit. A failed commit rolls back decks, notes, and media together. Preview jobs expire after two hours.

## Scheduling, offline review, and statistics

Scheduling uses pinned `ts-fsrs` 5.4.2, with deterministic intervals, 90% desired retention, learning steps of 1 and 10 minutes, and a 10-minute relearning step. Defaults are 20 new cards per account per day, reviews before new cards, no daily review cap, and one sibling per study day. Retention, new-card limit, daily goal, typed recall, timezone, and theme can be changed in Settings.

Download a deck from Library before going offline. Card content and media are stored on that device; editing and importing require a connection. Each rating is saved to IndexedDB before advancing. Refreshing or restarting the app preserves pending answers. Browser storage may be evicted by the browser or cleared by the user, so sync regularly; a persistent-storage request is made when downloading.

Reviews sync on opening, focus, reconnect, and periodically while the app is visible. Browser background sync is not required. The server acknowledges event identities exactly once. If two offline devices study the same card, both reviews are preserved and its canonical schedule is replayed in deterministic order; its final interval can differ from the offline prediction. This initial implementation returns full library snapshots rather than cursor deltas, appropriate for a personal or small shared deployment.

Accounts have isolated downloads. Signing out removes that account's cached private data after pending reviews have safely synced; an expired server session retains the outbox for same-account reauthentication. Downloads must be refreshed when newly added media changes their offline readiness.

Analytics use actual, non-undone review events. Recall means self-rated recall (Hard/Good/Easy), not an independently measured test score. Active answer time is capped at one minute per review. A streak requires at least one completed answer per local calendar day; the daily goal is separate. Review events retain the timezone in which they were recorded, so later preference changes do not reassign past activity. Imported deck content earns no activity or streak credit. Due forecasts are estimates from current scheduling states.

## Backups and upgrades

Backups use SQLite `VACUUM INTO` for a consistent live snapshot, including media BLOBs. Each backup has a checksum manifest. The optional backup service runs immediately and then daily, retaining seven recent snapshots plus four weekly representatives:

```sh
docker compose --profile backup up -d
docker compose exec app bun run backup
```

The VPS installer enables this service automatically; use `sudo lll backup` for an additional managed snapshot. The direct Compose commands in this section apply to manually managed deployments; the VPS helper supplies its own release paths and overrides.

Copy backups off this host as part of your normal backup process. The named backup volume alone does not protect against host loss. To copy a snapshot, use `docker compose cp app:/backups/LLL-SNAPSHOT.sqlite ./backups/` and copy its `.json` sidecar too.

To restore, stop the app and backup service first. Restore to a **new destination path**; the restore command refuses to overwrite an existing database or WAL files:

```sh
docker compose stop app backup
docker compose run --rm --no-deps app bun run backup restore /backups/LLL-SNAPSHOT.sqlite /data/restored.sqlite
```

Set `DATABASE_PATH=/data/restored.sqlite` in `.env` for the app and backup service, then start them again. Keep the previous database until recovery is verified. The checksum and SQLite integrity check must pass before restoration. Never copy only a live database file while leaving its WAL behind.

Before upgrading, take a backup. Rebuild and restart with `docker compose up -d --build`; schema migrations run at startup. To roll back an incompatible schema upgrade, restore its pre-upgrade backup to a new path and run the corresponding application image.

For an existing deployment from before the rename, stop the old Compose project first. The project and volume names now use `lll`; Docker does not move old volumes automatically. Use a local Compose override to bind `lll-data` and `lll-backups` to the existing external volumes (typically `recall_recall-data` and `recall_recall-backups`; verify their actual names) before starting the new stack. Keep `DATABASE_PATH` pointed at the existing database until recovery is verified. Existing local `data/recall.sqlite` databases and older `recall-` backup snapshots remain supported.

## Dependency policy

`bunfig.toml` enforces `minimumReleaseAge = 1209600` (14 days), no exclusions, and `ignoreScripts = true`. `package.json` has an explicit empty `trustedDependencies` array, exact direct versions, and a committed lockfile. Installs in Docker use `--frozen-lockfile`. No Anki importer package, framework, UI toolkit, or charting library is added; the runtime package set is React, FSRS, and fflate.

```sh
bun run deps:check
bun audit
```

The policy checker validates **all** locked registry packages, including transitive/platform packages: reviewed upstream allowlist, exact stable version, verifiable publication time at least 14 days old, expected license, no deprecation, and lockfile integrity entries. Unknown packages or unavailable metadata fail the check. This supplements Bun's age gate, which only filters new resolution and leaves existing lock entries untouched. The reviewed upstream list lives in `scripts/dependency-policy.ts`. `trustedDependencies` controls lifecycle scripts; it does not certify runtime code. Dependencies still require source/provenance and advisory review when changed.

V1 intentionally excludes public signup, public deck discovery, collaborative editing, AI enrichment, push reminders, AnkiWeb sync, and migration of Anki review history.
