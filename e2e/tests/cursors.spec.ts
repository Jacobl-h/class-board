import { expect, test } from '@playwright/test';
import { joinBoard, myId, newBoardName, sweepMouse } from '../fixtures/helpers';

test('a cursor moved in one window appears and follows in another', async ({ browser }) => {
  const board = newBoardName();
  const a = await joinBoard(browser, board, 'Ana');
  const b = await joinBoard(browser, board, 'Ben', '#D85A30');

  const aId = await myId(a.page);
  expect(aId).toBeTruthy();
  const cursorEl = b.page.locator(`#cursor-layer .cursor[data-person="${aId}"]`);
  // .cursor is a zero-size anchor (Playwright counts that as hidden); its image is what you see.
  const cursor = cursorEl.locator('.cursor-img');

  const box = (await a.page.locator('#viewport').boundingBox())!;
  const y = box.y + box.height * 0.5;
  const left = box.x + box.width * 0.2;
  const right = box.x + box.width * 0.8;

  // Ana moves over the left side of the board; Ben's screen shows her cursor with her name.
  await sweepMouse(a.page, left, y - 40, left + 30, y);
  await expect(cursor).toBeVisible();
  await expect(cursorEl.locator('.cursor-tag')).toContainText('Ana');

  // Let the smoothing (about 200 ms behind real time) settle, then note where it is.
  await a.page.waitForTimeout(600);
  const leftX = (await cursor.boundingBox())!.x;

  // Ana moves to the right side; the cursor on Ben's screen follows.
  await sweepMouse(a.page, left + 30, y, right, y);
  await expect.poll(async () => (await cursor.boundingBox())?.x ?? 0).toBeGreaterThan(leftX + 200);

  await a.context.close();
  await b.context.close();
});
