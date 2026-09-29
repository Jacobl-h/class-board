import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import {
  C4, focusedSlot, newBoardName, openBoard, postHtmlFile, seedProfile, tileOf, zoomToSlot,
} from '../fixtures/helpers';

const focusing = (page: Page) => page.locator('body');

/** Zooms to the tile's maximum, then keeps scrolling up over it until focus mode starts (it needs about 300 ms of continued zoom). */
async function zoomIntoFocus(page: Page, slot: number): Promise<void> {
  await zoomToSlot(page, slot);
  const box = (await page.locator('#viewport').boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await expect
    .poll(
      async () => {
        await page.mouse.wheel(0, -120);
        await page.waitForTimeout(60);
        return page.evaluate(() => document.body.classList.contains('is-focusing'));
      },
      { timeout: 10_000 },
    )
    .toBe(true);
}

test.describe('focus mode', () => {
  test('zooming past a full-screen tile fills the page; Back and the browser back button leave', async ({ page }) => {
    await seedProfile(page.context(), 'Ana');
    await openBoard(page, newBoardName());
    await postHtmlFile(page, C4);
    const tile = tileOf(page, C4);

    await zoomIntoFocus(page, C4);
    await expect(focusing(page)).toHaveClass(/is-focusing/);
    expect(await focusedSlot(page)).toBe(C4);
    await expect(page).toHaveURL(/#C4$/);

    // The tile body covers the whole window.
    const size = await page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }));
    const box = (await tile.locator('.tile-body').boundingBox())!;
    expect(Math.abs(box.x)).toBeLessThanOrEqual(2);
    expect(Math.abs(box.y)).toBeLessThanOrEqual(2);
    expect(Math.abs(box.width - size.w)).toBeLessThanOrEqual(2);
    expect(Math.abs(box.height - size.h)).toBeLessThanOrEqual(2);

    // The Back button leaves.
    await tile.locator('[data-action="back"]').click();
    await expect(focusing(page)).not.toHaveClass(/is-focusing/);
    expect(await focusedSlot(page)).toBeNull();
    await expect(page).not.toHaveURL(/#C4/);

    // Entering again, the browser's back button leaves too.
    await zoomIntoFocus(page, C4);
    await expect(page).toHaveURL(/#C4$/);
    await page.goBack();
    await expect(focusing(page)).not.toHaveClass(/is-focusing/);
    expect(await focusedSlot(page)).toBeNull();
  });

  test('a #C4 link opens focus mode once the board has loaded', async ({ page }) => {
    await seedProfile(page.context(), 'Ana');
    const board = newBoardName();
    await openBoard(page, board);
    await postHtmlFile(page, C4);

    // A fresh page load (not a hash change) on the deep link.
    const fresh = await page.context().newPage();
    await openBoard(fresh, board, { hash: '#C4' });
    await expect(focusing(fresh)).toHaveClass(/is-focusing/);
    expect(await focusedSlot(fresh)).toBe(C4);

    await fresh.locator('.tile[data-slot="23"] [data-action="back"]').click();
    await expect(focusing(fresh)).not.toHaveClass(/is-focusing/);
  });
});
