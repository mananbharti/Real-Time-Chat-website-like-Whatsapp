const { test, expect } = require('@playwright/test');
async function join(page, name, room) {
  await page.goto('/');
  await expect(page.locator('#connection-status')).toContainText('Connected');
  await page.getByLabel('Your name', { exact: true }).fill(name);
  await page.getByLabel('Room name', { exact: true }).fill(room);
  await page.getByRole('button', { name: 'Join the conversation' }).click();
  await expect(page.locator('#join-dialog')).not.toBeVisible();
}
async function send(page, text) { await page.getByLabel('Message', { exact: true }).fill(text); await page.getByRole('button', { name: 'Send message', exact: true }).click(); await expect(page.getByLabel('Message', { exact: true })).toHaveValue(''); }

test('two people chat, see typing, isolate rooms, restore history and safely render HTML', async ({ browser }) => {
  const a = await browser.newPage(); const b = await browser.newPage();
  const room = `studio-${Date.now()}`;
  await join(a, 'Manan', room); await join(b, 'Alex', room);
  await expect(a.locator('#connection-status')).toContainText('2 people online');
  await b.getByLabel('Message', { exact: true }).fill('Hey Manan!');
  await expect(a.locator('#typing')).toContainText('Alex is typing');
  await b.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(a.locator('.message-text')).toHaveText(['Hey Manan!']);
  await send(a, 'Hey! The room is working.');
  await expect(b.locator('.message-text')).toHaveText(['Hey Manan!', 'Hey! The room is working.']);
  const attack = '<img src=x onerror="window.xss=true">';
  await send(a, attack);
  await expect(b.locator('.message-text').last()).toHaveText(attack);
  expect(await b.evaluate(() => window.xss)).toBeUndefined();
  await expect(b.locator('#messages img')).toHaveCount(0);
  await b.reload();
  await expect(b.locator('#messages .message')).toHaveCount(3);
  await expect(b.locator('.mine .message-text')).toHaveText('Hey Manan!');
  await b.getByRole('button', { name: 'Change name or room' }).click();
  await b.getByLabel('Room name', { exact: true }).fill('another-' + Date.now());
  await b.getByRole('button', { name: 'Join the conversation' }).click();
  await expect(b.locator('#messages .message')).toHaveCount(0);
  await send(a, 'Only our original room gets this.');
  await expect(a.locator('#messages .message')).toHaveCount(4);
  await expect(b.locator('#messages .message')).toHaveCount(0);
  await a.close(); await b.close();
});

test('responsive mobile, multiline keyboard entry, empty guard and reconnect with a saved draft', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true });
  const page = await context.newPage();
  await join(page, 'Taylor', `mobile-${Date.now()}`);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeDisabled();
  const input = page.getByLabel('Message', { exact: true });
  await input.fill('First line'); await input.press('Shift+Enter'); await input.press('a');
  await input.press('Enter'); await expect(page.locator('.message-text')).toHaveText('First line\na');
  await input.fill('My unfinished draft');
  await context.setOffline(true);
  await expect(input).toBeDisabled({ timeout: 25000 });
  await context.setOffline(false);
  await expect(input).toBeEnabled({ timeout: 20000 });
  await expect(input).toHaveValue('My unfinished draft');
  await expect(page.locator('#messages .message')).toHaveCount(1);
  await send(page, 'My unfinished draft');
  await expect(page.locator('#messages .message')).toHaveCount(2);
  await context.close();
});
