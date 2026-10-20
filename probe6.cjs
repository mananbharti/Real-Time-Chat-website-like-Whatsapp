const { chromium, expect } = require('@playwright/test');
(async () => {
  const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome' });
  const a = await (await browser.newContext({ viewport: { width: 1280, height: 713 } })).newPage();
  a.on('pageerror', e=>console.log('PAGEERROR:', e.message));
  await a.goto('http://localhost:4555');
  await a.getByRole('button', { name: 'New here? Create an account' }).click();
  const id='p'+Date.now().toString(36);
  await a.getByLabel('Username', { exact: true }).fill('pm_'+id);
  await a.getByLabel('Your name', { exact: true }).fill('Pollmaker');
  await a.getByLabel('Password', { exact: true }).fill('Browser-test-password-123');
  await a.getByRole('button', { name: 'Create account', exact: true }).click();
  await expect(a.locator('#app')).toBeVisible();
  const r = await a.evaluate(() => {
    const b = document.querySelector('[aria-label="Create poll"]');
    if (!b) return 'MISSING';
    const cs = getComputedStyle(b), r = b.getBoundingClientRect();
    return { hidden: b.hidden, display: cs.display, rect: [r.x,r.y,r.width,r.height], vis: cs.visibility };
  });
  console.log(JSON.stringify(r));
  await browser.close();
})();
