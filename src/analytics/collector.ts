import type { Database } from '../db/database.js';
import { base } from '../db/database.js';
import type { Config } from '../core/config.js';
import type { Post, PostMetric, Account } from '../core/domain.js';
import { withProfileLease } from '../scheduler/lease.js';
export type MetricValues = Pick<
  PostMetric,
  'views' | 'likes' | 'replies' | 'reposts' | 'quotes' | 'source' | 'status'
>;
export interface Insights {
  post(post: Post, account: Account): Promise<MetricValues>;
  followers(account: Account): Promise<number | null>;
}
const missing: MetricValues = {
  views: null,
  likes: null,
  replies: null,
  reposts: null,
  quotes: null,
  source: 'INSIGHTS_UNAVAILABLE',
  status: 'UNAVAILABLE',
};
export class OfficialInsights implements Insights {
  constructor(
    private config: Config,
    private db: Database,
  ) {}
  private async get(path: string, params: Record<string, string>) {
    const u = new URL(this.config.INSIGHTS_BASE_URL.replace(/\/$/, '') + '/' + path);
    Object.entries(params).forEach(([k, v]) => u.searchParams.set(k, v));
    const res = await fetch(u, {
      headers: { Authorization: `Bearer ${this.config.INSIGHTS_ACCESS_TOKEN}` },
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) return null;
    return res.json() as Promise<any>;
  }
  async post(post: Post, account: Account): Promise<MetricValues> {
    if (!this.config.INSIGHTS_ACCESS_TOKEN) return missing;
    let id = post.externalId;
    if (!id && account.insightsUserId) {
      // Resolve the numeric API ID by matching the permalink of this account's own posts.
      let after: string | undefined;
      for (let page = 0; page < 20; page++) {
        const d = await this.get(`${encodeURIComponent(account.insightsUserId)}/threads`, {
          fields: 'id,permalink',
          limit: '100',
          ...(after ? { after } : {}),
        });
        if (!d) break;
        const found = d.data?.find(
          (p: any) => p.permalink?.replace(/\/$/, '') === post.url.replace(/\/$/, ''),
        );
        if (found?.id) {
          id = String(found.id);
          await this.db.update('post', post.id, { externalId: id });
          break;
        }
        after = d.paging?.cursors?.after;
        if (!d.paging?.next || !after) break;
      }
    }
    if (!id) return { ...missing, status: 'API_ID_REQUIRED' };
    const d = await this.get(`${encodeURIComponent(id)}/insights`, {
      metric: 'views,likes,replies,reposts,quotes',
    });
    if (!d) return missing;
    const value = (name: string) => {
      const v = d.data?.find((x: any) => x.name === name)?.values?.[0]?.value;
      return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null;
    };
    return {
      views: value('views'),
      likes: value('likes'),
      replies: value('replies'),
      reposts: value('reposts'),
      quotes: value('quotes'),
      source: 'THREADS_INSIGHTS',
      status: 'AVAILABLE',
    };
  }
  async followers(account: Account) {
    if (!this.config.INSIGHTS_ACCESS_TOKEN || !account.insightsUserId) return null;
    const d = await this.get(`${encodeURIComponent(account.insightsUserId)}/threads_insights`, {
      metric: 'followers_count',
    });
    const v = d?.data?.find((x: any) => x.name === 'followers_count')?.total_value?.value;
    return typeof v === 'number' ? v : null;
  }
}
export class DemoInsights implements Insights {
  async post(post: Post): Promise<MetricValues> {
    const age = (Date.now() - post.publishedAt.getTime()) / 3600000;
    return {
      views: Math.floor(age * 73 + 100),
      likes: 12,
      replies: 2,
      reposts: 1,
      quotes: 0,
      source: 'DEMO_SYNTHETIC',
      status: 'TEST_DATA',
    };
  }
  async followers(account: Account) {
    return account.followers;
  }
}
export class AnalyticsCollector {
  private timer?: NodeJS.Timeout;
  private working = false;
  constructor(
    private db: Database,
    private adapter: Insights,
  ) {}
  async tick(force = false) {
    if (this.working) return;
    this.working = true;
    try {
      await withProfileLease(this.db, 'analytics-collector', async () => {
        for (const post of await this.db.list('post')) {
          const age = (Date.now() - post.publishedAt.getTime()) / 3600000,
            account = await this.db.get('account', post.accountId);
          if (!account) continue;
          const snapshots = await this.db.list('postMetric', { postId: post.id });
          const due = [1, 6, 24, 48, 72, 168].filter(
            (h) => age >= h && !snapshots.some((s) => s.targetHours === h),
          );
          const last = snapshots.reduce((n, s) => Math.max(n, s.measuredAt.getTime()), 0);
          const refresh = force || Date.now() - last >= (age > 720 ? 24 : 1) * 3600000;
          if (due.length || refresh) {
            let values: MetricValues;
            try {
              values = await this.adapter.post(post, account);
            } catch {
              values = missing;
            }
            const measuredAt = new Date();
            // Late milestones keep their actual timestamp. Rolling samples preserve full history.
            for (const targetHours of due)
              await this.db.insert('postMetric', {
                ...base(),
                postId: post.id,
                targetHours,
                measuredAt,
                ...values,
              });
            if (refresh && !due.length)
              await this.db.insert('postMetric', {
                ...base(),
                postId: post.id,
                targetHours: null,
                measuredAt,
                ...values,
              });
          }
        }
        for (const a of await this.db.list('account')) {
          const recent = (await this.db.list('accountMetric', { accountId: a.id })).some(
            (s) => Date.now() - s.measuredAt.getTime() < 3600000,
          );
          if (recent) continue;
          const followers = await this.adapter.followers(a).catch(() => null);
          await this.db.insert('accountMetric', {
            ...base(),
            accountId: a.id,
            followers,
            measuredAt: new Date(),
            source:
              this.adapter instanceof DemoInsights
                ? 'DEMO_SYNTHETIC'
                : followers === null
                  ? 'UNAVAILABLE'
                  : 'THREADS_INSIGHTS',
          });
          if (followers !== null) await this.db.update('account', a.id, { followers });
        }
      });
    } catch (e) {
      if ((e as { code?: string }).code !== 'PROFILE_BUSY') throw e;
    } finally {
      this.working = false;
    }
  }
  async start() {
    await this.tick();
    this.timer = setInterval(() => {
      void this.tick().catch((e) => console.error('Сбор аналитики:', e.message));
    }, 60000);
  }
  async close() {
    if (this.timer) clearInterval(this.timer);
    while (this.working) await new Promise((r) => setTimeout(r, 20));
  }
}
