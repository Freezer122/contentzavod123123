import { TemplateService } from '../content/templates.js';
import { CtaService } from '../cta/service.js';
import { z } from 'zod';
import type { Database } from '../db/database.js';
import { base, audit } from '../db/database.js';
import { assert, messageOf } from '../core/errors.js';
import type { BrowserProvider } from '../browser/providers.js';
import type { Publisher } from '../browser/publisher.js';
import type { Account, BrowserProfile } from '../core/domain.js';
export const accountInput = z.object({
  username: z.string().regex(/^[A-Za-z0-9_.]{1,64}$/),
  name: z.string().min(1).max(100),
  provider: z.enum(['ADSPOWER', 'DOLPHIN', 'MOCK']),
  externalId: z.string().min(1).max(100),
  styleId: z.string().min(1),
});
export class AccountManager {
  constructor(
    private db: Database,
    private providers: Record<BrowserProfile['provider'], BrowserProvider>,
    private publisher: Publisher,
    private demo: boolean,
    private concurrency = 1,
    private allowBrowserAccess = true,
    private ctaConfig = {
      publicBase: 'https://factory.example.com',
      target: 'https://t.me/content_factory_demo',
    },
  ) {}
  async add(raw: unknown, actor: string) {
    const data = accountInput.parse(raw);
    assert(
      this.demo || data.provider !== 'MOCK',
      'DEMO_ONLY',
      'Mock-профиль доступен только в демонстрации',
    );
    return this.db.transaction(async (tx) => {
      assert(await tx.get('style', data.styleId), 'NOT_FOUND', 'Стиль не найден');
      assert(
        !(await tx.list('account', { username: data.username })).length,
        'DUPLICATE',
        'Аккаунт уже добавлен',
      );
      assert(
        !(await tx.list('browserProfile', { provider: data.provider, externalId: data.externalId }))
          .length,
        'DUPLICATE',
        'Профиль уже назначен',
      );
      const profile = await tx.insert('browserProfile', {
        ...base(),
        provider: data.provider,
        externalId: data.externalId,
        name: data.name,
      });
      const account = await tx.insert('account', {
        ...base(),
        username: data.username,
        profileUrl: `https://www.threads.com/@${data.username}`,
        name: data.name,
        profileId: profile.id,
        styleId: data.styleId,
        status: 'PAUSED',
        autoApprove: false,
        followers: null,
        lastPublishedAt: null,
        ctaId: null,
        insightsUserId: null,
      });
      await new CtaService(tx, this.ctaConfig.publicBase, this.ctaConfig.target).ensure(account.id);
      await new TemplateService(tx).ensureOwnStyle(account.id);
      await audit(tx, actor, 'ADD_ACCOUNT', account.id);
      return (await tx.get('account', account.id))!;
    });
  }
  async setStatus(id: string, status: Account['status'], actor: string) {
    return this.db.transaction(async (tx) => {
      const a = await tx.get('account', id);
      assert(a, 'NOT_FOUND', 'Аккаунт не найден');
      await audit(tx, actor, `ACCOUNT_${status}`, id);
      return tx.update('account', id, { status });
    });
  }
  async checkAll() {
    assert(
      this.allowBrowserAccess,
      'DRY_RUN_ONLY',
      'Проверка реальных профилей отключена. Используйте диагностику DRY_RUN.',
    );
    const results: { id: string; status: string }[] = [];
    // Sequential checks respect the server's browser budget, including publishing workers.
    for (const account of await this.db.list('account')) {
      const profile = await this.db.get('browserProfile', account.profileId);
      assert(profile, 'NOT_FOUND', 'Профиль не найден');
      const { withProfileLease } = await import('../scheduler/lease.js');
      const { withBrowserSlot } = await import('../scheduler/worker.js');
      try {
        await withBrowserSlot(this.db, this.concurrency, (slotSignal) =>
          withProfileLease(this.db, profile.id, async (profileSignal) => {
            const signal = AbortSignal.any([slotSignal, profileSignal]);
            const provider = this.providers[profile.provider];
            assert(
              !(await provider.status(profile.externalId)),
              'PROFILE_BUSY',
              'Профиль уже используется',
            );
            const session = await this.publisher.open(
              provider,
              profile.externalId,
              account,
              `check-${account.id}`,
            );
            const abort = () => {
              void session.close().catch(() => {});
            };
            signal.addEventListener('abort', abort, { once: true });
            try {
              signal.throwIfAborted();
              await session.check();
              signal.throwIfAborted();
            } catch (e) {
              await session.evidence(e);
              throw e;
            } finally {
              signal.removeEventListener('abort', abort);
              await session.close();
            }
          }),
        );
        results.push({ id: account.id, status: 'Доступен' });
      } catch (e) {
        const code = (e as { code?: string }).code;
        const status =
          code === 'AUTH_REQUIRED'
            ? 'AUTH_REQUIRED'
            : code === 'CHALLENGE' || code === 'RESTRICTED'
              ? 'RESTRICTED'
              : code === 'PROFILE_BUSY'
                ? 'PAUSED'
                : 'ERROR';
        if (code !== 'PROFILE_BUSY') {
          await this.db.update('account', account.id, { status });
          await this.db.insert('systemEvent', {
            ...base(),
            level: 'ERROR',
            code: 'PROFILE_CHECK',
            message: messageOf(e),
          });
        }
        results.push({ id: account.id, status: code ?? 'ERROR' });
      }
    }
    return results;
  }
}
