import { MemoryDatabase, base } from '../db/database.js';
import { seedStyles } from '../db/seed.js';
import { Scheduler } from '../scheduler/service.js';
import { PublishingWorker, type WorkerClock } from '../scheduler/worker.js';
import { MockBrowserProvider } from './providers.js';
import { MockPublisher, type Publisher } from './publisher.js';
import { AppError } from '../core/errors.js';
export const DIAGNOSTIC_SCENARIOS = [
  'OK',
  'PROFILE_START_ERROR',
  'CDP_ERROR',
  'TIMEOUT',
  'CONNECTION_LOST',
  'AUTH_REQUIRED',
  'PUBLISH_FAILED',
  'COMMENT_FAILED',
  'UNCERTAIN_POST',
  'UNCERTAIN_COMMENT',
] as const;
export type DiagnosticScenario = (typeof DIAGNOSTIC_SCENARIOS)[number];
export class BrowserDiagnostics {
  async run(scenario: DiagnosticScenario = 'OK', profileId = 'Threads 02') {
    if (!DIAGNOSTIC_SCENARIOS.includes(scenario))
      throw new AppError('INVALID_SCENARIO', 'Неизвестный сценарий диагностики');
    // Intentionally isolated from environment config, real providers, credentials and application DB.
    const db = new MemoryDatabase();
    await seedStyles(db);
    const trace: string[] = [];
    class Provider extends MockBrowserProvider {
      override async start(id: string) {
        trace.push(`MOCK_PROFILE_START:${id}`);
        if (scenario === 'PROFILE_START_ERROR')
          throw new AppError('PROVIDER_NETWORK', 'Тестовая ошибка запуска профиля', true);
        return super.start(id);
      }
      override async stop(id: string) {
        trace.push(`MOCK_PROFILE_STOP:${id}`);
        return super.stop(id);
      }
    }
    const provider = new Provider(),
      mockPublisher = new MockPublisher();
    let virtualNow = Date.now();
    const clock: WorkerClock = {
      now: () => virtualNow,
      sleep: async (ms, signal) => {
        signal.throwIfAborted();
        virtualNow += ms;
      },
    };
    const profile = await db.insert('browserProfile', {
      ...base(),
      provider: 'MOCK',
      externalId: profileId,
      name: 'Диагностический профиль',
    });
    const account = await db.insert('account', {
      ...base(),
      name: 'Тестовый аккаунт',
      username: 'diagnostic_only',
      profileUrl: 'https://www.threads.com/@diagnostic_only',
      profileId: profile.id,
      styleId: 'style-1',
      status: 'ACTIVE',
      autoApprove: false,
      followers: null,
      lastPublishedAt: null,
      ctaId: null,
      insightsUserId: null,
    });
    const source = await db.insert('source', {
        ...base(),
        url: null,
        fingerprint: 'diagnostic-source',
        text: 'Control risk.',
        author: null,
        rights: 'OWN',
      }),
      g = await db.insert('generated', {
        ...base(),
        sourceId: source.id,
        styleId: 'style-1',
        accountId: account.id,
        text: 'Контролирую риск.',
        version: 1,
        valid: true,
        approved: true,
      });
    const publisher: Publisher = {
      open: async (p, id, a, jobId) => {
        const s = await mockPublisher.open(p, id, a, jobId);
        trace.push('MOCK_CDP_CONNECT');
        if (scenario === 'CDP_ERROR') {
          await s.close();
          throw new AppError('CDP_ERROR', 'Тестовая ошибка подключения CDP');
        }
        return {
          ...s,
          check: async () => {
            trace.push('MOCK_AUTH_CHECK');
            if (scenario === 'AUTH_REQUIRED')
              throw new AppError('AUTH_REQUIRED', 'Нужна авторизация');
          },
          publish: async (text, before) => {
            trace.push('MOCK_POST');
            if (scenario === 'TIMEOUT') throw new AppError('UI_TIMEOUT', 'Тестовый таймаут', true);
            if (scenario === 'PUBLISH_FAILED')
              throw new AppError('PUBLISH_FAILED', 'Публикация не начата');
            if (scenario === 'UNCERTAIN_POST' || scenario === 'CONNECTION_LOST') {
              await before();
              throw new AppError('CONNECTION_LOST', 'Соединение потеряно после начала отправки');
            }
            return s.publish(text, before);
          },
          comment: async (url, text, before) => {
            trace.push('MOCK_COMMENT');
            if (scenario === 'COMMENT_FAILED')
              throw new AppError('COMMENT_FAILED', 'Тестовая ошибка до отправки CTA');
            if (scenario === 'UNCERTAIN_COMMENT') {
              await before();
              throw new AppError('CONNECTION_LOST', 'Результат CTA неизвестен');
            }
            return s.comment(url, text, before);
          },
          evidence: async () => {
            trace.push('MOCK_EVIDENCE');
          },
        };
      },
    };
    const [job] = await new Scheduler(db).createBatch([g.id], 'diagnostics');
    virtualNow = Math.max(virtualNow, job!.scheduledAt.getTime());
    const worker = new PublishingWorker(
      db,
      { MOCK: provider, ADSPOWER: provider, DOLPHIN: provider },
      publisher,
      async () => {},
      1,
      clock,
    );
    for (let attempt = 0; attempt < 3; attempt++) {
      const current = (await db.get('publishJob', job!.id))!;
      if (current.status !== 'QUEUED') break;
      virtualNow = Math.max(virtualNow, current.scheduledAt.getTime());
      await worker.execute(job!.id);
    }
    const result = (await db.get('publishJob', job!.id))!;
    const report = {
      mode: 'DRY_RUN',
      simulated: true,
      scenario,
      savedProfileId: profile.externalId,
      provider: 'MockBrowserProvider',
      realBrowserStarted: false,
      externalRequests: 0,
      llmRequests: (await db.list('aiRequest')).length,
      status: result.status,
      postStatus: result.postStatus,
      commentStatus: result.commentStatus,
      attempts: result.attempts,
      error: result.lastError,
      activeSessions: (await provider.activeSessions()).length,
      profileLeases: (await db.list('lease')).length,
      trace,
    };
    await db.close();
    return report;
  }
}
