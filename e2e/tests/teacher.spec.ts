import { expect, test } from '@playwright/test';
import { joinBoard, newBoardName, TEACHER_CODE } from '../fixtures/helpers';

test('the teacher can lock the board for students and unlock it again', async ({ browser }) => {
  const board = newBoardName();
  const teacher = await joinBoard(browser, board, 'Teacher');
  const student = await joinBoard(browser, board, 'Ben', '#D85A30');

  // Before locking, the student sees Add buttons and no banner.
  const studentAdd = student.page.locator('.tile[data-slot="0"] [data-action="add"]');
  await expect(studentAdd).toBeVisible();
  await expect(student.page.locator('#banner [data-banner="locked"]')).toBeHidden();

  // The teacher opens the teacher panel from the people list.
  await teacher.page.locator('#topbar [data-action="people"]').click();
  await teacher.page.locator('.people-panel [data-action="teacher"]').click();
  const dialog = teacher.page.locator('.modal[data-dialog="teacher"]');
  await expect(dialog).toBeVisible();

  // A wrong passcode is refused.
  await dialog.locator('input[name="code"]').fill('not-the-code');
  await dialog.locator('[data-action="login"]').click();
  await expect(dialog.locator('.dialog-error')).toBeVisible();

  // The right one logs in.
  await dialog.locator('input[name="code"]').fill(TEACHER_CODE);
  await dialog.locator('[data-action="login"]').click();
  await expect(teacher.page.locator('[data-role="teacher-badge"]')).toBeVisible();
  await expect(teacher.page.locator('body')).toHaveClass(/is-teacher/);

  // Lock: the student loses the Add buttons and sees the banner.
  await dialog.locator('[data-action="lock"]').click();
  await expect(student.page.locator('#banner [data-banner="locked"]')).toBeVisible();
  await expect(student.page.locator('#tiles')).toHaveClass(/is-locked/);
  await expect(student.page.locator('[data-action="add"]:visible')).toHaveCount(0);

  // Unlock: everything comes back.
  await dialog.locator('[data-action="unlock"]').click();
  await expect(student.page.locator('#banner [data-banner="locked"]')).toBeHidden();
  await expect(studentAdd).toBeVisible();

  await teacher.context.close();
  await student.context.close();
});
