import { expect, test } from '@playwright/test';
import {
  C4, liveFrame, newBoardName, openBoard, openPostDialog, postHtmlFile, seedProfile, submitHtmlText, tileOf,
} from '../fixtures/helpers';

test('replacing a tile keeps the old version in history, and it can be restored', async ({ page }) => {
  await seedProfile(page.context(), 'Ana');
  await openBoard(page, newBoardName());

  // First version: the fixture page.
  await postHtmlFile(page, C4);
  const frame = liveFrame(page, C4);
  await expect(frame.locator('#result')).toHaveText('blocked');

  // Replace it. The dialog warns first.
  const dialog = await openPostDialog(page, C4, 'replace');
  await expect(dialog).toContainText('This replaces');
  await submitHtmlText(dialog, '<title>Second</title><h1 id="second">Second version</h1>');
  await expect(dialog).toBeHidden();
  await expect(frame.locator('#second')).toHaveText('Second version');
  await expect(frame.locator('#result')).toHaveCount(0);

  // History lists both versions, newest first.
  const tile = tileOf(page, C4);
  await tile.hover();
  await tile.locator('[data-action="history"]').click();
  const history = page.locator('.modal[data-dialog="history"]');
  await expect(history).toBeVisible();
  const rows = history.locator('.history-row');
  await expect(rows).toHaveCount(2);

  // Restore the older one: the fixture page is back.
  await rows.nth(1).locator('[data-action="restore"]').click();
  await expect(frame.locator('#result')).toHaveText('blocked');
  await expect(frame.locator('#second')).toHaveCount(0);

  // A restore is itself a new version, so it can be undone: history now has three.
  await page.keyboard.press('Escape');
  await tile.hover();
  await tile.locator('[data-action="history"]').click();
  await expect(page.locator('.modal[data-dialog="history"] .history-row')).toHaveCount(3);
});
