import { visibleResults } from './results.js';
import { chromium, type Browser, type Page, type Locator } from 'playwright';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Account } from '../core/domain.js';
import { AppError, assert, messageOf } from '../core/errors.js';
import type { BrowserProvider } from './providers.js';
export interface PublishResult {
  url: string;
  externalId: string | null;
}
export interface CommentAttachment {
  path: string;
  sha256: string;
}
export interface PublishingSession {
  check(): Promise<void>;
  publish(
    text: string,
    beforeSend: () => Promise<void>,
    onSubmitted?: (at: Date) => Promise<void>,
  ): Promise<PublishResult>;
  comment(
    postUrl: string,
    text: string,
    beforeSend: () => Promise<void>,
    attachment?: CommentAttachment,
    onSubmitted?: (at: Date) => Promise<void>,
  ): Promise<{ url: string | null }>;
  find(text: string): Promise<string | null>;
  close(): Promise<void>;
  evidence(error: unknown): Promise<void>;
}
export interface Publisher {
  open(
    provider: BrowserProvider,
    profileId: string,
    account: Account,
    jobId: string,
  ): Promise<PublishingSession>;
}
const selectorsSchema = z.object({
  baseUrl: z.string().url(),
  loggedIn: z.string(),
  identity: z.string(),
  challenge: z.string(),
  restricted: z.string(),
  create: z.string(),
  dialog: z.string(),
  editor: z.string(),
  submit: z.string(),
  ownPost: z.string(),
  postLink: z.string(),
  reply: z.string(),
  replySubmit: z.string(),
  comment: z.string(),
  mediaInput: z.string().optional(),
  mediaPreview: z.string().optional(),
});
export type Selectors = z.infer<typeof selectorsSchema>;
const normalized = (s: string) => s.replace(/\r\n/g, '\n').trim();
async function one(locator: Locator) {
  const visible = locator.filter({ visible: true });
  await visible.first().waitFor({ state: 'visible', timeout: 15000 });
  assert((await visible.count()) === 1, 'UI_CHANGED', 'Неоднозначный элемент интерфейса');
  return visible;
}
async function mediaCount(locator: Locator) {
  return locator.evaluateAll(
    (nodes) =>
      nodes.filter((node) => {
        const box = node.getBoundingClientRect();
        return (
          node instanceof HTMLImageElement &&
          node.complete &&
          node.naturalWidth > 0 &&
          box.width >= 80 &&
          box.height >= 80
        );
      }).length,
  );
}
export class ThreadsSession implements PublishingSession {
  private closing?: Promise<void>;
  private unsentEditor?: Locator;
  constructor(
    private page: Page,
    private browser: Browser | null,
    private provider: BrowserProvider,
    private profileId: string,
    private account: Account,
    private jobId: string,
    private s: Selectors,
    private artifacts: string,
    private confirmation = { timeoutMs: 90000, pollMs: 2500 },
  ) {}
  private async guards() {
    if (await this.page.locator(this.s.challenge).count())
      throw new AppError('CHALLENGE', 'Требуется ручная проверка в браузере');
    if (await this.page.locator(this.s.restricted).count())
      throw new AppError('RESTRICTED', 'На аккаунте обнаружено ограничение');
  }
  async check() {
    await this.page.goto(this.s.baseUrl, { waitUntil: 'domcontentloaded' });
    await this.guards();
    const loggedIn = this.page.locator(this.s.loggedIn).filter({ visible: true });
    await loggedIn
      .first()
      .waitFor({ state: 'visible', timeout: 15000 })
      .catch(async () => {
        await this.guards();
        throw new AppError('AUTH_REQUIRED', 'Войдите в Threads вручную');
      });
    if ((await loggedIn.count()) !== 1)
      throw new AppError('AUTH_REQUIRED', 'Войдите в Threads вручную');
    await one(this.page.locator(this.s.identity.replaceAll('{username}', this.account.username)));
  }
  private async confirmVisibleResult(
    selector: string,
    text: string,
    refreshUrl: string,
    excluded: Set<string>,
    attachment?: CommentAttachment,
    allowWithoutPermalink = false,
  ) {
    const deadline = Date.now() + this.confirmation.timeoutMs;
    const canonical = (url: string) => {
      try {
        this.validatePostUrl(url);
        return !excluded.has(url);
      } catch {
        return false;
      }
    };
    let polls = 0,
      reread = false;
    const candidates = new Set<string>();
    while (Date.now() < deadline) {
      const rows = await visibleResults(
        this.page,
        selector,
        this.s.postLink,
        text,
        this.account.username,
        this.s.mediaPreview,
      );
      await this.guards();
      const links = rows.flatMap((r) => r.urls);
      const matches = [...new Set(links.filter(canonical))];
      assert(matches.length <= 1, 'UNCERTAIN', 'Найдено несколько подходящих собственных ссылок');
      if (matches.length === 1 && (!attachment || rows.some((r) => r.mediaCount > 0)))
        return matches[0]!;
      if (
        allowWithoutPermalink &&
        reread &&
        rows.length === 1 &&
        (!attachment || rows[0]!.mediaCount > 0) &&
        new URL(this.page.url()).pathname === new URL(refreshUrl).pathname
      )
        return ''; // Exact own comment persisted on the parent's reloaded page; URL is optional.
      // A permalink in the success notice/current route is a candidate, never proof by itself.
      const notices = await this.page
        .locator('[role="status"] a[href*="/post/"], [role="alert"] a[href*="/post/"]')
        .filter({ visible: true })
        .evaluateAll((nodes) => nodes.map((n) => (n as HTMLAnchorElement).href));
      for (const url of [...notices, this.page.url()]) if (canonical(url)) candidates.add(url);
      const plain = (value: string) => value.replace(/\s+/g, ' ').trim();
      if (
        canonical(this.page.url()) &&
        !attachment &&
        plain(await this.page.locator('body').innerText()).includes(plain(text))
      )
        return this.page.url();
      if (Date.now() >= deadline) break;
      await this.page.waitForTimeout(
        Math.min(this.confirmation.pollMs, Math.max(1, deadline - Date.now())),
      );
      polls++;
      const direct = [...candidates][0];
      if (direct || polls % 2 === 0) {
        await this.page.goto(direct ?? refreshUrl, {
          waitUntil: 'domcontentloaded',
          timeout: Math.min(15000, Math.max(1, deadline - Date.now())),
        });
        reread = true;
      }
    }
    throw new AppError('UNCERTAIN', 'Результат не подтверждён после повторного чтения страницы');
  }
  async publish(
    text: string,
    beforeSend: () => Promise<void>,
    onSubmitted?: (at: Date) => Promise<void>,
  ) {
    await this.check();
    await this.page.goto(`${this.s.baseUrl}/@${this.account.username}`, {
      waitUntil: 'domcontentloaded',
    });
    const before = new Set(
      await this.page
        .locator(this.s.postLink)
        .evaluateAll((nodes) => nodes.map((n) => (n as HTMLAnchorElement).href)),
    );
    await (await one(this.page.locator(this.s.create))).click();
    const dialog = await one(this.page.locator(this.s.dialog));
    const editor = await one(dialog.locator(this.s.editor));
    assert(
      !normalized(await editor.innerText()),
      'EXISTING_DRAFT',
      'Редактор содержит чужой черновик; автоматическая замена запрещена',
    );
    this.unsentEditor = editor;
    await editor.fill(text);
    assert(
      normalized(await editor.innerText()) === normalized(text),
      'TEXT_MISMATCH',
      'Текст в редакторе не совпал',
    );
    await this.guards();
    const button = await one(dialog.locator(this.s.submit));
    assert(await button.isEnabled(), 'UI_CHANGED', 'Кнопка публикации недоступна');
    await beforeSend(); // Persist the uncertain-send barrier before any external side effect.
    try {
      this.unsentEditor = undefined;
      await button.click();
      await onSubmitted?.(new Date());
      await dialog.waitFor({ state: 'hidden', timeout: 30000 });
      // Inspect the post-submit UI first; navigating away here loses the success permalink.
      const url = await this.confirmVisibleResult(
        this.s.ownPost,
        text,
        `${this.s.baseUrl}/@${this.account.username}`,
        before,
      );
      return { url, externalId: null };
    } catch (e) {
      throw new AppError('UNCERTAIN', `Результат отправки поста неизвестен: ${messageOf(e)}`);
    }
  }
  private validatePostUrl(url: string) {
    const u = new URL(url);
    assert(
      u.origin === new URL(this.s.baseUrl).origin &&
        u.pathname.startsWith(`/@${this.account.username}/post/`) &&
        /^\/@[^/]+\/post\/[^/]+\/?$/.test(u.pathname),
      'WRONG_ACCOUNT',
      'URL публикации не принадлежит аккаунту',
    );
  }
  async comment(
    postUrl: string,
    text: string,
    beforeSend: () => Promise<void>,
    attachment?: CommentAttachment,
    onSubmitted?: (at: Date) => Promise<void>,
  ) {
    this.validatePostUrl(postUrl);
    await this.page.goto(postUrl, { waitUntil: 'domcontentloaded' });
    await this.guards();
    await one(this.page.locator(this.s.identity.replaceAll('{username}', this.account.username)));
    const original = this.page.locator(this.s.ownPost).filter({
      has: this.page.locator(this.s.postLink + `[href*="${new URL(postUrl).pathname}"]`),
    });
    await (await one(original)).scrollIntoViewIfNeeded();
    let existing = await visibleResults(
      this.page,
      this.s.comment,
      this.s.postLink,
      text,
      this.account.username,
      this.s.mediaPreview,
    );
    for (let poll = 0; !existing.length && poll < 2; poll++) {
      await this.page.waitForTimeout(2000);
      existing = await visibleResults(
        this.page,
        this.s.comment,
        this.s.postLink,
        text,
        this.account.username,
        this.s.mediaPreview,
      );
    }
    if (existing.length === 1) {
      if (attachment)
        assert(
          existing[0]!.mediaCount > 0,
          'UNCERTAIN',
          'Найден текст CTA без подтверждённого вложения',
        );
      const urls = [...new Set(existing[0]!.urls)].filter((url) => {
        try {
          this.validatePostUrl(url);
          return new URL(url).pathname !== new URL(postUrl).pathname;
        } catch {
          return false;
        }
      });
      assert(
        urls.length <= 1,
        'UNCERTAIN',
        'Найден комментарий без однозначной собственной ссылки',
      );
      if (!urls.length) {
        await this.page.reload({ waitUntil: 'domcontentloaded' });
        await this.guards();
        const confirmed = await visibleResults(
          this.page,
          this.s.comment,
          this.s.postLink,
          text,
          this.account.username,
          this.s.mediaPreview,
        );
        assert(
          confirmed.length === 1 && (!attachment || confirmed[0]!.mediaCount > 0),
          'UNCERTAIN',
          'Существующий CTA не подтверждён повторным чтением',
        );
      }
      return { url: urls[0] ?? null };
    }
    assert(existing.length <= 1, 'UNCERTAIN', 'Несколько похожих комментариев; нужна сверка');
    await (await one((await one(original)).locator(this.s.reply))).click();
    const dialog = await one(this.page.locator(this.s.dialog));
    const editor = await one(dialog.locator(this.s.editor));
    assert(
      !normalized(await editor.innerText()),
      'EXISTING_DRAFT',
      'Редактор комментария содержит черновик; автоматическая замена запрещена',
    );
    this.unsentEditor = editor;
    await editor.fill(text);
    assert(
      normalized(await editor.innerText()) === normalized(text),
      'TEXT_MISMATCH',
      'Текст комментария не совпал',
    );
    if (attachment) {
      assert(
        this.s.mediaInput && this.s.mediaPreview,
        'MEDIA_SELECTORS_REQUIRED',
        'Не настроены селекторы изображения',
      );
      const data = await readFile(attachment.path);
      assert(
        data.length > 0 &&
          data.length <= 10 * 1024 * 1024 &&
          createHash('sha256').update(data).digest('hex') === attachment.sha256,
        'MEDIA_CHANGED',
        'Изображение изменено или превышает 10 МБ',
      );
      const input = dialog.locator(this.s.mediaInput);
      assert(
        (await input.count()) === 1,
        'UI_CHANGED',
        'Не найден однозначный загрузчик изображения',
      );
      const beforeImages = await mediaCount(dialog.locator(this.s.mediaPreview));
      await input.setInputFiles(attachment.path);
      await this.page.waitForFunction(
        ({ selector, preview, before }) => {
          const dialogs = [...document.querySelectorAll(selector)].filter(
            (n) => n.getClientRects().length,
          );
          return (
            dialogs.length === 1 &&
            [...dialogs[0]!.querySelectorAll(preview)].filter((n) => {
              const box = n.getBoundingClientRect();
              return (
                n instanceof HTMLImageElement &&
                n.complete &&
                n.naturalWidth > 0 &&
                box.width >= 80 &&
                box.height >= 80
              );
            }).length > before
          );
        },
        { selector: this.s.dialog, preview: this.s.mediaPreview, before: beforeImages },
        { timeout: 45000 },
      );
      assert(
        normalized(await editor.innerText()) === normalized(text),
        'TEXT_MISMATCH',
        'Текст CTA изменился при загрузке',
      );
    }
    await this.guards();
    const button = await one(dialog.locator(this.s.replySubmit));
    assert(await button.isEnabled(), 'UI_CHANGED', 'Кнопка комментария недоступна');
    await beforeSend();
    try {
      this.unsentEditor = undefined;
      await button.click();
      await onSubmitted?.(new Date());
      await dialog.waitFor({ state: 'hidden', timeout: 30000 });
      const url = await this.confirmVisibleResult(
        this.s.comment,
        text,
        postUrl,
        new Set([postUrl]),
        attachment,
        true,
      );
      return { url: url || null };
    } catch (e) {
      throw new AppError('UNCERTAIN', `Результат отправки комментария неизвестен: ${messageOf(e)}`);
    }
  }
  async find(text: string) {
    await this.check();
    await this.page.goto(`${this.s.baseUrl}/@${this.account.username}`, {
      waitUntil: 'domcontentloaded',
    });
    const rows = await visibleResults(
      this.page,
      this.s.ownPost,
      this.s.postLink,
      text,
      this.account.username,
    );
    const urls = [...new Set(rows.flatMap((r) => r.urls))].filter((url) => {
      try {
        this.validatePostUrl(url);
        return true;
      } catch {
        return false;
      }
    });
    return urls.length === 1 ? urls[0]! : null;
  }

