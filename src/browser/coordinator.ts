import { chromium, type Page } from 'playwright';
import type { Database } from '../db/database.js';
import type { Account, BrowserProfile } from '../core/domain.js';
import type { BrowserProvider } from './providers.js';
import { withBrowserSlot } from '../scheduler/worker.js';
import { withProfileLease } from '../scheduler/lease.js';
import { assert, AppError } from '../core/errors.js';
export interface BrowserAccess {
  use<T>(
    accountId: string,
    purpose: 'PROFILE' | 'SEARCH' | 'REPLY',
    fn: (page: Page, account: Account, signal: AbortSignal) => Promise<T>,
  ): Promise<T>;
}
export class BrowserCoordinator implements BrowserAccess {
  constructor(
    private db: Database,
    private providers: Record<BrowserProfile['provider'], BrowserProvider>,
  ) {}
  async use<T>(
    accountId: string,
    purpose: 'PROFILE' | 'SEARCH' | 'REPLY',
    fn: (page: Page, account: Account, signal: AbortSignal) => Promise<T>,
  ) {
    const account = await this.db.get('account', accountId);
    assert(account, 'NOT_FOUND', 'Аккаунт не найден');
    if (purpose !== 'PROFILE') {
      const urgent = (await this.db.list('publishJob')).some(
        (j) =>
          j.status === 'RUNNING' ||
          (purpose === 'SEARCH' &&
            j.status === 'QUEUED' &&
            j.scheduledAt.getTime() <= Date.now() + 60000),
      );
      assert(!urgent, 'PUBLISH_PRIORITY', 'Сначала завершаются собственные публикации и CTA');
    }
    const profile = await this.db.get('browserProfile', account.profileId);
    assert(profile, 'NOT_FOUND', 'Профиль браузера не найден');
    return withBrowserSlot(this.db, 1, (slotSignal) =>
      withProfileLease(this.db, profile.id, async (profileSignal) => {
        const priority = new AbortController();
        const signal = AbortSignal.any([slotSignal, profileSignal, priority.signal]);
        const provider = this.providers[profile.provider];
        // Never borrow/close another worker's or a manually opened profile.
        assert(
          !(await provider.status(profile.externalId)),
          'PROFILE_BUSY',
          'Профиль уже открыт вне текущей операции',
        );
        const session = await provider.start(profile.externalId);
        let browser;
        let page: Page | undefined;
        const aborted = () => {
          void page?.close().catch(() => {});
        };
        signal.addEventListener('abort', aborted, { once: true });
        let checking = Promise.resolve();
        const timer =
          purpose === 'SEARCH'
            ? setInterval(() => {
                checking = checking
                  .then(async () => {
                    const urgent = (await this.db.list('publishJob')).some(
                      (j) =>
                        j.status === 'RUNNING' ||
                        (j.status === 'QUEUED' && j.scheduledAt.getTime() <= Date.now() + 60000),
                    );
                    if (urgent)
                      priority.abort(
                        new AppError('PUBLISH_PRIORITY', 'Поиск уступил браузер публикациям'),
                      );
                  })
                  .catch(() =>
                    priority.abort(
                      new AppError('STATE_UNAVAILABLE', 'Не удалось проверить приоритет очереди'),
                    ),
                  );
              }, 2500)
            : undefined;
        timer?.unref();
        try {
          browser = await chromium.connectOverCDP(session.cdpEndpoint, { timeout: 45000 });
          const context = browser.contexts()[0];
          assert(context, 'NO_CONTEXT', 'Не найден контекст профиля');
          page = await context.newPage();
          page.setDefaultTimeout(15000);
          const result = await fn(page, account, signal);
          signal.throwIfAborted();
          return result;
        } catch (e) {
          if (signal.aborted) throw signal.reason;
          throw e;
        } finally {
          if (timer) clearInterval(timer);
          await checking;
          signal.removeEventListener('abort', aborted);
          await page?.close().catch(() => {});
          await provider.stop(profile.externalId);
          await browser?.close().catch(() => {});
          // AdsPower acknowledges stop before its activity endpoint always catches up.
          for (
            let attempt = 0;
            attempt < 4 && (await provider.status(profile.externalId));
            attempt++
          )
            await new Promise((resolve) => setTimeout(resolve, 1500));
          if (await provider.status(profile.externalId))
            throw new AppError('PROFILE_CLOSE_FAILED', 'Браузер не закрылся');
        }
      }),
    );
  }
}
