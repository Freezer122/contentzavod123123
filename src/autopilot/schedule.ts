import { hashDocument } from '../db/documents.js';
export function localTime(at: number, timezone: string) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(at)
      .map((x) => [x.type, x.value]),
  );
  return { day: `${p.year}-${p.month}-${p.day}`, minute: Number(p.hour) * 60 + Number(p.minute) };
}
export const minutes = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3));
export function zonedMinute(day: string, minute: number, timezone: string) {
  const utc = Date.parse(`${day}T00:00:00Z`) + minute * 60000;
  let t = utc;
  for (let i = 0; i < 4; i++) {
    const p = localTime(t, timezone),
      wall = Date.parse(`${p.day}T00:00:00Z`) + p.minute * 60000;
    t += utc - wall;
  }
  const p = localTime(t, timezone);
  if (p.day !== day || p.minute !== minute)
    throw new RangeError('Время отсутствует в этом часовом поясе');
  return t;
}
export interface DaySlot {
  id: string;
  kind: 'POST' | 'REPLY';
  at: string;
}
export function dailySlots(
  accountId: string,
  day: string,
  c: {
    timezone: string;
    start: string;
    end: string;
    posts: number;
    replies: number;
    postIntervalMinutes: number;
    replyIntervalMinutes: number;
  },
) {
  const slots: DaySlot[] = [],
    a = minutes(c.start),
    b = minutes(c.end);
  for (const kind of ['POST', 'REPLY'] as const) {
    const n = kind === 'POST' ? c.posts : c.replies,
      interval = kind === 'POST' ? c.postIntervalMinutes : c.replyIntervalMinutes;
    for (let i = 0; i < n; i++) {
      const gap = (b - a) / n,
        seed = parseInt(hashDocument({ accountId, day, kind, i }).slice(0, 6), 16) / 0xffffff;
      // Each slot has its own bounded spread; never shorten the configured minimum interval.
      const minute = Math.round(a + gap * (i + 0.25) + Math.min(4, gap * 0.08) * seed);
      if (minute >= b) continue;
      const previous = slots.filter((s) => s.kind === kind).at(-1),
        at = zonedMinute(day, minute, c.timezone);
      if (previous && at - Date.parse(previous.at) < interval * 60000) continue;
      slots.push({ id: `${day}-${kind}-${i}`, kind, at: new Date(at).toISOString() });
    }
  }
  return slots.sort((x, y) => x.at.localeCompare(y.at));
}

export type SlotStatus =
  | 'PLANNED'
  | 'PREPARING'
  | 'READY'
  | 'PUBLISHING'
  | 'PUBLISHED'
  | 'SKIPPED'
  | 'FAILED'
  | 'UNCERTAIN';
export interface PublicationSlot extends DaySlot {
  accountId: string;
  scheduleId: string;
  localDate: string;
  plannedAtUtc: string;
  timezone: string;
  type: 'POST' | 'REPLY';
  status: SlotStatus;
  prepareNow?: boolean;
  contentJobId?: string;
  publishingJobId?: string;
  publishedAt?: string;
  permalink?: string;
  failureReason?: string;
  attempts: number;
  attemptIds: string[];
  workId?: string;
  skipped?: string;
  previewAt?: string;
  notifiedAt?: string;
}
export interface PublicationPlan {
  accountId: string;
  epoch: number;
  day: string;
  schemaVersion: 117;
  slots: PublicationSlot[];
  createdAt: string;
}
export const nextDay = (day: string) =>
  new Date(Date.parse(day + 'T12:00:00Z') + 86400000).toISOString().slice(0, 10);
/** Stable slots are reserved once, before generation. No late catch-up or random tick-time shifts. */
export function remainingSlots(
  accountId: string,
  epoch: number,
  day: string,
  c: Parameters<typeof dailySlots>[2],
  at: number,
  used: { posts: number; replies: number; lastPost?: number; lastReply?: number } = {
    posts: 0,
    replies: 0,
  },
): PublicationSlot[] {
  const out: PublicationSlot[] = [],
    start = zonedMinute(day, minutes(c.start), c.timezone),
    end = zonedMinute(day, minutes(c.end), c.timezone);
  for (const kind of ['POST', 'REPLY'] as const) {
    const gap = (kind === 'POST' ? c.postIntervalMinutes : c.replyIntervalMinutes) * 60000,
      first = Math.max(
        start,
        at + (kind === 'POST' ? 10 : 2) * 60000,
        (kind === 'POST' ? (used.lastPost ?? 0) : (used.lastReply ?? 0)) + gap,
      );
    const target = Math.max(
      0,
      (kind === 'POST' ? c.posts : c.replies) - (kind === 'POST' ? used.posts : used.replies),
    );
    const n = Math.min(target, Math.max(0, Math.floor((end - 60000 - first) / gap) + 1));
    const step =
      n > 1 ? Math.max(gap, Math.floor((end - 60000 - first) / (n - 1) / 60000) * 60000) : gap;
    for (let i = 0; i < n; i++) {
      const stamp = new Date(Math.ceil((first + i * step) / 60000) * 60000).toISOString(),
        id = hashDocument({ accountId, epoch, day, kind, i, stamp }).slice(0, 22);
      out.push({
        id,
        kind,
        at: stamp,
        accountId,
        scheduleId: `autopilot-plan-${accountId}-${epoch}-${day}`,
        localDate: day,
        plannedAtUtc: stamp,
        timezone: c.timezone,
        type: kind,
        status: 'PLANNED',
        attempts: 0,
        attemptIds: [],
      });
    }
  }
  return out.sort((a, b) => a.at.localeCompare(b.at));
}
