/** Bindings and variables for the Worker and the Board Durable Object (see wrangler.jsonc). */
export interface Env {
  Board: DurableObjectNamespace;
  /** Browser Rendering binding. Absent or failing in local dev: screenshots are skipped. */
  BROWSER?: Fetcher;
  /** Comma-separated origins allowed to connect, upload and frame uploaded files. */
  ALLOWED_ORIGINS: string;
  /** The board site's origin, used to decide whether a page allows being framed. */
  BOARD_ORIGIN: string;
  /** This Worker's public base URL (no trailing slash), used to screenshot uploads. */
  PUBLIC_URL: string;
  TEACHER_CODE: string;
  DAILY_MESSAGE_BUDGET?: string;
}
