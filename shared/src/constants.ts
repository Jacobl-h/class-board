/** Grid: 8 rows (A–H) × 10 columns (1–10). */
export const ROWS = 8;
export const COLS = 10;
export const SLOT_COUNT = ROWS * COLS;

/** Board geometry in board units (1 unit = 1 CSS px at zoom 1). */
export const TILE_W = 480;
export const TILE_H = 300;
export const LABEL_H = 32;
export const GUTTER = 48;
export const COL_PITCH = TILE_W + GUTTER;
export const ROW_PITCH = LABEL_H + TILE_H + GUTTER;
export const BOARD_W = COLS * TILE_W + (COLS - 1) * GUTTER;
export const BOARD_H = ROWS * (LABEL_H + TILE_H) + (ROWS - 1) * GUTTER;

/** Embedded pages render at this size and are scaled down to the tile. */
export const FRAME_W = 1280;
export const FRAME_H = 800;
export const FRAME_SCALE = TILE_W / FRAME_W;

export const DEFAULT_BOARD = 'main';
export const BOARD_NAME_RE = /^[a-z0-9-]{1,40}$/;

export const LIMITS = {
  nameMax: 24,
  labelMax: 40,
  urlMax: 2048,
  htmlMaxBytes: 1_000_000,
  maxConnections: 150,
  historyLimit: 50,
} as const;

export const RATES = {
  cursorHz: 5,
  cursorSlowHz: 2,
  cursorBatchMs: 100,
  cursorPerSecond: 6,
  cursorBurst: 10,
  editsPerMinute: 10,
  historyPerMinute: 30,
  profilePerMinute: 10,
  teacherAttempts: 5,
  teacherWindowMs: 10 * 60_000,
  uploadsPerMinute: 5,
} as const;

export const BUDGET = {
  dailyMessages: 2_000_000,
  slowAt: 0.8,
  pauseAt: 0.9,
  persistEveryMs: 30_000,
} as const;

export const LIVE = {
  maxLive: 12,
  maxLiveLowMemory: 6,
  lowMemoryGb: 4,
  minWidthPx: 240,
  lingerMs: 2_000,
  mountBatch: 2,
  mountIntervalMs: 250,
} as const;

export const CURSOR = {
  idleMs: 20_000,
  idleOpacity: 0.35,
  renderDelayMs: 200,
  jumpGapMs: 1_000,
  imageSize: 32,
} as const;

export const FOCUS = { holdMs: 300 } as const;

export const LINK_CHECK = { timeoutMs: 5_000, maxRedirects: 5, maxHtmlBytes: 262_144 } as const;

export const SHOTS = {
  viewportW: 1280,
  viewportH: 800,
  maxWaitMs: 15_000,
  jpegQuality: 70,
  maxAttempts: 3,
  keepAliveMs: 60_000,
} as const;

/** The 12 cursor colors offered in the profile panel. */
export const COLORS = [
  '#D85A30', '#D4537E', '#7F77DD', '#378ADD', '#1D9E75', '#639922',
  '#BA7517', '#E24B4A', '#534AB7', '#0F6E56', '#993556', '#5F5E5A',
] as const;

export const SHAPES = ['arrow', 'hand', 'pencil', 'star', 'plane'] as const;

/** Pixel cursors: 16×16 cells. Palette index 0 = transparent, 1 = the profile color, 2–8 = these. */
export const ART_SIZE = 16;
export const ART_FIXED_COLORS = ['#000000', '#FFFFFF', '#E24B4A', '#EF9F27', '#639922', '#378ADD', '#7F77DD'] as const;
export const ART_MAX_INDEX = 1 + ART_FIXED_COLORS.length;
