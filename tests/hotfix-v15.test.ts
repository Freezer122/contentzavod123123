import { describe, it, expect } from 'vitest';
import { fixture } from './helpers.js';
import { PublishingWorker } from '../src/scheduler/worker.js';
import { AppError } from '../src/core/errors.js';
import { createApplication } from '../src/app.js';
import { MemoryDatabase } from '../src/db/database.js';
import { testConfig } from './helpers.js';

async function timeline(confirmMs: number, prepareMs: number, uncertain = false) {
  const f = await fixture();
  const [job] = await f.scheduler.createBatch([f.generated.id], 'test');
  let now = Date.now(),
    commentCalls = 0;
  const clock = {
    now: () => now,
    sleep: async (ms: number, signal: AbortSignal) => {
      signal.throwIfAborted();
      now += ms;
    },
  };
  const notifications: string[] = [];
  const publisher = {
    open: async (...args: Parameters<typeof f.publisher.open>) => {
      const session = await f.publisher.open(...args);
      return {
        ...session,
        publish: async (...p: Parameters<typeof session.publish>) => {
          const result = await session.publish(...p);
          now += confirmMs;
          if (uncertain) throw new AppError('UNCERTAIN', 'Result is unknown');
          return result;
        },
        comment: async (...p: Parameters<typeof session.comment>) => {
          commentCalls++;
          now += prepareMs;
          const result = await session.comment(...p);
          now += 4000;
          return result;
        },
      };
    },
  };
  const worker = new PublishingWorker(
    f.db,
    f.providers,
    publisher,
    async (text) => {
      notifications.push(text);
    },
    1,
    clock,
  );
  await worker.execute(job!.id);
  await worker.execute(job!.id);
  await worker.recover();
  return { ...f, state: (await f.db.get('publishJob', job!.id))!, notifications, commentCalls };
}
describe('V1.5 CTA timing', () => {
  it('готовит CTA заранее и отправляет через 20 секунд от submit, а не confirmation', async () => {
    const f = await timeline(3000, 5000);
    const j = f.state;
    expect(j.status).toBe('COMPLETED');
    expect(j.postConfirmedAt!.getTime() - j.postSubmitAt!.getTime()).toBe(3000);
    expect(j.ctaScheduledAt!.getTime() - j.postSubmitAt!.getTime()).toBe(20000);
    expect(j.ctaSubmitAt!.getTime() - j.postSubmitAt!.getTime()).toBe(20000);
    expect(j.ctaConfirmedAt!.getTime() - j.ctaSubmitAt!.getTime()).toBe(4000);
    expect(f.commentCalls).toBe(1);
    expect(f.notifications).toHaveLength(0);
  });
  it('при подтверждении позже 20 секунд не добавляет ещё двадцать', async () => {
    const f = await timeline(30000, 2000);
    expect(f.state.ctaSubmitAt!.getTime() - f.state.postSubmitAt!.getTime()).toBe(32000);
    expect(f.state.ctaSubmitAt!.getTime() - f.state.ctaScheduledAt!.getTime()).toBe(12000);
  });
  it('уведомляет один раз об интервале более 45 секунд', async () => {
    const f = await timeline(50000, 2000);
    expect(f.notifications).toHaveLength(1);
    expect(f.notifications[0]).toContain('CTA задерживается');
    expect(f.state.ctaDelayNotifiedAt).toBeInstanceOf(Date);
    expect(f.state.ctaSubmitAt!.getTime() - f.state.postSubmitAt!.getTime()).toBe(52000);
  });
  it('не отправляет CTA и не повторяет пост при неопределённом результате', async () => {
    const f = await timeline(50000, 0, true);
    expect(f.state.status).toBe('NEEDS_REVIEW');
    expect(f.state.postStatus).toBe('UNCERTAIN');
    expect(f.state.postSubmitAt).toBeInstanceOf(Date);
    expect(f.state.postConfirmedAt ?? null).toBeNull();
    expect(f.state.ctaSubmitAt ?? null).toBeNull();
    expect(f.commentCalls).toBe(0);
    expect(f.publisher.posts.size).toBe(1);
    expect(f.notifications.some((x) => x.includes('CTA задерживается'))).toBe(true);
    expect(await f.db.list('aiRequest')).toHaveLength(0);
  });
});
describe('V1.5 private Telegram commands', () => {
  it('обслуживает пять команд и CTA UI без LLM; чужой ID не получает доступ', async () => {
    const app = await createApplication(testConfig(), new MemoryDatabase());
    try {
      const send = async (payload: object) =>
        (
          await app.server!.inject({
            method: 'POST',
            url: '/api/demo/telegram',
            headers: { authorization: 'Bearer demo-local-token' },
            payload,
          })
        ).json().messages as any[];
      for (const [command, expected] of [
        ['/start', 'Content Factory'],
        ['/ping', 'pong'],
        ['/status', 'Система'],
        ['/accounts', 'Аккаунты'],
        ['/queue', 'Задач:'],
      ]) {
        const replies = await send({ text: command });
        expect(replies.some((m) => m.text?.includes(expected))).toBe(true);
      }
      const account = (await app.db.list('account'))[0]!;
      await send({ callback: `cta_edit:${account.id}` });
      await send({ text: 'Новый CTA для проверки' });
      const preview = await send({ text: 'https://t.me/v15_fixture' });
      expect(preview.some((m) => m.text?.includes('Новый CTA для проверки'))).toBe(true);
      await send({ callback: 'cta_save' });
      expect((await app.services.ctas.ensure(account.id)).text).toBe('Новый CTA для проверки');
      const count = (await app.db.list('audit')).length;
      await app.bot!.handleUpdate({
        update_id: 9823,
        message: {
          message_id: 9823,
          date: 1,
          from: { id: 2, is_bot: false, first_name: 'Denied' },
          chat: { id: 2, type: 'private', first_name: 'Denied' },
          text: '/status',
          entities: [{ offset: 0, length: 7, type: 'bot_command' }],
        },
      });
      expect((await app.db.list('audit')).length).toBe(count);
      expect(await app.db.list('aiRequest')).toHaveLength(0);
    } finally {
      await app.close();
    }
  });
});
