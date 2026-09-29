import type { ErrorCode } from '@class-board/shared/types';
import { hideBanner, showBanner } from './banner';

const TEXT: Record<ErrorCode, string> = {
  invalid: "The board couldn't use that. Check it and try again.",
  locked: 'The board is locked.',
  conflict: 'Someone else just changed this tile. Try again.',
  rate_limited: "You're doing that too fast. Wait a moment and try again.",
  too_large: 'That file is over 1 MB. Choose a smaller HTML file.',
  bad_code: 'That passcode is wrong. Check it and try again.',
  locked_out: 'Too many wrong passcodes. Wait 10 minutes and try again.',
  not_found: "The board couldn't find that. Refresh the list and try again.",
  full: 'The board is full. Try again in a few minutes.',
  not_ready: 'The board is not connected yet. Wait a moment and try again.',
};

export function errorText(code: ErrorCode): string {
  return TEXT[code];
}

const TOAST_MS = 4000;
let toastTimer: ReturnType<typeof setTimeout> | undefined;

export function toast(text: string): void {
  showBanner('toast', text, 'info');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => hideBanner('toast'), TOAST_MS);
}
