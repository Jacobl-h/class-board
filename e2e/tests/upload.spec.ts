import { expect, test } from '@playwright/test';
import { C4, fitBoard, liveFrame, newBoardName, openBoard, postHtmlFile, seedProfile, tileOf, zoomToSlot } from '../fixtures/helpers';

test('an uploaded HTML page runs live once zoomed in, in a sandbox without storage', async ({ page }) => {
  await seedProfile(page.context(), 'Ana');
  await openBoard(page, newBoardName());

  await postHtmlFile(page, C4);
  const tile = tileOf(page, C4);
  const iframe = tile.locator('iframe');

  // Zoomed out, the tile is narrower than 240 px on screen, so no iframe is mounted
  // (a tile stays live for 2 s after it stops qualifying, so this waits for that).
  await fitBoard(page);
  await expect(iframe).toHaveCount(0);

  // Zoomed in on the tile, it goes live.
  await zoomToSlot(page, C4);
  await expect(tile).toHaveClass(/is-live/);
  await expect(iframe).toHaveCount(1);

  // No allow-same-origin: the upload gets an opaque origin.
  const sandbox = (await iframe.getAttribute('sandbox')) ?? '';
  expect(sandbox).toContain('allow-scripts');
  expect(sandbox).not.toContain('allow-same-origin');

  // The page's script ran, and localStorage was blocked.
  const frame = liveFrame(page, C4);
  await expect(frame.locator('#ran')).toHaveText('ran');
  await expect(frame.locator('#result')).toHaveText('blocked');
  const inner = await (await iframe.elementHandle())!.contentFrame();
  await expect.poll(() => inner!.title()).toBe('blocked');
});
