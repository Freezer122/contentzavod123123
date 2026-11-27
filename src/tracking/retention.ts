import { createHash, createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { Api } from 'grammy';
import type { Database } from '../db/database.js';
import { base } from '../db/database.js';
import type { MemberCohort } from '../core/domain.js';
import { withProfileLease } from '../scheduler/lease.js';
import { ratio } from '../analytics/service.js';
export function encryptMember(userId: string, secret: string, context: string) {
  const key = createHash('sha256')
      .update('content-factory-member-v1:' + secret)
      .digest(),
    iv = randomBytes(12),
    cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(context));
  return [iv, Buffer.concat([cipher.update(userId, 'utf8'), cipher.final()]), cipher.getAuthTag()]
    .map((x) => x.toString('base64url'))
    .join('.');
}
export function decryptMember(value: string, secret: string, context: string) {
  const [iv, data, tag] = value.split('.').map((s) => Buffer.from(s, 'base64url'));
  if (!iv || !data || !tag) throw new Error('Повреждена зашифрованная запись участника');
  const decipher = createDecipheriv(
    'aes-256-gcm',
    createHash('sha256')
      .update('content-factory-member-v1:' + secret)
      .digest(),
    iv,
  );
  decipher.setAAD(Buffer.from(context));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}
export async function rebuildCohorts(db: Database, channelId: string, userHash: string) {
  const events = (await db.list('membership', { channelId, userHash })).sort(
    (a, b) =>
      a.occurredAt.getTime() - b.occurredAt.getTime() ||
      a.eventKey.localeCompare(b.eventKey, undefined, { numeric: true }),
  );
  let current: MemberCohort | null = null;
  for (const event of events) {
    if (event.kind === 'JOIN') {
      if (current) {
        await db.update('memberCohort', current.id, {
          leftAt: event.occurredAt,
          exitConfirmed: false,
        });
        current = null;
      }
      const invite = event.inviteId ? await db.get('invite', event.inviteId) : null;
      const id = `cohort-${event.id}`,
        existing = await db.get('memberCohort', id);
      const fields = {
        joinEventId: event.id,
        channelId,
        userHash,
        accountId: invite?.accountId ?? null,
        joinedAt: event.occurredAt,
        leftAt: null,
        exitConfirmed: false,
      };
      current = existing
        ? await db.update('memberCohort', id, fields)
        : await db.insert('memberCohort', {
            ...base(id),
            ...fields,
            d7Member: null,
            d7MeasuredAt: null,
            d7Status: 'PENDING',
            d30Member: null,
            d30MeasuredAt: null,
            d30Status: 'PENDING',
          });
    } else if (current) {
      const patch: Partial<MemberCohort> = { leftAt: event.occurredAt, exitConfirmed: true };
      for (const day of [7, 30] as const)
        if (event.occurredAt.getTime() <= current.joinedAt.getTime() + day * 86400000) {
          if (day === 7)
            Object.assign(patch, {
              d7Member: false,
              d7MeasuredAt: event.occurredAt,
              d7Status: 'EVENTS',
            });
          else
            Object.assign(patch, {
              d30Member: false,
              d30MeasuredAt: event.occurredAt,
              d30Status: 'EVENTS',
            });
        }
      await db.update('memberCohort', current.id, patch);
      current = null;
    }
  }
}
export type CheckMember = (channelId: string, userId: string) => Promise<boolean | null>;
export function telegramMembershipChecker(token: string): CheckMember {
  return async (channelId, userId) => {
    if (!token) return null;
    try {
      const m = await new Api(token, { timeoutSeconds: 15 }).getChatMember(
        channelId,
        Number(userId),
      );
      return (
        ['member', 'administrator', 'creator'].includes(m.status) ||
        (m.status === 'restricted' && m.is_member)
      );
    } catch {
      return null;
    }
  };
}
export class Retention {
  private timer?: NodeJS.Timeout;
  private working = false;
  constructor(
    private db: Database,
    private secret: string,
    private check: CheckMember = async () => null,
    private now: () => number = Date.now,
  ) {}
  async tick() {
    if (this.working) return;
    this.working = true;
    try {
      await withProfileLease(this.db, 'retention-collector', async () => {
        let checks = 0;
        for (const cohort of await this.db.list('memberCohort')) {
          for (const day of [7, 30] as const) {
            const field = day === 7 ? 'd7Member' : 'd30Member',
              measured = day === 7 ? 'd7MeasuredAt' : 'd30MeasuredAt',
              status = day === 7 ? 'd7Status' : 'd30Status';
            const due = cohort.joinedAt.getTime() + day * 86400000,
              now = this.now();
            if (now < due || ['CONFIRMED', 'EVENTS', 'LATE'].includes(cohort[status])) continue;
            if (cohort[measured] && now - cohort[measured]!.getTime() < 10 * 60000) continue;
            if (cohort.leftAt && cohort.exitConfirmed && cohort.leftAt.getTime() <= due) {
              await this.db.update('memberCohort', cohort.id, {
                [field]: false,
                [measured]: cohort.leftAt,
                [status]: 'EVENTS',
              });
              continue;
            }
            if (checks >= 50) return;
            const identity = (
              await this.db.list('memberIdentity', {
                channelId: cohort.channelId,
                userHash: cohort.userHash,
              })
            )[0];
            let member: boolean | null = null;
            if (identity) {
              checks++;
              try {
                member = await this.check(
                  cohort.channelId,
                  decryptMember(
                    identity.encryptedUserId,
                    this.secret,
                    `${cohort.channelId}|${cohort.userHash}`,
                  ),
                );
              } catch {
                member = null;
              }
            }
            const measuredNow = this.now(),
              late = measuredNow - due > 3600000;
            await this.db.transaction(async (tx) => {
              const fresh = await tx.get('memberCohort', cohort.id);
              if (!fresh) return;
              if (fresh.leftAt && fresh.exitConfirmed && fresh.leftAt.getTime() <= due) {
                await tx.update('memberCohort', cohort.id, {
                  [field]: false,
                  [measured]: fresh.leftAt,
                  [status]: 'EVENTS',
                });
                return;
              }
              // A later rejoin never proves that the earlier episode survived its milestone.
              const broken = Boolean(fresh.leftAt && fresh.leftAt.getTime() <= measuredNow);
              await tx.update('memberCohort', cohort.id, {
                [field]: !late && !broken ? member : null,
                [measured]: new Date(measuredNow),
                [status]: late
                  ? 'LATE'
                  : !identity
                    ? 'NO_ID'
                    : member === null || broken
                      ? 'UNAVAILABLE'
                      : 'CONFIRMED',
              });
              if (member === false && !fresh.leftAt) {
                const eventKey = `membership-check-${cohort.id}-${day}`;
                if (!(await tx.list('membership', { eventKey })).length)
                  await tx.insert('membership', {
                    ...base(),
                    eventKey,
                    channelId: cohort.channelId,
                    userHash: cohort.userHash,
                    kind: 'LEAVE',
                    inviteId: null,
                    occurredAt: new Date(measuredNow),
                    origin: 'BOT_API',
                  });
                await rebuildCohorts(tx, cohort.channelId, cohort.userHash);
              }
            });
          }
        }
      });
    } catch (e) {
      if ((e as { code?: string }).code !== 'PROFILE_BUSY') throw e;
    } finally {
      this.working = false;
    }
  }
  async report(since = new Date(0), until = new Date(this.now()), accountId?: string) {
    const all = (await this.db.list('memberCohort')).filter(
        (c) => c.joinedAt >= since && c.joinedAt <= until,
      ),
      cohorts = all.filter((c) => !accountId || c.accountId === accountId);
    const milestone = (day: 7 | 30) => {
      const eligible = cohorts.filter(
          (c) => c.joinedAt.getTime() + day * 86400000 <= until.getTime(),
        ),
        field = day === 7 ? 'd7Member' : 'd30Member';
      const known = eligible.filter((c) => c[field] !== null),
        retained = known.filter((c) => c[field] === true).length,
        churned = known.filter((c) => c[field] === false).length,
        unknown = eligible.length - known.length;
      return {
        eligible: eligible.length,
        assessed: known.length,
        retained,
        churned,
        unknown,
        retention: unknown ? null : ratio(retained, eligible.length),
        churn: unknown ? null : ratio(churned, eligible.length),
        retentionAmongAssessed: ratio(retained, known.length),
      };
    };
    return {
      attribution: 'ACCOUNT_ONLY',
      joins: cohorts.length,
      uniqueMembers: new Set(cohorts.map((c) => c.userHash)).size,
      confirmedExits: cohorts.filter((c) => c.leftAt && c.exitConfirmed && c.leftAt <= until)
        .length,
      unknownSource: accountId ? null : all.filter((c) => !c.accountId).length,
      d7: milestone(7),
      d30: milestone(30),
      cohorts,
    };
  }
  async start() {
    await this.tick();
    this.timer = setInterval(() => {
      void this.tick().catch((e) => console.error('Когорты Telegram:', e.message));
    }, 60000);
  }
  async close() {
    if (this.timer) clearInterval(this.timer);
    while (this.working) await new Promise((r) => setTimeout(r, 20));
  }
}
