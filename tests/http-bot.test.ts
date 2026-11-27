import { describe, it, expect } from 'vitest';
import { deliverGenerations } from '../src/bot/generation.js';
import { createApplication } from '../src/app.js';
import { MemoryDatabase } from '../src/db/database.js';
import { testConfig, fastClock } from './helpers.js';
describe('HTTP и офлайн Telegram', () => {
  it('закрывает внутренние API и обслуживает весь сценарий Telegram без сети', async () => {
    const app = await createApplication(testConfig(), new MemoryDatabase(), { clock: fastClock() });
    const http = app.server!;
    const headers = { authorization: 'Bearer demo-local-token' };
    try {
      expect((await http.inject({ url: '/api/accounts' })).statusCode).toBe(401);
      expect((await http.inject({ url: '/api/accounts', headers })).json()).toHaveLength(10);
      const telegram = async (payload: object) => {
        const r = await http.inject({
          method: 'POST',
          url: '/api/demo/telegram',
          headers,
          payload,
        });
        expect(r.statusCode).toBe(200);
        return r.json().messages as any[];
      };
      const menu = await telegram({ text: '/start' });
      expect(menu[0].text).toContain('Демонстрационный');
      expect(
        menu[0].reply_markup.inline_keyboard
          .flat()
          .some((b: any) => b.callback_data === 'v115abmenu'),
      ).toBe(true);
      const sourceMessages = await telegram({ text: 'Keep risk under control.' });
      const sourceButton = sourceMessages[0].reply_markup.inline_keyboard[0][0].callback_data;
      await telegram({ callback: sourceButton });
      await telegram({ callback: 'select:demo-account-1' });
      const drafts = await telegram({ callback: 'generate_selected' });
      expect(drafts.some((m) => m.text?.includes('Генерирую'))).toBe(true);
      await app.services.generation.tick();
      expect((await app.services.generation.list())[0]?.status).toBe('COMPLETED');
      await deliverGenerations(app.bot!, app.services);
      const sourceCount = (await app.db.list('source')).length;
      await app.bot!.handleUpdate({
        update_id: 999999,
        message: {
          message_id: 999999,
          date: 1,
          from: { id: 2, is_bot: false, first_name: 'Нет доступа' },
          chat: { id: 2, type: 'private', first_name: 'Нет доступа' },
          text: 'Unauthorized text',
        },
      });
      expect(await app.db.list('source')).toHaveLength(sourceCount);
      const before = (await app.db.list('post')).length;
      const task = (await app.services.generation.list())[0]!;
      await telegram({ callback: `post_ok:${task.results![0]}` });
      const blocked = await telegram({ callback: `post_send:${task.results![0]}` });
      expect(blocked.some((m) => m.text?.includes('Ручные публикации: выключены'))).toBe(true);
      expect((await app.db.list('post')).length).toBe(before);
      const report = await telegram({ callback: 'analytics' });
      expect(report.at(-1).text).toContain('ИСКУССТВЕННЫЕ ДАННЫЕ');
      const csv = await http.inject({ url: '/api/analytics.csv', headers });
      expect(csv.headers['content-type']).toContain('text/csv');
      expect(csv.body).toContain('firstHourViews');
    } finally {
      await app.close();
    }
  }, 30000);
  it('сохраняет очередь и отмену после перезапуска файлового демо', async () => {
    const { mkdtemp, rm } = await import('node:fs/promises'),
      { tmpdir } = await import('node:os'),
      { join } = await import('node:path');
    const dir = await mkdtemp(join(tmpdir(), 'cf-restart-')),
      path = join(dir, 'state.json');
    try {
      const a = new MemoryDatabase(path);
      await a.load();
      await a.insert('setting', { id: 'test', createdAt: new Date(), value: 'CANCELLED' });
      await a.close();
      const b = new MemoryDatabase(path);
      await b.load();
      expect((await b.get('setting', 'test'))!.value).toBe('CANCELLED');
      expect((await b.get('setting', 'test'))!.createdAt).toBeInstanceOf(Date);
      await b.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
