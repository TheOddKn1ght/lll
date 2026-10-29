# lll

Self-hosted spaced repetition flashcards with private accounts, Anki/CSV imports, offline review, and study statistics. Built with React, Bun, and SQLite.

Requires Bun 1.4.4+.

```sh
bun install --frozen-lockfile
bun run dev
```

Open http://localhost:3000 and create the first administrator account. Passwords require at least 12 characters. Data lives in `data/lll.sqlite`.

For an Ubuntu/Debian VPS with a domain and ports 80/443 open:

```sh
sudo bash scripts/vps.sh install \
  --repo https://github.com/TheOddKn1ght/lll.git \
  --domain cards.example.com --email you@example.com \
  --agree-tos --timezone Europe/Moscow
```

The installer configures Docker, system nginx, HTTPS, and daily backups. Manage with `sudo lll update`, `status`, `backup`, or `recover`; see `bash scripts/vps.sh --help` for options. Copy backups off-server.

For manual Docker setup, copy `.env.example` to `.env`, set `PUBLIC_ORIGIN` to your HTTPS origin, and run `docker compose up -d --build`. Create the administrator with `docker compose exec app bun run admin create yourname Europe/Moscow`.

Download decks before going offline and sync reviews regularly. Deck exports omit study history; use database backups for full recovery.
