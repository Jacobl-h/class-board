import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { joinBoard, newBoardName, TEACHER_CODE } from '../fixtures/helpers';

/** Opens "Your cursor" from the top bar. */
async function openYourCursor(page: Page) {
  await page.locator('#topbar [data-action="profile"]').click();
  const dialog = page.locator('.modal[data-dialog="profile"]');
  await expect(dialog).toBeVisible();
  return dialog;
}

/** The student's people list, opened, with the row for the named person. */
async function personRow(page: Page, name: string) {
  const panel = page.locator('.people-panel');
  if (!(await panel.isVisible())) await page.locator('#topbar [data-action="people"]').click();
  return panel.locator('.person', { has: page.locator('.person-name', { hasText: name }) });
}

test('the teacher signs in from Your cursor, locks the board for students and unlocks it again', async ({ browser }) => {
  const board = newBoardName();
  const teacher = await joinBoard(browser, board, 'Ms Park');
  const student = await joinBoard(browser, board, 'Ben', '#D85A30');

  // Before locking, the student sees Add buttons and no banner.
  const studentAdd = student.page.locator('.tile[data-slot="0"] [data-action="add"]');
  await expect(studentAdd).toBeVisible();
  await expect(student.page.locator('#banner [data-banner="locked"]')).toBeHidden();

  // A wrong passcode keeps Your cursor open with an error.
  let dialog = await openYourCursor(teacher.page);
  await dialog.locator('input[name="teacher-code"]').fill('not-the-code');
  await dialog.locator('[data-action="save"]').click();
  await expect(dialog.locator('.teacher-error')).toBeVisible();
  await expect(dialog).toBeVisible();

  // The right one signs in and closes the panel.
  await dialog.locator('input[name="teacher-code"]').fill(TEACHER_CODE);
  await dialog.locator('[data-action="save"]').click();
  await expect(dialog).toBeHidden();
  await expect(teacher.page.locator('[data-role="teacher-badge"]')).toBeVisible();
  await expect(teacher.page.locator('body')).toHaveClass(/is-teacher/);

  // Everyone sees who the teacher is.
  const row = await personRow(student.page, 'Ms Park');
  await expect(row.locator('.person-teacher-tag')).toBeVisible();
  await expect((await personRow(student.page, 'Ben')).locator('.person-teacher-tag')).toBeHidden();
  await student.page.keyboard.press('Escape');

  // Lock from the reopened panel: the student loses the Add buttons and sees the banner.
  dialog = await openYourCursor(teacher.page);
  await expect(dialog).toContainText("You're signed in as a teacher.");
  await dialog.locator('[data-action="lock"]').click();
  await expect(dialog.locator('[data-action="unlock"]')).toBeVisible();
  await expect(student.page.locator('#banner [data-banner="locked"]')).toBeVisible();
  await expect(student.page.locator('#tiles')).toHaveClass(/is-locked/);
  await expect(student.page.locator('[data-action="add"]:visible')).toHaveCount(0);

  // Tapping an empty tile doesn't open the post dialog for the student while locked.
  await student.page.locator('.tile[data-slot="0"]').click();
  await expect(student.page.locator('.modal[data-dialog="post"]')).toHaveCount(0);

  // Unlock: everything comes back.
  await dialog.locator('[data-action="unlock"]').click();
  await expect(dialog.locator('[data-action="lock"]')).toBeVisible();
  await expect(student.page.locator('#banner [data-banner="locked"]')).toBeHidden();
  await expect(studentAdd).toBeVisible();

  // Signing out removes the Teacher tag for everyone.
  await dialog.locator('[data-action="logout"]').click();
  await expect(dialog.locator('input[name="teacher-code"]')).toBeVisible();
  await expect(teacher.page.locator('body')).not.toHaveClass(/is-teacher/);
  await expect((await personRow(student.page, 'Ms Park')).locator('.person-teacher-tag')).toBeHidden();

  await teacher.context.close();
  await student.context.close();
});
