import { expect, test } from '@playwright/test';
import { liveFrame, newBoardName, openBoard, seedProfile, tileOf, zoomToSlot } from '../fixtures/helpers';

// The Worker fetches the link for real to check whether it can be embedded, so this needs the
// internet. Local links can't be tested at all: planLink rejects localhost by design.
test('a public link is posted, checked and shown live @network', async ({ page }) => {
  test.skip(!process.env.E2E_NETWORK, 'set E2E_NETWORK=1 to run tests that need the internet');
  test.setTimeout(90_000);

  await seedProfile(page.context(), 'Ana');
  await openBoard(page, newBoardName());

  await zoomToSlot(page, 0);
  const tile = tileOf(page, 0);
  await tile.locator('[data-action="add"]').click();
  const dialog = page.locator('.modal[data-dialog="post"]');
  await expect(dialog).toBeVisible();
  await dialog.locator('[data-tab="link"]').click();
  await dialog.locator('input[name="url"]').fill('https://example.com');
  await dialog.locator('[data-action="submit"]').click();
  await expect(dialog).toBeHidden();

  // The tile becomes a link tile, then the link check finishes (it is "checking" until then).
  await expect(tile).toHaveClass(/is-link/);
  await expect(tile).not.toHaveClass(/is-checking/, { timeout: 30_000 });
  await expect(tile).not.toHaveClass(/is-blocked/);

  // example.com allows framing, so zoomed in it runs live.
  await zoomToSlot(page, 0);
  await expect(tile).toHaveClass(/is-live/);
  // example.com's 2025 page has no heading; its one paragraph is stable.
  await expect(liveFrame(page, 0).locator('body')).toContainText('documentation examples', { timeout: 30_000 });
});
