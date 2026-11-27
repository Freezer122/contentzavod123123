/** Native read-only CTA composer rehearsal. No LLM, no settings enable, hard barrier before click. */
import { createApplication } from '../src/app.js';
import { loadConfig } from '../src/core/config.js';
import { writeFile, readFile } from 'node:fs/promises';
import { InputFile } from 'grammy';
import { getDocument, putDocument, hashDocument } from '../src/db/documents.js';
import { localTime } from '../src/autopilot/schedule.js';
import { assert } from '../src/core/errors.js';
const app = await createApplication(loadConfig({ ...process.env, PROCESS_ROLE: 'bot' }));
try {
  const s = app.services,
    posts = (await app.db.list('post', { accountId: 'threads02' })).sort(
      (a, b) => b.publishedAt.getTime() - a.publishedAt.getTime(),
    ),
    target = posts.find((p) => p.jobId === '0e7935d9-1f45-41af-83ed-fdc122c9a9ec') ?? posts[0]!;
  assert(target, 'NO_POST', 'Нет собственного опубликованного поста');
  const before = await app.db.list('comment'),
    jobs = (await app.db.list('publishJob', { accountId: 'threads02' })).map((j) => ({
      id: j.id,
      ctaSubmitAt: j.ctaSubmitAt,
    })),
    ap = await s.autopilotPolicy.settings('threads02'),
    ai = (await app.db.list('aiRequest')).map((x) => x.id),
    dry = await app.executor.previewCta(target.jobId),
    cta = await s.ctas.ensure('threads02');
  const today = localTime(Date.now(), ap.config.timezone).day;
  const historicalChecks = [dry];
  for (const p of posts) {
    if (p.id === target.id || localTime(p.publishedAt.getTime(), ap.config.timezone).day !== today)
      continue;
    if (!(await getDocument(app.db, `autopilot-grant-${p.jobId}`))) continue;
    historicalChecks.push(await app.executor.previewCta(p.jobId));
  }
  assert(
    hashDocument(before) === hashDocument(await app.db.list('comment')) &&
      hashDocument(jobs) ===
        hashDocument(
          (await app.db.list('publishJob', { accountId: 'threads02' })).map((j) => ({
            id: j.id,
            ctaSubmitAt: j.ctaSubmitAt,
          })),
        ),
    'DRY_SUBMIT',
    'CTA записи изменились',
  );
  assert(
    hashDocument(ap) === hashDocument(await s.autopilotPolicy.settings('threads02')),
    'DRY_ENABLE',
    'Режим изменился',
  );
  assert(
    hashDocument(ai) === hashDocument((await app.db.list('aiRequest')).map((x) => x.id)),
    'DRY_LLM',
    'Появилась генерация',
  );
  const report = {
    at: new Date().toISOString(),
    parent: target.url,
    jobId: target.jobId,
    dry,
    historicalChecks,
    cta: {
      text: cta.text,
      url: cta.url,
      version: cta.version,
      mediaSha256: cta.mediaSha256,
      mediaPath: cta.mediaPath,
    },
    autopilot: ap.state,
    ctaEnabled: ap.config.allowCTA,
    submit: false,
    llmCalls: 0,
  };
  await writeFile(
    '/var/lib/content-factory/reports/KEEP-cta-fix-dry.json',
    JSON.stringify(report, null, 2),
    { mode: 0o600 },
  );
  await putDocument(app.db, 'cta-fix-dry-proof', report);
  await app.bot!.api.sendMessage(
    7842338078,
    'CTA FIX: нативный DRY_RUN пройден. Подтверждён собственный родительский пост, введён сохранённый CTA, загружена фотография и достигнут закрытый предкликовый барьер. Отправок и LLM-вызовов нет\n' +
      target.url,
  );
  const caption = `Сохранённый CTA, версия ${cta.version}\n${cta.text}\n${cta.url ?? ''}\nФото: ${cta.mediaPath ? 'есть' : 'нет'}\nПредпросмотр без включения отправок`;
  if (cta.mediaPath)
    await app.bot!.api.sendPhoto(
      7842338078,
      new InputFile(await readFile(cta.mediaPath), 'cta.jpg'),
      { caption },
    );
  else await app.bot!.api.sendMessage(7842338078, caption);
  console.log(JSON.stringify(report));
} finally {
  await app.close();
}
