import { expect, test } from '@playwright/test';
import { joinBoard, newBoardName, openBoard } from '../fixtures/helpers';

test('first visit needs a name, and the saved name is shown to others', async ({ page, browser }) => {
  const board = newBoardName();
  // No seeded profile here: this is a first visit. The app doesn't connect until a name is saved.
  await openBoard(page, board, { ready: false });

  const panel = page.locator('.modal[data-dialog="profile"]');
  await expect(panel).toBeVisible();

  // It can't be dismissed without a name.
  await page.keyboard.press('Escape');
  await expect(panel).toBeVisible();
  await panel.locator('[data-action="save"]').click();
  await expect(panel).toBeVisible();

  // Saving a name closes it.
  await panel.locator('input[name="name"]').fill('Ana');
  await panel.locator('[data-action="save"]').click();
  await expect(panel).toBeHidden();

  // Another student on the same board sees Ana in the people list.
  const ben = await joinBoard(browser, board, 'Ben');
  await ben.page.locator('#topbar [data-action="people"]').click();
  await expect(ben.page.locator('.people-panel .person', { hasText: 'Ana' })).toHaveCount(1);
  await expect(ben.page.locator('[data-role="people-count"]')).toContainText('2');

  // The name is remembered: after a reload the panel stays closed.
  await page.reload();
  await expect(page.locator('#tiles .tile')).toHaveCount(80);
  await expect(page.locator('.modal[data-dialog="profile"]')).toHaveCount(0);

  await ben.context.close();
});
