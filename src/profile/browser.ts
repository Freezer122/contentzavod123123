import type { Page, Locator } from 'playwright';
import type { BrowserAccess } from '../browser/coordinator.js';
import type { Account } from '../core/domain.js';
import { assert } from '../core/errors.js';
import { hashDocument } from '../db/documents.js';
import type { ProfileData, ProfilePort } from './service.js';
const done = /^(Done|Fertig|Готово)$/i,
  cancel = /^(Cancel|Abbrechen|Отмена|Отменить)$/i;
async function one(locator: Locator) {
  const l = locator.filter({ visible: true });
  await l.first().waitFor();
  assert((await l.count()) === 1, 'PROFILE_UI_CHANGED', 'Неоднозначный элемент редактора профиля');
  return l;
}
export class ThreadsProfilePort implements ProfilePort {
  constructor(private access: BrowserAccess) {}
  private async open(page: Page, a: Account) {
    await page.goto(a.profileUrl, { waitUntil: 'domcontentloaded' });
    assert(
      new URL(page.url()).pathname.replace(/\/$/, '') === `/@${a.username}`,
      'WRONG_ACCOUNT',
      'Открыт другой профиль',
    );
    assert(
      (await page.locator('iframe[src*=captcha],form[action*=challenge]').count()) === 0,
      'CHALLENGE',
      'Нужна ручная проверка',
    );
    await (
      await one(
        page.getByRole('button', {
          name: /^(Edit profile|Profil bearbeiten|Редактировать профиль)$/i,
        }),
      )
    ).click();
  }
  private async bio(page: Page) {
    await (await one(page.getByRole('button', { name: /^(Bio|Биография|О себе)$/i }))).click();
    return one(page.locator('textarea'));
  }
  private async links(page: Page) {
    await (await one(page.getByRole('button', { name: /^(Links|Ссылки)(?:\s|\d|$)/i }))).click();
    await page.getByRole('button', { name: cancel }).filter({ visible: true }).waitFor();
  }
  private async panel(field: Locator) {
    let parent = field.locator('..');
    for (let i = 0; i < 10; i++) {
      if (
        (await parent.getByRole('button', { name: cancel }).filter({ visible: true }).count()) ===
          1 &&
        (await parent.getByRole('button', { name: done }).filter({ visible: true }).count()) === 1
      )
        return parent;
      parent = parent.locator('..');
    }
    throw new Error('PROFILE_PANEL_AMBIGUOUS');
  }
  private async closeNested(page: Page, field?: Locator) {
    const root = field ? await this.panel(field) : page;
    await (await one(root.getByRole('button', { name: cancel }))).click();
    if (field) await field.waitFor({ state: 'hidden' });
  }
  private async snapshotPage(page: Page, a: Account): Promise<ProfileData> {
    await this.open(page, a);
    const field = await this.bio(page),
      bio = await field.inputValue();
    await this.closeNested(page, field);
    await this.links(page);
    await page
      .getByRole('button', { name: /^(Add link|Link hinzufügen|Добавить ссылку)$/i })
      .filter({ visible: true })
      .waitFor();
    const links = await page
      .getByRole('button', { name: /^https:\/\// })
      .filter({ visible: true })
      .allTextContents();
    const add = page
      .getByRole('button', { name: /^(Add link|Link hinzufügen|Добавить ссылку)$/i })
      .filter({ visible: true });
    const canAdd = (await add.count()) === 1 && (await add.isEnabled());
    const result = {
      bio,
      links: links.map((v) => new URL(v.trim()).href),
      linkCapacity: canAdd ? 5 : links.length,
    };
    await this.closeNested(page);
    return result;
  }
  read(accountId: string) {
    return this.access.use(accountId, 'PROFILE', (page, a) => this.snapshotPage(page, a));
  }
  async change(
    accountId: string,
    before: ProfileData,
    after: ProfileData,
    commit: boolean,
    beforeSave: () => Promise<void>,
  ) {
    return this.access.use(accountId, 'PROFILE', async (page, a, signal) => {
      const actual = await this.snapshotPage(page, a);
      assert(
        hashDocument(actual) === hashDocument(before),
        'STALE_PROFILE',
        'Профиль изменился. Обновите снимок и предпросмотр',
      );
      let barrier = false;
      const save = async (button: Locator) => {
        signal.throwIfAborted();
        assert(commit, 'DRY_RUN_ONLY', 'Сохранение запрещено');
        if (!barrier) {
          await beforeSave();
          barrier = true;
        }
        await (await one(button)).click();
      };
      if (after.bio !== before.bio) {
        const field = await this.bio(page);
        await field.fill(after.bio);
        assert((await field.inputValue()) === after.bio, 'TEXT_MISMATCH', 'Текст био не совпал');
        if (commit) await save((await this.panel(field)).getByRole('button', { name: done }));
        else {
          await field.fill(before.bio);
          await this.closeNested(page, field);
        }
      }
      if (JSON.stringify(before.links) !== JSON.stringify(after.links)) {
        await this.links(page);
        for (let i = Math.max(before.links.length, after.links.length) - 1; i >= 0; i--) {
          const old = before.links[i],
            next = after.links[i];
          if (old === next) continue;
          if (old) await (await one(page.getByRole('button', { name: old, exact: true }))).click();
          else
            await (
              await one(
                page.getByRole('button', { name: /^(Add link|Link hinzufügen|Добавить ссылку)$/i }),
              )
            ).click();
          const field = await one(
            page.locator(
              'input[type=url],input[placeholder="URL"],input[placeholder*="Link"],input[placeholder*="Ссылк"]',
            ),
          );
          const oldValue = await field.inputValue();
          if (next) {
            await field.fill(next);
            assert((await field.inputValue()) === next, 'TEXT_MISMATCH', 'URL не совпал');
            if (commit) await save((await this.panel(field)).getByRole('button', { name: done }));
            else {
              await field.fill(oldValue);
              await this.closeNested(page, field);
            }
          } else {
            const remove = await one(
              (await this.panel(field)).getByRole('button', {
                name: /^(Remove link|Delete link|Link entfernen|Link löschen|Удалить ссылку)$/i,
              }),
            );
            if (commit) await save(remove);
            else await this.closeNested(page, field);
          }
        }
        const nestedCancel = page.getByRole('button', { name: cancel }).filter({ visible: true });
        if ((await nestedCancel.count()) === 1) await nestedCancel.click();
      }
      if (commit) {
        const finish = page.getByRole('button', { name: done }).filter({ visible: true });
        if ((await finish.count()) === 1) await save(finish);
      }
      const expected = commit ? after : before;
      for (let attempt = 0; attempt < 4; attempt++) {
        const result = await this.snapshotPage(page, a);
        if (hashDocument(result) === hashDocument(expected)) return result;
        if (!commit) break;
        await page.waitForTimeout(2500);
      }
      throw new Error('PROFILE_VERIFY_FAILED');
    });
  }
}
