import { it, expect, describe } from 'vitest';
import {
  AdsPowerProvider,
  DolphinProvider,
  localEndpoint,
  type Fetch,
} from '../src/browser/providers.js';
const response = (data: unknown) =>
  new Response(JSON.stringify(data), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
describe('Контракты Browser Local API', () => {
  it('allowlist не допускает запросов к другому профилю', async () => {
    let calls = 0;
    const p = new AdsPowerProvider(
      'http://127.0.0.1:50325',
      '',
      (async () => {
        calls++;
        return response({ code: 0, data: {} });
      }) as Fetch,
      ['threads02-only'],
    );
    for (const operation of [
      () => p.start('thread01'),
      () => p.stop('thread01'),
      () => p.status('thread01'),
    ])
      await expect(operation()).rejects.toMatchObject({ code: 'PROFILE_NOT_ALLOWED' });
    expect(calls).toBe(0);
  });
  it('данные назначенного прокси не возвращают пароль и порт', async () => {
    const p = new AdsPowerProvider('http://127.0.0.1:50325', '', (async () =>
      response({
        code: 0,
        data: {
          list: [
            {
              user_id: 'target',
              ip: '203.0.113.9',
              user_proxy_config: {
                proxy_host: '203.0.113.9',
                proxy_type: 'socks5',
                proxy_port: '1234',
                proxy_user: 'fixture-user',
                proxy_password: 'fixture-password',
              },
            },
          ],
        },
      })) as Fetch);
    expect(await p.proxyAssignment('target')).toEqual({ host: '203.0.113.9', type: 'socks5' });
  });
  it('AdsPower использует CDP из data.ws.puppeteer и останавливает профиль', async () => {
    const calls: URL[] = [];
    const request = (async (url: any) => {
      const u = new URL(url);
      calls.push(u);
      return response({
        code: 0,
        data: u.pathname.endsWith('/start')
          ? { ws: { puppeteer: 'ws://127.0.0.1:9000/devtools/browser/a' } }
          : u.pathname.endsWith('/list')
            ? { list: [{ user_id: 'profile', name: 'Мой профиль' }] }
            : { status: 'Active' },
      });
    }) as Fetch;
    const p = new AdsPowerProvider('http://127.0.0.1:50325', 'key', request);
    expect(await p.listProfiles()).toEqual([{ id: 'profile', name: 'Мой профиль' }]);
    expect((await p.start('profile')).cdpEndpoint).toContain('9000');
    expect(await p.status('profile')).toBe(true);
    await p.stop('profile');
    expect(calls.at(-1)!.pathname).toBe('/api/v1/browser/stop');
    expect(calls.at(-1)!.searchParams.get('user_id')).toBe('profile');
  });
  it('Dolphin авторизует Local API и собирает ws endpoint', async () => {
    const calls: string[] = [];
    const p = new DolphinProvider('http://127.0.0.1:3001', 'token', (async (url: any) => {
      calls.push(String(url));
      return response(
        String(url).includes('/start?')
          ? { success: true, automation: { port: 9010, wsEndpoint: '/devtools/browser/a' } }
          : { success: true },
      );
    }) as Fetch);
    expect((await p.start('id')).cdpEndpoint).toBe('ws://127.0.0.1:9010/devtools/browser/a');
    expect(calls[0]).toContain('login-with-token');
    await p.stop('id');
    expect(calls.at(-1)).toContain('/id/stop');
  });
  it('не подключает CDP к произвольному удалённому хосту', () => {
    expect(() => localEndpoint('ws://evil.test/devtools')).toThrow();
  });
  it('контролируемо сообщает об ошибке провайдера', async () => {
    const p = new AdsPowerProvider('http://127.0.0.1:50325', '', (async () =>
      response({ code: -1, msg: 'not running' })) as Fetch);
    await expect(p.start('one')).rejects.toMatchObject({ code: 'ADSPOWER_ERROR' });
  });
});
