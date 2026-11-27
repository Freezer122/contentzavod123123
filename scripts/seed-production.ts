import 'dotenv/config';
import { PrismaDatabase, base } from '../src/db/database.js';
import { seedStyles } from '../src/db/seed.js';
import { TemplateService } from '../src/content/templates.js';

const db = PrismaDatabase.connect(process.env.DATABASE_URL!);
try {
  await seedStyles(db);
  const templates = new TemplateService(db);
  await templates.seed();
  await db.transaction(async (tx) => {
    if (!(await tx.get('browserProfile', 'threads02-profile')))
      await tx.insert('browserProfile', {
        ...base('threads02-profile'),
        provider: 'ADSPOWER',
        externalId: 'k1j71gt4',
        name: 'Threads 02',
      });
    if (!(await tx.get('account', 'threads02')))
      await tx.insert('account', {
        ...base('threads02'),
        username: 'beh4ppy01',
        profileUrl: 'https://www.threads.com/@beh4ppy01',
        name: 'Threads 02',
        profileId: 'threads02-profile',
        styleId: 'style-1',
        status: 'PAUSED',
        autoApprove: false,
        followers: null,
        lastPublishedAt: null,
        ctaId: null,
        insightsUserId: null,
      });
    if (!(await tx.get('cta', 'threads02-cta')))
      await tx.insert('cta', {
        ...base('threads02-cta'),
        accountId: 'threads02',
        name: 'CTA awaiting approval',
        text: 'Требуется отдельное подтверждение CTA.',
        url: 'https://example.invalid/not-approved',
        enabled: false,
        version: 1,
        updatedAt: new Date(),
      });
    await tx.update('account', 'threads02', { ctaId: 'threads02-cta' });
    if (!(await tx.get('setting', 'factoryPaused')))
      await tx.insert('setting', { ...base('factoryPaused'), value: 'true' });
  });
  await templates.ensureOwnStyle('threads02');
  console.log(
    JSON.stringify({
      seeded: true,
      account: 'Threads 02',
      accountStatus: (await db.get('account', 'threads02'))?.status,
      factoryPaused: (await db.get('setting', 'factoryPaused'))?.value,
      publishJobs: (await db.list('publishJob')).length,
    }),
  );
} finally {
  await db.close();
}
