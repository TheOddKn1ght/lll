FROM oven/bun:1.4.4 AS base
WORKDIR /app

FROM base AS dependencies
COPY package.json bun.lock bunfig.toml ./
RUN bun install --frozen-lockfile

FROM dependencies AS build
COPY src ./src
COPY public ./public
COPY tsconfig.json bun-env.d.ts ./
RUN bun run build

FROM base AS production-dependencies
COPY package.json bun.lock bunfig.toml ./
RUN bun install --frozen-lockfile --production

FROM base AS runtime
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 DATABASE_PATH=/data/lll.sqlite
RUN mkdir -p /data /backups && chown -R bun:bun /data /backups
COPY --chown=bun:bun --from=production-dependencies /app/node_modules ./node_modules
COPY --chown=bun:bun --from=build /app/dist ./dist
COPY --chown=bun:bun package.json bun.lock bunfig.toml ./
COPY --chown=bun:bun public ./public
COPY --chown=bun:bun scripts ./scripts
COPY --chown=bun:bun src/server ./src/server
COPY --chown=bun:bun src/shared ./src/shared
USER bun
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD bun -e 'const r=await fetch("http://127.0.0.1:3000/api/health");process.exit(r.ok?0:1)'
CMD ["bun", "scripts/start.ts"]
