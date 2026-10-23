/* Only the public application shell is cached here. Private data lives in
 * account-isolated IndexedDB, and authenticated API requests always bypass SW. */
const SHELL = "lll-shell-v1";
const ASSETS = [
  "/",
  "/manifest.webmanifest",
  "/icons/icon.svg",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/maskable-512.png",
  "/icons/apple-touch-icon.png",
];
self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL);
      const response = await fetch("/", {
        cache: "reload",
        credentials: "omit",
      });
      if (!response.ok) throw new Error("App shell unavailable");
      const html = await response.clone().text();
      const linked = [
        ...html.matchAll(
          /(?:src|href)=["']([^"']+\.(?:js|css)(?:\?[^"']*)?)["']/g,
        ),
      ]
        .map((match) => new URL(match[1], self.location.origin).href)
        .filter((url) => new URL(url).origin === self.location.origin);
      // Do not activate a partially cached shell.
      await cache.addAll(
        [...new Set([...ASSETS.slice(1), ...linked])].map(
          (url) => new Request(url, { credentials: "omit", cache: "reload" }),
        ),
      );
      await cache.put("/", response);
    })(),
  );
});
self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      for (const name of await caches.keys())
        if (
          (name.startsWith("lll-shell-") || name.startsWith("recall-shell-")) &&
          name !== SHELL
        )
          await caches.delete(name);
      await self.clients.claim();
    })(),
  );
});
self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (
    request.method !== "GET" ||
    url.origin !== self.location.origin ||
    url.pathname.startsWith("/api/") ||
    url.pathname.includes("_bun")
  )
    return;
  if (request.mode === "navigate") {
    event.respondWith(
      (async () => {
        try {
          const response = await fetch(request);
          if (response.ok)
            await (await caches.open(SHELL)).put("/", response.clone());
          return response;
        } catch {
          return (
            (await (await caches.open(SHELL)).match("/")) ||
            new Response("Open lll online once to enable offline study.", {
              status: 503,
              headers: { "Content-Type": "text/plain" },
            })
          );
        }
      })(),
    );
  } else if (/\.(?:js|css|svg|png|webmanifest|woff2?)$/.test(url.pathname)) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(SHELL);
        const cached = await cache.match(request);
        if (cached) return cached;
        const response = await fetch(request);
        if (response.ok) await cache.put(request, response.clone());
        return response;
      })(),
    );
  }
});
