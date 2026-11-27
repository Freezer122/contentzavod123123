import { TemplateService } from '../content/templates.js';
import type { Database } from './database.js';
import { base } from './database.js';
import { CtaService } from '../cta/service.js';
import type { Config } from '../core/config.js';
import { rebuildCohorts } from '../tracking/retention.js';
export async function upgradeV11(db: Database, config: Config) {
  const ctas = new CtaService(db, config.PUBLIC_BASE_URL, config.TELEGRAM_TARGET);
  for (const account of await db.list('account')) await ctas.ensure(account.id);
  if (await db.get('setting', 'v11Upgraded')) return;
  await db.transaction(async (tx) => {
    for (const account of await tx.list('account')) {
      const invites = (await tx.list('invite', { accountId: account.id })).sort(
        (a, b) => a.createdAt.getTime() - b.createdAt.getTime(),
      );
      for (let i = 0; i < invites.length; i++)
        await tx.update('invite', invites[i]!.id, { active: i === 0 });
      if (invites[0]) {
        const link = (await tx.list('trackingLink', { accountId: account.id })).find(
          (l) => l.permanent,
        );
        if (link) await tx.update('trackingLink', link.id, { destination: invites[0].inviteUrl });
      }
    }
    const users = new Map<string, { channelId: string; userHash: string }>();
    for (const e of await tx.list('membership')) users.set(`${e.channelId}|${e.userHash}`, e);
    for (const user of users.values()) await rebuildCohorts(tx, user.channelId, user.userHash);
    await tx.insert('setting', { ...base('v11Upgraded'), value: 'true' });
  });
}

export async function upgradePrelaunch(db: Database) {
  const templates = new TemplateService(db);
  await templates.seed();
  for (const account of await db.list('account')) await templates.ensureOwnStyle(account.id);
  if (await db.get('setting', 'prelaunchUpgraded')) return;
  await db.transaction(async (tx) => {
    for (const job of await tx.list('publishJob'))
      if (
        !job.ctaCapturedAt &&
        (job.startedAt ||
          job.postStatus !== 'PENDING' ||
          ['COMPLETED', 'CANCELLED', 'NEEDS_REVIEW', 'FAILED'].includes(job.status))
      )
        await tx.update('publishJob', job.id, {
          ctaCapturedAt: job.startedAt ?? job.createdAt,
          ctaEnabled: job.commentStatus !== 'DISABLED',
        });
    await tx.insert('setting', { ...base('prelaunchUpgraded'), value: 'true' });
  });
}
