import { z } from 'zod';
import { AppError } from '../core/errors.js';
export interface ProfileInfo {
  id: string;
  name: string;
}
export interface BrowserSession {
  profileId: string;
  cdpEndpoint: string;
}
export interface BrowserProvider {
  listProfiles(): Promise<ProfileInfo[]>;
  start(id: string): Promise<BrowserSession>;
  stop(id: string): Promise<void>;
  status(id: string): Promise<boolean>;
  activeSessions(): Promise<BrowserSession[]>;
}
export type Fetch = typeof fetch;
async function json(url: string, init: RequestInit = {}, request: Fetch = fetch): Promise<any> {
  let res: Response;
  try {
    res = await request(url, { ...init, signal: AbortSignal.timeout(45000), redirect: 'error' });
  } catch {
    throw new AppError('PROVIDER_NETWORK', 'Browser API недоступен', true);
  }
  if (!res.ok)
    throw new AppError(
      'PROVIDER_HTTP',
      `Browser API: HTTP ${res.status}`,
      res.status >= 500 || res.status === 429,
    );
  return res.json();
}
export function localEndpoint(endpoint: string): string {
  const u = new URL(endpoint);
  if (
    !['ws:', 'wss:', 'http:', 'https:'].includes(u.protocol) ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)
  )
    throw new AppError('UNSAFE_CDP', 'CDP endpoint должен быть локальным');
  return endpoint;
}
export class AdsPowerProvider implements BrowserProvider {
  private sessions = new Map<string, BrowserSession>();
  constructor(
    private baseUrl: string,
    private key = '',
    private request: Fetch = fetch,
    private allowedProfileIds: readonly string[] = [],
    private headless = false,
    private beforeStart: () => Promise<void> = async () => {},
  ) {}
  private allow(id: string) {
    if (this.allowedProfileIds.length && !this.allowedProfileIds.includes(id))
      throw new AppError('PROFILE_NOT_ALLOWED', 'Профиль не разрешён для этого исполнителя');
  }
  private async call(path: string, params: Record<string, string> = {}) {
    const u = new URL(path, this.baseUrl);
    Object.entries(params).forEach(([k, v]) => u.searchParams.set(k, v));
    const data = await json(
      u.href,
      { headers: this.key ? { Authorization: `Bearer ${this.key}` } : {} },
      this.request,
    );
    if (data.code !== 0)
      throw new AppError(
        'ADSPOWER_ERROR',
        `AdsPower отклонил запрос: ${String(data.msg ?? 'ошибка')}`,
      );
    return data.data;
  }
  async listProfiles() {
    const profiles: ProfileInfo[] = [];
    for (let page = 1; page <= 1000; page++) {
      const d = await this.call('/api/v1/user/list', { page: String(page), page_size: '100' });
      const rows = z
        .array(z.object({ user_id: z.string(), name: z.string().optional() }))
        .parse(d.list);
      profiles.push(...rows.map((x) => ({ id: x.user_id, name: x.name ?? x.user_id })));
      if (rows.length < 100) return profiles;
    }
    throw new AppError('PAGINATION_LIMIT', 'Слишком много профилей');
  }
  async start(id: string) {
    this.allow(id);
    await this.beforeStart();
    const d = await this.call('/api/v1/browser/start', {
      user_id: id,
      open_tabs: '1',
      ...(this.headless ? { headless: '1', ip_tab: '0' } : {}),
    });
    const endpoint = z.string().parse(d.ws?.puppeteer);
    const session = { profileId: id, cdpEndpoint: localEndpoint(endpoint) };
    this.sessions.set(id, session);
    return session;
  }
  async proxyAssignment(id: string) {
    this.allow(id);
    const data = await this.call('/api/v1/user/list', { user_id: id, page: '1', page_size: '100' });
    const rows = z
      .array(
        z.object({
          user_id: z.string(),
          ip: z.string().optional(),
          user_proxy_config: z.object({ proxy_host: z.string(), proxy_type: z.string() }),
        }),
      )
      .parse(data.list)
      .filter((row) => row.user_id === id);
    if (rows.length !== 1) throw new AppError('PROFILE_NOT_UNIQUE', 'Профиль не найден однозначно');
    return {
      host: rows[0]!.user_proxy_config.proxy_host,
      type: rows[0]!.user_proxy_config.proxy_type,
    };
  }
  async stop(id: string) {
    this.allow(id);
    await this.call('/api/v1/browser/stop', { user_id: id });
    this.sessions.delete(id);
  }
  async status(id: string) {
    this.allow(id);
    const d = await this.call('/api/v1/browser/active', { user_id: id });
    return d.status === 'Active';
  }
  async activeSessions() {
    const out: BrowserSession[] = [];
    for (const s of this.sessions.values()) if (await this.status(s.profileId)) out.push(s);
    return out;
  }
}
export class DolphinProvider implements BrowserProvider {
  private sessions = new Map<string, BrowserSession>();
  constructor(
    private baseUrl: string,
    private token = '',
    private request: Fetch = fetch,
  ) {}
  private async local(path: string) {
    const d = await json(new URL(path, this.baseUrl).href, {}, this.request);
    if (d.success === false) throw new AppError('DOLPHIN_ERROR', 'Dolphin отклонил запрос');
    return d;
  }
  async listProfiles() {
    if (!this.token)
      throw new AppError('TOKEN_REQUIRED', 'Для списка профилей Dolphin нужен API token');
    let next: string | null = 'https://dolphin-anty-api.com/browser_profiles/list-cursor?limit=50';
    const out: ProfileInfo[] = [];
    for (let page = 0; next && page < 1000; page++) {
      const u = new URL(next);
      if (u.origin !== 'https://dolphin-anty-api.com')
        throw new AppError('UNSAFE_URL', 'Непредвиденный адрес Dolphin');
      const d = await json(
        u.href,
        { headers: { Authorization: `Bearer ${this.token}` } },
        this.request,
      );
      out.push(
        ...z
          .array(z.object({ id: z.union([z.number(), z.string()]), name: z.string().nullable() }))
          .parse(d.data)
          .map((x) => ({ id: String(x.id), name: x.name ?? String(x.id) })),
      );
      next = d.next_page_url ?? null;
    }
    if (next) throw new AppError('PAGINATION_LIMIT', 'Слишком много профилей');
    return out;
  }
  async start(id: string) {
    if (this.token) {
      const auth = await json(
        new URL('/v1.0/auth/login-with-token', this.baseUrl).href,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: this.token }),
        },
        this.request,
      );
      if (auth.success !== true)
        throw new AppError('DOLPHIN_AUTH', 'Не удалось авторизовать Dolphin Local API');
    }
    const d = await this.local(
      `/v1.0/browser_profiles/${encodeURIComponent(id)}/start?automation=1`,
    );
    const a = z
      .object({ port: z.number().int().min(1).max(65535), wsEndpoint: z.string() })
      .parse(d.automation);
    const endpoint = a.wsEndpoint.startsWith('ws')
      ? a.wsEndpoint
      : `ws://127.0.0.1:${a.port}${a.wsEndpoint}`;
    const session = { profileId: id, cdpEndpoint: localEndpoint(endpoint) };
    this.sessions.set(id, session);
    return session;
  }
  async stop(id: string) {
    await this.local(`/v1.0/browser_profiles/${encodeURIComponent(id)}/stop`);
    this.sessions.delete(id);
  }
  async status(id: string) {
    const session = this.sessions.get(id);
    if (!session) return false;
    try {
      await json(
        new URL('/json/version', `http://127.0.0.1:${new URL(session.cdpEndpoint).port}`).href,
        {},
        this.request,
      );
      return true;
    } catch {
      return false;
    }
  }
  async activeSessions() {
    const out: BrowserSession[] = [];
    for (const s of this.sessions.values()) if (await this.status(s.profileId)) out.push(s);
    return out;
  }
}
export class MockBrowserProvider implements BrowserProvider {
  sessions = new Map<string, BrowserSession>();
  async listProfiles() {
    return Array.from({ length: 10 }, (_, i) => ({
      id: `demo-${i + 1}`,
      name: `Тестовый профиль ${i + 1}`,
    }));
  }
  async start(id: string) {
    const s = { profileId: id, cdpEndpoint: 'mock://demo' };
    this.sessions.set(id, s);
    return s;
  }
  async stop(id: string) {
    this.sessions.delete(id);
  }
  async status(id: string) {
    return this.sessions.has(id);
  }
  async activeSessions() {
    return [...this.sessions.values()];
  }
}
