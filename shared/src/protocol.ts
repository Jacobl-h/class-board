import * as v from 'valibot';
import { COLORS, LIMITS, SHAPES, SLOT_COUNT } from './constants';
import { isValidArt, isValidTip } from './pixelArt';
import type { ClientMsg, Profile } from './types';

/** Raw text longer than this is rejected outright; shorter text is cleaned and cut to its field limit. */
const RAW_TEXT_MAX = 200;

/** Removes control characters, collapses whitespace runs to one space, trims, and cuts to `max` characters. */
export function cleanText(s: string, max: number): string {
  // A run of control and whitespace characters becomes one space if it contains real whitespace, else nothing.
  const collapsed = s.replace(/[\p{Cc}\s]+/gu, (run) => (/\s/u.test(run) ? ' ' : '')).trim();
  return Array.from(collapsed).slice(0, max).join('').trimEnd();
}

export function defaultProfile(name?: string): Profile {
  return {
    name: cleanText(name ?? 'Guest', LIMITS.nameMax) || 'Guest',
    color: COLORS[0],
    cursor: { kind: 'shape', shape: 'arrow' },
  };
}

const cleanedText = (max: number) =>
  v.pipe(v.string(), v.maxLength(RAW_TEXT_MAX), v.transform((s) => cleanText(s, max)));

const cursorSchema = v.variant('kind', [
  v.object({ kind: v.literal('shape'), shape: v.picklist(SHAPES) }),
  v.object({
    kind: v.literal('pixels'),
    art: v.pipe(v.string(), v.check((art) => isValidArt(art), 'Invalid pixel art')),
    tip: v.pipe(v.strictTuple([v.number(), v.number()]), v.check((tip) => isValidTip(tip), 'Invalid cursor tip')),
  }),
]);

const profileSchema = v.object({
  name: v.pipe(cleanedText(LIMITS.nameMax), v.minLength(1)),
  color: v.picklist(COLORS),
  cursor: cursorSchema,
});

export function isValidProfile(p: unknown): p is Profile {
  return v.safeParse(profileSchema, p).success;
}


const RAW_URL_MAX = 4096;
const RAW_MESSAGE_MAX = 16_384;
/** Cursor coordinates are rounded and clamped to this many board units either side of the origin. */
const COORD_LIMIT = 100_000;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const FILE_ID_RE = /^[0-9a-f]{32}$/;

const slotSchema = v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(SLOT_COUNT - 1));
const nonNegativeInt = v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(Number.MAX_SAFE_INTEGER));
const reqId = v.pipe(v.string(), v.regex(ID_RE));
const label = cleanedText(LIMITS.labelMax);
const coord = v.pipe(
  v.number(),
  v.finite(),
  v.transform((n) => Math.max(-COORD_LIMIT, Math.min(COORD_LIMIT, Math.round(n)))),
);

const contentSchema = v.variant('kind', [
  v.object({
    kind: v.literal('link'),
    url: v.pipe(v.string(), v.minLength(1), v.maxLength(RAW_URL_MAX)),
  }),
  v.object({ kind: v.literal('html'), fileId: v.pipe(v.string(), v.regex(FILE_ID_RE)) }),
]);

const teacherBase = {
  type: v.literal('teacher'),
  reqId,
  code: v.pipe(v.string(), v.minLength(1), v.maxLength(RAW_TEXT_MAX)),
};

const clientMsgSchema = v.variant('type', [
  v.object({ type: v.literal('hello'), clientId: v.pipe(v.string(), v.regex(ID_RE)), profile: profileSchema }),
  v.object({ type: v.literal('profile'), profile: profileSchema }),
  v.object({ type: v.literal('cursor'), x: coord, y: coord }),
  v.object({ type: v.literal('dock'), slot: slotSchema, mode: v.picklist(['using', 'viewing']) }),
  v.object({ type: v.literal('away') }),
  v.object({
    type: v.literal('post'),
    reqId,
    slot: slotSchema,
    baseVersion: nonNegativeInt,
    content: contentSchema,
    label,
  }),
  v.object({ type: v.literal('rename'), reqId, slot: slotSchema, baseVersion: nonNegativeInt, label }),
  v.object({
    type: v.literal('restore'),
    reqId,
    slot: slotSchema,
    baseVersion: nonNegativeInt,
    versionId: v.pipe(nonNegativeInt, v.minValue(1)),
  }),
  v.object({ type: v.literal('history'), reqId, slot: slotSchema }),
  // Teacher messages carry a slot or target only for the actions that use one; valibot drops the rest.
  v.variant('action', [
    v.object({ ...teacherBase, action: v.picklist(['check', 'lock', 'unlock', 'logout']) }),
    v.object({ ...teacherBase, action: v.literal('clear'), slot: slotSchema }),
    v.object({ ...teacherBase, action: v.literal('resetCursor'), target: v.pipe(v.string(), v.regex(ID_RE)) }),
  ]),
]);

export function parseClientMsg(data: unknown): ClientMsg | null {
  let value = data;
  if (typeof data === 'string') {
    if (data.length > RAW_MESSAGE_MAX) return null;
    try {
      value = JSON.parse(data);
    } catch {
      return null;
    }
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const result = v.safeParse(clientMsgSchema, value);
  return result.success ? result.output : null;
}
