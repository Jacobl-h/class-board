import { expect, test } from '@playwright/test';
import type { Browser, BrowserContext, FrameLocator, Locator, Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

/** Slot index of tile C4 (row C = 2, column 4 = 3; 2 * 10 + 3). */
export const C4 = 23;
export const PROFILE_KEY = 'classBoard.profile';

/**
 * The teacher passcode the local Worker checks: TEACHER_CODE from worker/.dev.vars, so it is never
 * written into a test. E2E_TEACHER_CODE overrides it; "letmein" is the fallback when the file is
 * missing. Playwright runs from e2e/ (or the repo root with -w e2e), so both places are tried.
 */
export function readTeacherCode(cwd: string = process.cwd()): string {
  if (process.env.E2E_TEACHER_CODE) return process.env.E2E_TEACHER_CODE;
  for (const file of [path.resolve(cwd, '../worker/.dev.vars'), path.resolve(cwd, 'worker/.dev.vars')]) {
    let text: string;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split(/\r?\n/)) {
      const match = /^\s*TEACHER_CODE\s*=\s*(.*?)\s*$/.exec(line);
      if (!match) continue;
      const value = match[1]!.replace(/^(["'])(.*)\1$/, '$2');
      if (value) return value;
    }
  }
  return 'letmein';
}

export const TEACHER_CODE = readTeacherCode();

/** The dev-only debug handle from master plan section 5.4, reduced to what the tests use. */
interface DebugHandle {
  camera: { fitSlot(slot: number): void; fitBoard(): void };
  state: { ready(): boolean; you(): string | null };
  focus: { current(): number | null };
}
type WithHandle = { __classBoard?: DebugHandle };

/** A board name nobody else uses, so tests never share state and need no cleanup. */
export function newBoardName(): string {
  return `e2e-${Math.random().toString(36).slice(2, 10)}`;
}

/** Absolute path of a file in e2e/fixtures (works whatever module mode e2e/package.json uses). */
export function fixturePath(name: string): string {
  return path.resolve(test.info().project.testDir, '../fixtures', name);
}

/** Puts a saved profile in localStorage before the page loads, so the "Your cursor" panel stays closed. */
export async function seedProfile(context: BrowserContext, name: string, color = '#378ADD'): Promise<void> {
  const profile = JSON.stringify({ name, color, cursor: { kind: 'shape', shape: 'arrow' } });
  await context.addInitScript(
    ([key, value]: [string, string]) => {
      try {
        if (!localStorage.getItem(key)) localStorage.setItem(key, value);
      } catch {
        // Sandboxed frames can't touch localStorage; the profile only matters for the top page.
      }
    },
    [PROFILE_KEY, profile] as [string, string],
  );
}

/** Opens the board and, unless told not to, waits for the first snapshot to render all 80 tiles. */
export async function openBoard(page: Page, board: string, opts: { hash?: string; ready?: boolean } = {}): Promise<void> {
  await page.goto(`/?board=${board}${opts.hash ?? ''}`);
  if (opts.ready === false) return;
  await page.waitForFunction(() => (window as unknown as WithHandle).__classBoard?.state.ready() === true);
  await expect(page.locator('#tiles .tile')).toHaveCount(80);
}

/** A new browser context with a seeded profile, already on the board. */
export async function joinBoard(
  browser: Browser,
  board: string,
  name: string,
  color?: string,
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext();
  await seedProfile(context, name, color);
  const page = await context.newPage();
  await openBoard(page, board);
  return { context, page };
}

export function tileOf(page: Page, slot: number): Locator {
  return page.locator(`.tile[data-slot="${slot}"]`);
}

/** This tab's connection id, which is the `data-person` of its cursor on other people's screens. */
export function myId(page: Page): Promise<string | null> {
  return page.evaluate(() => (window as unknown as WithHandle).__classBoard!.state.you());
}

export async function zoomToSlot(page: Page, slot: number): Promise<void> {
  await page.evaluate((s) => (window as unknown as WithHandle).__classBoard!.camera.fitSlot(s), slot);
}

export async function fitBoard(page: Page): Promise<void> {
  await page.evaluate(() => (window as unknown as WithHandle).__classBoard!.camera.fitBoard());
}

export function focusedSlot(page: Page): Promise<number | null> {
  return page.evaluate(() => (window as unknown as WithHandle).__classBoard!.focus.current());
}

/** Moves the mouse in a straight line, slowly enough that the 5 Hz cursor sender sees several points. */
export async function sweepMouse(page: Page, x0: number, y0: number, x1: number, y1: number, steps = 25): Promise<void> {
  await page.mouse.move(x0, y0);
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(x0 + ((x1 - x0) * i) / steps, y0 + ((y1 - y0) * i) / steps);
    await page.waitForTimeout(40);
  }
}

/** Zooms to the tile and opens the post dialog from its Add (empty tile) or Replace (filled tile) button. */
export async function openPostDialog(page: Page, slot: number, mode: 'add' | 'replace'): Promise<Locator> {
  await zoomToSlot(page, slot);
  const tile = tileOf(page, slot);
  if (mode === 'replace') await tile.hover();
  await tile.locator(`[data-action="${mode}"]`).click();
  const dialog = page.locator('.modal[data-dialog="post"]');
  await expect(dialog).toBeVisible();
  return dialog;
}

/** Fills the HTML tab with pasted HTML and presses Post. */
export async function submitHtmlText(dialog: Locator, html: string): Promise<void> {
  await dialog.locator('[data-tab="html"]').click();
  await dialog.locator('textarea[name="html"]').fill(html);
  await dialog.locator('[data-action="submit"]').click();
}

/** Chooses a file on the HTML tab and presses Post. */
export async function submitHtmlFile(dialog: Locator, file: string): Promise<void> {
  await dialog.locator('[data-tab="html"]').click();
  await dialog.locator('input[name="file"]').setInputFiles(file);
  await dialog.locator('[data-action="submit"]').click();
}

/** Uploads a fixture file into an empty tile and waits until the tile shows it as an HTML tile. */
export async function postHtmlFile(page: Page, slot: number, name = 'upload-page.html'): Promise<void> {
  const dialog = await openPostDialog(page, slot, 'add');
  await submitHtmlFile(dialog, fixturePath(name));
  await expect(dialog).toBeHidden();
  await expect(tileOf(page, slot)).toHaveClass(/is-html/);
}

/** The page running inside a tile's live iframe. */
export function liveFrame(page: Page, slot: number): FrameLocator {
  return page.frameLocator(`.tile[data-slot="${slot}"] iframe`);
}
