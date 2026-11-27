import type { Database } from '../db/database.js';
import type { Post, PostMetric } from '../core/domain.js';
export type AnalyticsMode = 'PUBLISHED_IN_PERIOD' | 'VIEWS_IN_PERIOD';
export interface Period {
  since: Date;
  until: Date;
  accountId?: string;
  mode: AnalyticsMode;
}
export const ratio = (
  numerator: number | null,
  denominator: number | null,
  multiplier = 100,
): number | null =>
  numerator === null || denominator === null || denominator === 0
    ? null
    : (numerator / denominator) * multiplier;
export const sumKnown = (values: (number | null)[]): number | null =>
  values.some((v) => v !== null) ? values.reduce<number>((s, v) => s + (v ?? 0), 0) : null;
export function median(values: number[]): number | null {
  if (!values.length) return null;
  const a = [...values].sort((a, b) => a - b),
    m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m]! : (a[m - 1]! + a[m]!) / 2;
}
export const change = (current: number | null, previous: number | null) => ({
  absolute: current === null || previous === null ? null : current - previous,
  percent:
    current === null || previous === null || previous === 0
      ? null
      : ((current - previous) / previous) * 100,
});
function latest(snapshots: PostMetric[], until: Date) {
  return snapshots
    .filter((s) => s.measuredAt <= until)
    .sort((a, b) => b.measuredAt.getTime() - a.measuredAt.getTime())[0];
}
export function metricFor(
  post: Post,
  snapshots: PostMetric[],
  p: Period,
  key: 'views' | 'likes' | 'replies' | 'reposts' | 'quotes',
): number | null {
  const end = latest(snapshots, p.until);
  if (!end || end[key] === null) return null;
  if (p.mode === 'PUBLISHED_IN_PERIOD') return end[key];
  if (end.measuredAt <= p.since) return null;
  const start = latest(snapshots, p.since);
  if (start?.[key] !== null && start?.[key] !== undefined)
    return Math.max(0, end[key] - start[key]);
  return post.publishedAt >= p.since ? end[key] : null;
}
export const viewsFor = (post: Post, snapshots: PostMetric[], p: Period) =>
  metricFor(post, snapshots, p, 'views');
