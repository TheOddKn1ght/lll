import { serve } from "bun";
import { join, resolve } from "node:path";
import index from "./index.html";
import { createApplication } from "./server/application";

const production = process.env.NODE_ENV === "production";
const application = createApplication({ production });
const publicDirectory = resolve(process.env.PUBLIC_DIRECTORY || "public");

async function staticFile(pathname: string) {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return new Response("Invalid path", { status: 400 });
  }
  if (decoded.includes("\0") || decoded.split("/").includes(".."))
    return new Response("Not found", { status: 404 });
  if (
    decoded !== "/sw.js" &&
    !decoded.startsWith("/icons/") &&
    decoded !== "/manifest.webmanifest"
  )
    return null;
  const directory = publicDirectory;
  const path = resolve(join(directory, decoded.replace(/^\/+/, "")));
  if (!path.startsWith(directory + "/")) return null;
  const file = Bun.file(path);
  if (await file.exists())
    return new Response(file, {
      headers: {
        "Cache-Control":
          decoded === "/sw.js" || decoded === "/manifest.webmanifest"
            ? "no-cache"
            : "public, max-age=31536000, immutable",
        ...(decoded === "/sw.js" ? { "Service-Worker-Allowed": "/" } : {}),
      },
    });
  return null;
}

const server = serve({
  port: Number(process.env.PORT || 3000),
  hostname: process.env.HOST || "0.0.0.0",
  maxRequestBodySize: 100 * 1024 * 1024,
  routes: {
    "/": index,
    "/*": index,
    "/api": application.fetch,
    "/api/*": application.fetch,
    "/sw.js": async (req) =>
      (await staticFile(new URL(req.url).pathname)) ??
      new Response("Not found", { status: 404 }),
    "/manifest.webmanifest": async (req) =>
      (await staticFile(new URL(req.url).pathname)) ??
      new Response("Not found", { status: 404 }),
    "/icons/*": async (req) =>
      (await staticFile(new URL(req.url).pathname)) ??
      new Response("Not found", { status: 404 }),
  },
  async fetch(request) {
    const pathname = new URL(request.url).pathname;
    if (pathname === "/api" || pathname.startsWith("/api/"))
      return application.fetch(request);
    if (!["GET", "HEAD"].includes(request.method))
      return new Response("Method not allowed", { status: 405 });
    const asset = await staticFile(pathname);
    if (asset) return asset;
    return new Response("Not found", { status: 404 });
  },
  development: production ? false : { hmr: true, console: true },
});

console.info(
  JSON.stringify({
    level: "info",
    message: "lll is ready",
    port: server.port,
  }),
);
let shuttingDown = false;
const shutdown = async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  await server.stop(false);
  application.close();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
