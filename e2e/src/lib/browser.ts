import type { Page } from 'playwright-core';

/** "Start writing" (straight to the editor, no password), then a password from the banner, kept on this device. */
export async function startJournalWithPassword(page: Page, origin: string, pass: string) {
  await page.goto(`${origin}/signup`);
  await page.locator('.ProseMirror').waitFor({ timeout: 30_000 });
  await page.getByRole('button', { name: 'Set a password' }).first().click();
  await page.getByLabel('Password', { exact: true }).fill(pass);
  await page.getByLabel('Repeat password').fill(pass);
  await page.getByText('I understand nobody can reset my password for me.').click();
  await page.getByRole('button', { name: 'Set password', exact: true }).click();
  await page.getByRole('heading', { name: 'Save your recovery key' }).waitFor({ timeout: 30_000 });
  await page.getByText("I've saved my recovery key somewhere safe.").click();
  await page.getByRole('button', { name: /Save locally/ }).click();
  await page.getByRole('heading', { name: 'Save your recovery key' }).waitFor({ state: 'hidden' });
}
