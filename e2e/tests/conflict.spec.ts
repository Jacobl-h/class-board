import { expect, test } from '@playwright/test';
import { C4, joinBoard, newBoardName, openPostDialog, submitHtmlText, tileOf } from '../fixtures/helpers';

test('posting to a tile someone else just filled shows the conflict message', async ({ browser }) => {
  const board = newBoardName();
  const a = await joinBoard(browser, board, 'Ana');
  const b = await joinBoard(browser, board, 'Ben', '#D85A30');

  // Both open the post dialog on the same empty tile.
  const dialogA = await openPostDialog(a.page, C4, 'add');
  const dialogB = await openPostDialog(b.page, C4, 'add');

  // Ana posts first.
  await submitHtmlText(dialogA, '<title>From Ana</title><h1>Ana was first</h1>');
  await expect(dialogA).toBeHidden();
  await expect(tileOf(b.page, C4)).toHaveClass(/is-html/);

  // Ben posts second, from a dialog that still thinks the tile is empty.
  await submitHtmlText(dialogB, '<title>From Ben</title><h1>Ben was second</h1>');
  await expect(dialogB.locator('.dialog-error')).toContainText(/just posted/i);
  await expect(dialogB).toBeVisible();

  await a.context.close();
  await b.context.close();
});
