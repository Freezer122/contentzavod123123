import { describe, it, expect } from 'vitest';
import { fixture } from './helpers.js';
import { base } from '../src/db/database.js';
import { Analytics, viewsFor, milestone, ratio, median } from '../src/analytics/service.js';
import { Tracking } from '../src/tracking/service.js';
import type { Post, PostMetric } from '../src/core/domain.js';
const post = {
  ...base(),
  jobId: 'job',
  accountId: 'account',
  generatedId: 'g',
  url: 'url',
  externalId: null,
  publishedAt: new Date('2026-01-01T00:00:00Z'),
} satisfies Post;
const snap = (hours: number, views: number | null): PostMetric => ({
  ...base(),
  postId: post.id,
  measuredAt: new Date(post.publishedAt.getTime() + hours * 3600000),
  targetHours: hours,
  source: 'test',
  status: 'ok',
  views,
  likes: null,
  replies: null,
  reposts: null,
  quotes: null,
});
describe('Аналитика без повторного подсчёта', () => {
  it('берёт последний снимок вместо суммы накопительных просмотров', () => {
    expect(
      viewsFor(post, [snap(1, 100), snap(24, 300)], {
        since: new Date(0),
        until: new Date('2026-01-03'),
        mode: 'PUBLISHED_IN_PERIOD',
      }),
    ).toBe(300);
  });
  it('разделяет накопительные просмотры и прирост за период', () => {
    expect(
      viewsFor(post, [snap(1, 100), snap(24, 300)], {
        since: new Date('2026-01-01T02:00:00Z'),
        until: new Date('2026-01-03'),
        mode: 'VIEWS_IN_PERIOD',
      }),
    ).toBe(200);
  });
  it('не выдаёт отсутствие базового замера старого поста за нулевой baseline', () => {
    expect(
      viewsFor(post, [snap(24, 300)], {
        since: new Date('2026-01-01T02:00:00Z'),
        until: new Date('2026-01-03'),
        mode: 'VIEWS_IN_PERIOD',
      }),
    ).toBeNull();
  });
  it('поздний замер не является результатом первого часа', () => {
    expect(milestone(post, [{ ...snap(5, 300), targetHours: 1 }], 1)).toBeNull();
  });
  it('NULL сохраняется, деление на ноль не выполняется', () => {
    expect(
      viewsFor(post, [snap(1, null)], {
        since: new Date(0),
        until: new Date(),
        mode: 'PUBLISHED_IN_PERIOD',
      }),
    ).toBeNull();
    expect(ratio(1, 0)).toBeNull();
    expect(ratio(1650, 1245000)).toBeCloseTo(0.13253);
    expect(median([1, 9, 2, 4])).toBe(3);
  });
  it('атрибутирует только подтверждённые приглашения и дедуплицирует update', async () => {
    const f = await fixture(),
      t = new Tracking(f.db, 'secret');
    const link = await t.create(f.account.id, 'https://t.me/+invite');
    await f.db.insert('invite', {
      ...base(),
      accountId: f.account.id,
      linkId: link.id,
      inviteUrl: 'https://t.me/+invite',
      channelId: '-100',
    });
    const event = {
      eventKey: 'u1',
      channelId: '-100',
      userId: '123',
      kind: 'JOIN' as const,
      inviteUrl: 'https://t.me/+invite',
      occurredAt: new Date(),
    };
    await t.membership(event);
    await t.membership(event);
    await t.membership({ ...event, eventKey: 'u2', userId: '456', inviteUrl: undefined });
    expect(await f.db.list('conversion')).toHaveLength(1);
    expect(await f.db.list('membership')).toHaveLength(2);
    expect(JSON.stringify(await f.db.list('membership'))).not.toContain('"123"');
    const r = await new Analytics(f.db).report({
      since: new Date(0),
      until: new Date(),
      mode: 'PUBLISHED_IN_PERIOD',
    });
    expect(r.joins).toBe(1);
    expect(r.unknownJoins).toBe(1);
  });
  it('не показывает ноль вступлений, если Telegram-аналитика не подключена', async () => {
    const { db } = await fixture();
    const r = await new Analytics(db, false).report({
      since: new Date(0),
      until: new Date(),
      mode: 'PUBLISHED_IN_PERIOD',
    });
    expect(r.telegramStatus).toBe('UNAVAILABLE');
    expect(r.joins).toBeNull();
    expect(r.crView).toBeNull();
    expect(r.observedLeaves).toBeNull();
  });
  it('считает все и уникальные клики без хранения IP', async () => {
    const f = await fixture(),
      t = new Tracking(f.db, 'secret'),
      l = await t.create(f.account.id, 'https://t.me/test');
    await t.click(l.code, '192.0.2.1', 'UA');
    await t.click(l.code, '192.0.2.1', 'UA');
    const r = await new Analytics(f.db).report({
      since: new Date(0),
      until: new Date(),
      mode: 'PUBLISHED_IN_PERIOD',
    });
    expect(r.clicks).toBe(2);
    expect(r.uniqueClicks).toBe(1);
    expect(JSON.stringify(await f.db.list('click'))).not.toContain('192.0.2.1');
    await expect(t.create(f.account.id, 'https://evil.test')).rejects.toMatchObject({
      code: 'INVALID_DESTINATION',
    });
  });
});
