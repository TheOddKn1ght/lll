/** HTTP is reserved for local development; deployed accounts require TLS. */
export function isSecureAccountOrigin(url: URL): boolean {
  return (
    url.protocol === "https:" ||
    (url.protocol === "http:" &&
      ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
  );
}
