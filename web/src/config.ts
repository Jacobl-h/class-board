import { BOARD_NAME_RE, DEFAULT_BOARD } from '@class-board/shared/constants';

export const DEFAULT_SERVER_URL = 'http://localhost:8787';

/** The board named by `?board=`, or the default board when it is missing or not a valid name. */
export function resolveBoard(search: string): string {
  const name = new URLSearchParams(search).get('board');
  return name !== null && BOARD_NAME_RE.test(name) ? name : DEFAULT_BOARD;
}

/** The Worker's base URL without a trailing slash. An unset or blank variable falls back to the local dev server. */
export function resolveServerUrl(raw: unknown): string {
  const value = typeof raw === 'string' ? raw.trim() : '';
  return (value === '' ? DEFAULT_SERVER_URL : value).replace(/\/+$/, '');
}

export const SERVER_URL: string = resolveServerUrl(import.meta.env.VITE_SERVER_URL);
export const BOARD: string = resolveBoard(location.search);
export const BOARD_ORIGIN: string = location.origin;
export const IS_DEV: boolean = import.meta.env.DEV;
