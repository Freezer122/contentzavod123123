import { chromium } from 'playwright';
import { AdsPowerProvider } from '../src/browser/providers.js';
import { writeFile } from 'node:fs/promises';
import { assert } from '../src/core/errors.js';
const provider = new AdsPowerProvider(
  'http://127.0.0.1:50325',
  process.env.ADSPOWER_API_KEY,
  undefined,
  ['k1j71gt4'],
  true,
);
assert(!(await provider.status('k1j71gt4')), 'PROFILE_BUSY', 'Browser is open');
const session = await provider.start('k1j71gt4');
let browser;
try {
  browser = await chromium.connectOverCDP(session.cdpEndpoint);
  const page = await browser.contexts()[0]!.newPage();
  await page.goto('https://www.threads.com/@beh4ppy01', { waitUntil: 'domcontentloaded' });
  await page
    .getByRole('button', { name: /^(Edit profile|Profil bearbeiten|Редактировать профиль)$/i })
    .click();
  const dialog = page.getByRole('dialog').filter({ visible: true });
  await dialog.waitFor();
  const inspect = async (stage: string) => ({
    stage,
    text: await page.getByRole('dialog').filter({ visible: true }).last().innerText(),
    fields: await page
      .locator(
        '[role=dialog] input,[role=dialog] textarea,[role=dialog] [contenteditable=true],[role=dialog] [role=button]',
      )
      .filter({ visible: true })
      .evaluateAll((nodes) =>
        nodes.map((n) => ({
          tag: n.tagName,
          role: n.getAttribute('role'),
          label: n.getAttribute('aria-label'),
          placeholder: n.getAttribute('placeholder'),
          type: n.getAttribute('type'),
          text: n.textContent?.slice(0, 150),
          value: (n as HTMLInputElement).value,
        })),
      ),
  });
  const report: any = { mode: 'READ_ONLY_NESTED_PROFILE_EDITOR', saved: false, stages: [] };
  await dialog.getByRole('button', { name: 'Bio', exact: true }).click();
  report.stages.push(await inspect('BIO'));
  await page.goto('https://www.threads.com/@beh4ppy01', { waitUntil: 'domcontentloaded' });
  await page
    .getByRole('button', { name: /^(Edit profile|Profil bearbeiten|Редактировать профиль)$/i })
    .click();
  await page
    .getByRole('dialog')
    .filter({ visible: true })
    .getByRole('button', { name: /^Links/ })
    .click();
  report.stages.push(await inspect('LINKS'));
  const add = page
    .getByRole('button', { name: /^(Link hinzufügen|Add link|Добавить ссылку)/i })
    .filter({ visible: true });
  if ((await add.count()) === 1) {
    await add.click();
    await page.locator('input:not([type=file])').filter({ visible: true }).first().waitFor();
    report.stages.push(await inspect('ADD_LINK'));
  }
  await page.goto('https://www.threads.com/@beh4ppy01', { waitUntil: 'domcontentloaded' });
  await page
    .getByRole('button', { name: /^(Edit profile|Profil bearbeiten|Редактировать профиль)$/i })
    .click();
  await page
    .getByRole('dialog')
    .filter({ visible: true })
    .getByRole('button', { name: /^Links/ })
    .click();
  await page
    .getByRole('button', { name: /^https:\/\// })
    .filter({ visible: true })
    .first()
    .click();
  await page.locator('input:not([type=file])').filter({ visible: true }).first().waitFor();
  report.stages.push(await inspect('EDIT_LINK'));
  await writeFile(
    '/var/lib/content-factory/reports/KEEP-v18-profile-nested-dom.json',
    JSON.stringify(report, null, 2),
    { mode: 0o600 },
  );
  await page.keyboard.press('Escape');
  await page.close();
  console.log(JSON.stringify(report));
} finally {
  await provider.stop('k1j71gt4');
  await browser?.close().catch(() => {});
}
