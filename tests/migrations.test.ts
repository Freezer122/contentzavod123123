import { it, expect } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { fixture } from './helpers.js';
import { readFile } from 'node:fs/promises';
it('миграция PostgreSQL создаёт таблицы, внешние ключи и уникальность', async () => {
  const pg = new PGlite();
  try {
    await pg.exec(await readFile('prisma/migrations/202611160001_initial/migration.sql', 'utf8'));
    const f = await fixture();
    const insert = async (table: string, row: Record<string, unknown>) => {
      const fields = Object.keys(row);
      await pg.query(
        `INSERT INTO "${table}" (${fields.map((k) => '"' + k + '"').join(',')}) VALUES (${fields.map((_, i) => '$' + (i + 1)).join(',')})`,
        Object.values(row).map((v) =>
          v instanceof Date
            ? v.toISOString()
            : Array.isArray(v)
              ? '{' + v.map((s) => '"' + String(s).replaceAll('"', '\\"') + '"').join(',') + '}'
              : v,
        ),
      );
    };
    await insert(
      'account_style_profiles',
      (await f.db.get('style', 'style-1'))! as unknown as Record<string, unknown>,
    );
    await insert('browser_profiles', f.profile as unknown as Record<string, unknown>);
    await insert('cta_templates', {
      id: 'legacy-cta',
      createdAt: new Date(),
      name: 'Старый общий CTA',
      text: 'Снимок старой версии',
      enabled: true,
    });
    await insert('threads_accounts', { ...f.account, ctaId: 'legacy-cta' } as unknown as Record<
      string,
      unknown
    >);
    await insert('source_contents', f.source as unknown as Record<string, unknown>);
    await insert('generated_contents', f.generated as unknown as Record<string, unknown>);
    await insert('publishing_batches', {
      id: 'legacy-batch',
      createdAt: new Date(),
      name: 'Старая партия',
      approval: 'MANUAL_APPROVAL',
    });
    const planned = new Date('2026-12-01T12:00:00Z');
    await insert('publishing_jobs', {
      id: 'legacy-job',
      createdAt: new Date(),
      batchId: 'legacy-batch',
      accountId: f.account.id,
      generatedId: f.generated.id,
      scheduledAt: planned,
      status: 'CANCELLED',
      postStatus: 'PENDING',
      commentStatus: 'PENDING',
      ctaText: 'Снимок старой версии',
      attempts: 0,
      lastError: null,
      startedAt: null,
      updatedAt: new Date(),
      revision: 0,
    });
    await insert('tracking_links', {
      id: 'legacy-link',
      createdAt: new Date(),
      code: 'legacy-code',
      accountId: f.account.id,
      postId: null,
      ctaId: 'legacy-cta',
      destination: 'https://t.me/old',
    });
    await pg.exec(await readFile('prisma/migrations/202611170001_v11/migration.sql', 'utf8'));
    const preserved = await pg.query<{
      status: string;
      ctaText: string;
      scheduledAt: Date;
      plannedAt: Date;
    }>('SELECT "status","ctaText","scheduledAt","plannedAt" FROM "publishing_jobs" WHERE "id"=$1', [
      'legacy-job',
    ]);
    expect(preserved.rows[0]!.status).toBe('CANCELLED');
    expect(preserved.rows[0]!.ctaText).toBe('Снимок старой версии');
    expect(new Date(preserved.rows[0]!.plannedAt).toISOString()).toBe(planned.toISOString());
    expect(
      (
        await pg.query<{ code: string; permanent: boolean }>(
          'SELECT "code","permanent" FROM "tracking_links"',
        )
      ).rows[0],
    ).toMatchObject({ code: 'legacy-code', permanent: true });
    expect(
      (await pg.query('SELECT "id" FROM "cta_templates" WHERE "accountId"=$1', [f.account.id]))
        .rows,
    ).toHaveLength(1);

    await pg.exec(await readFile('prisma/migrations/202611180001_prelaunch/migration.sql', 'utf8'));
    await pg.exec(
      await readFile('prisma/migrations/202611190001_comment_media/migration.sql', 'utf8'),
    );
    await pg.exec(
      await readFile('prisma/migrations/202611190002_hotfix_v15/migration.sql', 'utf8'),
    );
    await pg.exec(
      await readFile('prisma/migrations/202611190003_utc_timestamps/migration.sql', 'utf8'),
    );
    await pg.exec(
      await readFile('prisma/migrations/202611190004_v18_extensions/migration.sql', 'utf8'),
    );
    await pg.exec(
      await readFile('prisma/migrations/202611200001_openai_usage/migration.sql', 'utf8'),
    );
    const tables = await pg.query<{ table_name: string }>(
      "select table_name from information_schema.tables where table_schema='public'",
    );
    expect(tables.rows).toHaveLength(31);
    await pg.query('INSERT INTO "users" ("id","telegramId","timezone") VALUES ($1,$2,$3)', [
      'one',
      '123',
      'Europe/Moscow',
    ]);
    await expect(
      pg.query('INSERT INTO "users" ("id","telegramId","timezone") VALUES ($1,$2,$3)', [
        'two',
        '123',
        'UTC',
      ]),
    ).rejects.toThrow();
    await expect(
      pg.query('INSERT INTO "style_examples" ("id","styleId","text") VALUES ($1,$2,$3)', [
        'example',
        'missing',
        'text',
      ]),
    ).rejects.toThrow();
    const keys = await pg.query(
      "SELECT constraint_name FROM information_schema.table_constraints WHERE constraint_type='FOREIGN KEY'",
    );
    expect(keys.rows.length).toBeGreaterThan(20);
  } finally {
    await pg.close();
  }
}, 30000);
