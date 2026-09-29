const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/** Absolute URLs pass through unchanged; server-relative paths are resolved against the server's origin. */
export function serverHref(serverUrl: string, path: string): string {
  if (HAS_SCHEME.test(path)) return path;
  return new URL(path, serverUrl).href;
}