export function milestone(post: Post, snapshots: PostMetric[], hours: number): PostMetric | null {
  const snapshot = snapshots.find((s) => s.targetHours === hours);
  if (!snapshot) return null;
  const actual = (snapshot.measuredAt.getTime() - post.publishedAt.getTime()) / 3600000;
  // A late measurement remains in history, but is never labelled as the requested milestone.
  return actual >= hours && actual <= hours + (hours === 1 ? 0.25 : 1) ? snapshot : null;
}
export class Analytics {
  constructor(
    private db: Database,
    private telegramConfigured = true,
  ) {}
  async report(p: Period) {
    const allPosts = await this.db.list('post', p.accountId ? { accountId: p.accountId } : {});
    const posts = allPosts.filter(
      (x) => x.publishedAt <= p.until && (p.mode === 'VIEWS_IN_PERIOD' || x.publishedAt >= p.since),
    );
    const metrics = await this.db.list('postMetric');
    const links = await this.db.list('trackingLink', p.accountId ? { accountId: p.accountId } : {}),
      linkIds = new Set(links.map((x) => x.id));
    const clicks = (await this.db.list('click')).filter(
      (x) => linkIds.has(x.linkId) && x.createdAt >= p.since && x.createdAt <= p.until,
    );
    const conversions = (
      await this.db.list('conversion', p.accountId ? { accountId: p.accountId } : {})
    ).filter((x) => x.createdAt >= p.since && x.createdAt <= p.until);
    const members = (await this.db.list('membership')).filter(
      (x) => x.occurredAt >= p.since && x.occurredAt <= p.until,
    );
    const generated = await this.db.list('generated'),
      accounts = await this.db.list('account', p.accountId ? { id: p.accountId } : {});
    const rows = posts.map((post) => {
      const ss = metrics.filter((s) => s.postId === post.id),
        last = latest(ss, p.until),
        firstHour = milestone(post, ss, 1),
        firstDay = milestone(post, ss, 24),
        g = generated.find((x) => x.id === post.generatedId);
      const postLinks = new Set(links.filter((l) => l.postId === post.id).map((l) => l.id));
      return {
        ...post,
        account: accounts.find((a) => a.id === post.accountId)?.name ?? post.accountId,
        text: g?.text ?? '',
        sourceId: g?.sourceId ?? '',
        styleId: g?.styleId ?? '',
        views: viewsFor(post, ss, p),
        firstHourViews: firstHour?.views ?? null,
        firstDayViews: firstDay?.views ?? null,
        likes: metricFor(post, ss, p, 'likes'),
        replies: metricFor(post, ss, p, 'replies'),
        reposts: metricFor(post, ss, p, 'reposts'),
        quotes: metricFor(post, ss, p, 'quotes'),
        source: last?.source ?? 'UNAVAILABLE',
        updatedAt: last?.measuredAt ?? null,
        clicks: null,
        joins: null,
      };
    });
    const known = rows.flatMap((r) => (r.views === null ? [] : [r.views]));
    const views = sumKnown(rows.map((r) => r.views));
    const jobs = (
      await this.db.list('publishJob', p.accountId ? { accountId: p.accountId } : {})
    ).filter((j) => j.startedAt && j.startedAt >= p.since && j.startedAt <= p.until);
    const confirmedExits = (await this.db.list('memberCohort')).filter(
      (c) =>
        c.exitConfirmed &&
        c.leftAt &&
        c.leftAt >= p.since &&
        c.leftAt <= p.until &&
        (!p.accountId || c.accountId === p.accountId),
    );
    const followers = await this.db.list('accountMetric');
    const followerChanges = accounts.map((a) => {
      const ss = followers
        .filter((s) => s.accountId === a.id)
        .sort((a, b) => a.measuredAt.getTime() - b.measuredAt.getTime());
      const start = ss.filter((s) => s.measuredAt <= p.since).at(-1),
        end = ss.filter((s) => s.measuredAt <= p.until).at(-1);
      return start?.followers != null && end?.followers != null
        ? end.followers - start.followers
        : null;
    });
    const interactions = rows.map((r) =>
      [r.likes, r.replies, r.reposts, r.quotes].every((x) => x !== null)
        ? r.likes! + r.replies! + r.reposts! + r.quotes!
        : null,
    );
    const accountRanking = accounts
      .map((a) => {
        const rs = rows.filter((r) => r.accountId === a.id),
          vs = rs.flatMap((r) => (r.views === null ? [] : [r.views]));
        return {
          id: a.id,
          name: a.name,
          views: sumKnown(vs),
          average: vs.length ? vs.reduce((s, v) => s + v, 0) / vs.length : null,
          knownPosts: vs.length,
        };
      })
      .filter((a) => a.average !== null)
      .sort((a, b) => b.average! - a.average!);
    const joins = this.telegramConfigured ? conversions.length : null;
    const viewAttributedJoins = p.mode === 'VIEWS_IN_PERIOD' ? joins : null;

    return {
      mode: p.mode,
      attribution: 'ACCOUNT_ONLY',
      telegramStatus: this.telegramConfigured ? 'CONFIGURED' : 'UNAVAILABLE',
      rows,
      accountRanking,
      bestAccount: accountRanking[0] ?? null,
      worstAccount: accountRanking.at(-1) ?? null,
      accountCount: accounts.length,
      posts: posts.filter((x) => x.publishedAt >= p.since).length,
      views,
      knownPosts: known.length,
      totalCompared: rows.length,
      average: known.length ? known.reduce((a, b) => a + b, 0) / known.length : null,
      median: median(known),
      max: known.length ? Math.max(...known) : null,
      min: known.length ? Math.min(...known) : null,
      followers: sumKnown(accounts.map((a) => a.followers)),
      followerGrowth: sumKnown(followerChanges),
      clicks: clicks.length,
      uniqueClicks: new Set(clicks.map((c) => c.visitorHash)).size,
      joins,
      unknownJoins:
        p.accountId || !this.telegramConfigured
          ? null
          : members.filter((m) => m.kind === 'JOIN' && !conversions.some((c) => c.eventId === m.id))
              .length,
      observedLeaves: !this.telegramConfigured
        ? null
        : p.accountId
          ? confirmedExits.length
          : members.filter((m) => m.kind === 'LEAVE').length,
      observedNet: !this.telegramConfigured
        ? null
        : p.accountId
          ? (joins ?? 0) - confirmedExits.length
          : members.filter((m) => m.kind === 'JOIN').length -
            members.filter((m) => m.kind === 'LEAVE').length,
      viewAttributedJoins,
      crView: ratio(viewAttributedJoins, views),
      crClick: ratio(joins, clicks.length),
      joinsPer1000: ratio(viewAttributedJoins, views, 1000),
      engagementRate: interactions.every((x) => x !== null)
        ? ratio(sumKnown(interactions), views)
        : null,
      successRate: ratio(jobs.filter((j) => j.postStatus === 'PUBLISHED').length, jobs.length),
      errors: jobs.filter((j) => j.lastError).length,
    };
  }
  async ranking(p: Period, bottom = false, firstDay = false) {
    const r = await this.report(p);
    // Both entry points compare the common 24-hour milestone. Lifetime totals remain in report.rows.
    return r.rows
      .filter(
        (x) => x.firstDayViews !== null && p.until.getTime() - x.publishedAt.getTime() >= 86400000,
      )
      .map((x) => ({
        ...x,
        lifetimeOrPeriodViews: x.views,
        views: x.firstDayViews,
        comparisonHours: 24,
        comparisonViews: x.firstDayViews,
      }))
      .sort((a, b) => (bottom ? 1 : -1) * (a.comparisonViews! - b.comparisonViews!))
      .slice(0, 10);
  }

