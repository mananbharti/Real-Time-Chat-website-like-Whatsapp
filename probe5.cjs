const { chromium, expect } = require('@playwright/test');
(async () => {
  const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome' });
  const ac = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const bc = await browser.newContext();
  const a = await ac.newPage(), b = await bc.newPage();
  const id='e'+Date.now().toString(36);
  for (const [p,n,h] of [[a,'EdgeT','et_'+id],[b,'EdgeF','ef_'+id]]) {
    await p.goto('http://localhost:4555');
    await p.getByRole('button', { name: 'New here? Create an account' }).click();
    await p.getByLabel('Username', { exact: true }).fill(h);
    await p.getByLabel('Your name', { exact: true }).fill(n);
    await p.getByLabel('Password', { exact: true }).fill('Browser-test-password-123');
    await p.getByRole('button', { name: 'Create account', exact: true }).click();
    await expect(p.locator('#app')).toBeVisible();
  }
  await a.getByRole('button', { name: 'New chat', exact: true }).click();
  await a.locator('.contact').filter({ hasText: 'ef_'+id }).click();
  await a.getByLabel('Message', { exact: true }).fill('menu fixture');
  await a.getByRole('button', { name: 'Send message', exact: true }).click();
  await a.locator('.message').evaluate((node) => node.dispatchEvent(new MouseEvent('contextmenu', { clientX: 1, clientY: 1, bubbles: true, cancelable: true })));
  await a.waitForTimeout(400);
  const r = await a.evaluate(() => {
    const d = document.querySelector('#tools-dialog');
    const p = document.querySelector('.reaction-picker');
    const db = d.getBoundingClientRect(), pb = p.getBoundingClientRect();
    return { dialog: [db.x, db.y, db.width, db.height], picker: [pb.x, pb.y, pb.width, pb.height],
      dCls: d.className, dLeft: d.style.left, dTop: d.style.top,
      pParent: p.parentElement === d, cs: { right: getComputedStyle(p).right, bottom: getComputedStyle(p).bottom, pos: getComputedStyle(p).position } };
  });
  console.log(JSON.stringify(r, null, 1));
  await browser.close();
})();