  async evidence(error: unknown) {
    await mkdir(this.artifacts, { recursive: true });
    const prefix = join(this.artifacts, `${this.jobId}-${Date.now()}`);
    await Promise.allSettled([
      this.page.screenshot({ path: prefix + '.png', fullPage: true }),
      writeFile(
        prefix + '.json',
        JSON.stringify({
          jobId: this.jobId,
          url: this.page.url(),
          error: messageOf(error),
          errorCode: error instanceof AppError ? error.code : 'UNKNOWN',
          time: new Date(),
        }),
        { mode: 0o600 },
      ),
    ]);
  }
  close() {
    this.closing ??= (async () => {
      try {
        if (this.unsentEditor) await this.unsentEditor.fill('').catch(() => {});
        if (this.browser) await this.browser.close();
      } finally {
        await this.provider.stop(this.profileId);
      }
    })();
    return this.closing;
  }
}
export class ThreadsPublisher implements Publisher {
  constructor(
    private selectorsPath: string,
    private artifacts: string,
  ) {}
  async open(provider: BrowserProvider, profileId: string, account: Account, jobId: string) {
    const selectors = selectorsSchema.parse(JSON.parse(await readFile(this.selectorsPath, 'utf8')));
    const origin = new URL(selectors.baseUrl);
    assert(
      origin.protocol === 'https:' &&
        ['www.threads.com', 'www.threads.net'].includes(origin.hostname),
      'UNSAFE_URL',
      'Некорректный адрес Threads',
    );
    const session = await provider.start(profileId);
    let browser: Browser | null = null;
    try {
      browser = await chromium.connectOverCDP(session.cdpEndpoint, { timeout: 45000 });
      const context = browser.contexts()[0];
      assert(context, 'NO_CONTEXT', 'В профиле отсутствует браузерный контекст');
      const page = await context.newPage();
      page.setDefaultTimeout(15000);
      return new ThreadsSession(
        page,
        browser,
        provider,
        profileId,
        account,
        jobId,
        selectors,
        this.artifacts,
      );
    } catch (e) {
      try {
        await browser?.close();
      } finally {
        await provider.stop(profileId);
      }
      throw e;
    }
  }
}
export class MockPublisher implements Publisher {
  posts = new Map<string, string>();
  comments = new Map<string, string>();
  async open(
    provider: BrowserProvider,
    profileId: string,
    account: Account,
    jobId: string,
  ): Promise<PublishingSession> {
    await provider.start(profileId);
    return {
      check: async () => {},
      publish: async (text, before) => {
        await before();
        const url = `https://www.threads.com/@${account.username}/post/demo-${jobId}`;
        this.posts.set(jobId, text);
        return { url, externalId: null };
      },
      comment: async (url, text, before) => {
        await before();
        this.comments.set(jobId, text);
        return { url: url + '-reply' };
      },
      find: async () =>
        this.posts.has(jobId)
          ? `https://www.threads.com/@${account.username}/post/demo-${jobId}`
          : null,
      evidence: async () => {},
      close: async () => provider.stop(profileId),
    };
  }
}
