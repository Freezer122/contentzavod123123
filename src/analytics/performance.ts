import type { ContentPerformance } from '../core/domain.js';
import type { Database } from '../db/database.js';
import { base, audit } from '../db/database.js';
import { contentFeatures } from '../content/features.js';
import { milestone, median, ratio, change } from './service.js';
import { assert } from '../core/errors.js';
export const RATING_HORIZONS = [1, 6, 24, 72, 168] as const;
export class PerformanceRating {
  constructor(private db: Database) {}
  async describe(postId: string) {
    const existing = (await this.db.list('contentPerformance', { postId }))[0];
    if (existing) return existing;
    const post = await this.db.get('post', postId);
    assert(post, 'NOT_FOUND', 'Пост не найден');
    const g = await this.db.get('generated', post.generatedId),
      source = g ? await this.db.get('source', g.sourceId) : null;
    assert(g && source, 'NOT_FOUND', 'Материал не найден');
    return this.db.transaction(async (tx) => {
      const current = (await tx.list('contentPerformance', { postId }))[0];
      if (current) return current;
      return tx.insert('contentPerformance', {
        ...base(`performance-${postId}`),
        postId,
        sourceText: source.text,
        finalText: g.text,
        templateId: g.templateId ?? null,
        templateSnapshot: g.templateSnapshot ?? null,
        ...contentFeatures(g.text, source),
      });
    });
  }
  async tagSource(
    sourceId: string,
    patch: { topic?: string; format?: string; hook?: string },
    actor: string,
  ) {
    return this.db.transaction(async (tx) => {
      await audit(tx, actor, 'TAG_SOURCE', sourceId, JSON.stringify(patch));
      return tx.update('source', sourceId, patch);
    });
  }
  async report(horizon: number = 24, accountId?: string, now = new Date()) {
    assert(
      RATING_HORIZONS.includes(horizon as any),
      'INVALID_HORIZON',
      'Выберите возраст 1, 6, 24, 72 или 168 часов',
    );
    const posts = await this.db.list('post', accountId ? { accountId } : {}),
      metrics = await this.db.list('postMetric'),
      followers = await this.db.list('accountMetric'),
      links = await this.db.list('trackingLink'),
      clicks = await this.db.list('click'),
      joins = await this.db.list('conversion'),
      templates = await this.db.list('contentTemplate');
    const rows: Array<
      ContentPerformance & {
        accountId: string;
        url: string;
        publishedAt: Date;
        ageHours: number;
        viewsByHour: Record<number, number | null>;
        latestViews: number | null;
        comparisonHours: number;
        comparisonViews: number | null;
        comparisonMeasuredAt: Date | null;
        likes: number | null;
        replies: number | null;
        reposts: number | null;
        quotes: number | null;
        engagementRate: number | null;
        followersGrowth: number | null;
        followersMeasuredFrom: Date | null;
        followersMeasuredTo: Date | null;
        postClicks: null;
        postJoins: null;
        accountContext: { attribution: string; clicks: number; joins: number };
      }
    > = [];
    for (const post of posts) {
      const feature = await this.describe(post.id),
        snapshots = metrics.filter((m) => m.postId === post.id && m.measuredAt <= now),
        comp = milestone(post, snapshots, horizon),
        end = new Date(post.publishedAt.getTime() + horizon * 3600000);
      const fs = followers
          .filter((f) => f.accountId === post.accountId)
          .sort((a, b) => a.measuredAt.getTime() - b.measuredAt.getTime()),
        startF = fs.filter((f) => f.measuredAt <= post.publishedAt).at(-1),
        endF = fs.filter((f) => f.measuredAt <= end && f.measuredAt <= now).at(-1);
      const interactions =
        comp && [comp.likes, comp.replies, comp.reposts, comp.quotes].every((x) => x !== null)
          ? comp.likes! + comp.replies! + comp.reposts! + comp.quotes!
          : null;
      const accountLinks = new Set(
        links.filter((l) => l.accountId === post.accountId).map((l) => l.id),
      );
      rows.push({
        ...feature,
        accountId: post.accountId,
        url: post.url,
        publishedAt: post.publishedAt,
        ageHours: (now.getTime() - post.publishedAt.getTime()) / 3600000,
        viewsByHour: Object.fromEntries(
          RATING_HORIZONS.map((h) => [h, milestone(post, snapshots, h)?.views ?? null]),
        ),
        latestViews:
          [...snapshots].sort((a, b) => b.measuredAt.getTime() - a.measuredAt.getTime())[0]
            ?.views ?? null,
        comparisonHours: horizon,
        comparisonViews: comp?.views ?? null,
        comparisonMeasuredAt: comp?.measuredAt ?? null,
        likes: comp?.likes ?? null,
        replies: comp?.replies ?? null,
        reposts: comp?.reposts ?? null,
        quotes: comp?.quotes ?? null,
        engagementRate: ratio(interactions, comp?.views ?? null),
        followersGrowth:
          startF?.followers != null &&
          endF?.followers != null &&
          endF.measuredAt > startF.measuredAt
            ? endF.followers - startF.followers
            : null,
        followersMeasuredFrom: startF?.measuredAt ?? null,
        followersMeasuredTo: endF?.measuredAt ?? null,
        postClicks: null,
        postJoins: null,
        accountContext: {
          attribution: 'ACCOUNT_ONLY',
          clicks: clicks.filter(
            (c) =>
              accountLinks.has(c.linkId) &&
              c.createdAt >= post.publishedAt &&
              c.createdAt <= end &&
              c.createdAt <= now,
          ).length,
          joins: joins.filter(
            (c) =>
              c.accountId === post.accountId &&
              c.createdAt >= post.publishedAt &&
              c.createdAt <= end &&
              c.createdAt <= now,
          ).length,
        },
      });
    }
    const comparable = rows.filter((r) => r.ageHours >= horizon && r.comparisonViews !== null);
    const categories = (field: 'topic' | 'format') =>
      [...new Set(comparable.map((r) => r[field]))]
        .map((name) => {
          const values = comparable.filter((r) => r[field] === name).map((r) => r.comparisonViews!);
          return {
            name,
            posts: values.length,
            average: values.reduce((a, b) => a + b, 0) / values.length,
            median: median(values),
            total: values.reduce((a, b) => a + b, 0),
            comparisonHours: horizon,
          };
        })
        .sort((a, b) => b.average - a.average);
    const templateVersion = (row: ContentPerformance) => {
      try {
        return JSON.parse(row.templateSnapshot ?? '{}').version ?? null;
      } catch {
        return null;
      }
    };
    const templateStats = templates.map((template) => {
      const all = rows.filter((r) => r.templateId === template.id),
        current = all.filter((r) => templateVersion(r) === template.version),
        values = comparable
          .filter((r) => r.templateId === template.id && templateVersion(r) === template.version)
          .map((r) => r.comparisonViews!);
      const versions = [
        ...new Set(
          all.map((r) => {
            try {
              return JSON.parse(r.templateSnapshot ?? '{}').version ?? null;
            } catch {
              return null;
            }
          }),
        ),
      ];
      return {
        id: template.id,
        name: template.name,
        version: template.version,
        observedVersions: versions,
        publishedPosts: current.length,
        totalPublishedPosts: all.length,
        measuredPosts: values.length,
        comparisonHours: horizon,
        rankEligible: values.length >= 10,
        average: values.length ? values.reduce((a, b) => a + b, 0) / values.length : null,
        median: median(values),
        max: values.length ? Math.max(...values) : null,
        min: values.length ? Math.min(...values) : null,
      };
    });
    const values = comparable.map((r) => r.comparisonViews!);
    const periodSummary = (from: number, to: number) => {
      const vs = comparable
        .filter((r) => r.publishedAt.getTime() >= from && r.publishedAt.getTime() < to)
        .map((r) => r.comparisonViews!);
      return {
        posts: vs.length,
        views: vs.length ? vs.reduce((a, b) => a + b, 0) : null,
        average: vs.length ? vs.reduce((a, b) => a + b, 0) / vs.length : null,
        median: median(vs),
      };
    };
    const current = periodSummary(now.getTime() - 7 * 86400000, now.getTime() + 1),
      previous = periodSummary(now.getTime() - 14 * 86400000, now.getTime() - 7 * 86400000);
    return {
      templateStats,
      templates: templateStats
        .filter((t) => t.rankEligible)
        .sort((a, b) => b.average! - a.average!),
      minimumTemplateSample: 10,
      bottomByViews: [...comparable]
        .sort((a, b) => a.comparisonViews! - b.comparisonViews!)
        .slice(0, 10),
      summary: {
        posts: values.length,
        average: values.length ? values.reduce((a, b) => a + b, 0) / values.length : null,
        median: median(values),
        max: values.length ? Math.max(...values) : null,
        min: values.length ? Math.min(...values) : null,
      },
      dynamics: {
        current,
        previous,
        changes: {
          posts: change(current.posts, previous.posts),
          views: change(current.views, previous.views),
          average: change(current.average, previous.average),
          median: change(current.median, previous.median),
        },
      },
      comparisonHours: horizon,
      attribution: 'ACCOUNT_ONLY',
      rows,
      topByViews: [...comparable]
        .sort((a, b) => b.comparisonViews! - a.comparisonViews!)
        .slice(0, 10),
      topBy24: rows
        .filter((r) => r.ageHours >= 24 && r.viewsByHour[24] !== null)
        .sort((a, b) => b.viewsByHour[24]! - a.viewsByHour[24]!)
        .slice(0, 10),
      topics: categories('topic'),
      formats: categories('format'),
      excluded: rows.length - comparable.length,
    };
  }
}