  async dynamics(accountId?: string, now = new Date()) {
    const current = await this.report({
      since: new Date(now.getTime() - 7 * 86400000),
      until: now,
      accountId,
      mode: 'VIEWS_IN_PERIOD',
    });
    const previous = await this.report({
      since: new Date(now.getTime() - 14 * 86400000),
      until: new Date(now.getTime() - 7 * 86400000),
      accountId,
      mode: 'VIEWS_IN_PERIOD',
    });
    return Object.fromEntries(
      (
        [
          'views',
          'average',
          'median',
          'followerGrowth',
          'posts',
          'clicks',
          'joins',
          'crView',
        ] as const
      ).map((k) => [k, change(current[k], previous[k])]),
    );
  }
  async sourceRanking(p: Period, group: 'sourceId' | 'styleId' = 'sourceId') {
    const { rows } = await this.report(p);
    const groups = new Map<string, typeof rows>();
    for (const r of rows) {
      const a = groups.get(r[group]) ?? [];
      a.push(r);
      groups.set(r[group], a);
    }
    const generated = await this.db.list('generated'),
      sources = await this.db.list('source'),
      styles = await this.db.list('style');
    return [...groups]
      .map(([id, rs]) => {
        const vs = rs.flatMap((r) => (r.views === null ? [] : [r.views])),
          views = sumKnown(rs.map((r) => r.views)),
          joins = null;
        return {
          id,
          label:
            group === 'sourceId'
              ? (sources.find((s) => s.id === id)?.url ??
                sources.find((s) => s.id === id)?.text.slice(0, 100) ??
                id)
              : (styles.find((s) => s.id === id)?.name ?? id),
          adaptations: generated.filter((g) => g[group] === id).length,
          published: rs.length,
          views,
          average: vs.length ? vs.reduce((s, v) => s + v, 0) / vs.length : null,
          max: vs.length ? Math.max(...vs) : null,
          min: vs.length ? Math.min(...vs) : null,
          clicks: null,
          joins,
          crView: ratio(joins, views),
        };
      })
      .sort((a, b) => (b.views ?? -1) - (a.views ?? -1));
  }
  async csv(p: Period) {
    const { rows } = await this.report(p);
    const fields = [
      'account',
      'text',
      'url',
      'publishedAt',
      'views',
      'firstHourViews',
      'firstDayViews',
      'likes',
      'replies',
      'clicks',
      'joins',
      'source',
      'updatedAt',
    ] as const;
    const escape = (value: unknown) => {
      let s = value instanceof Date ? value.toISOString() : value == null ? '' : String(value);
      if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
      return '"' + s.replaceAll('"', '""') + '"';
    };
    return (
      '\ufeff' +
      [
        fields.map(escape).join(','),
        ...rows.map((row) => fields.map((k) => escape(row[k])).join(',')),
      ].join('\r\n')
    );
  }
}
