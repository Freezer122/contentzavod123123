/** No generation, no activation, no real send: all browser calls have commit=false or a throwing barrier. */
import { createApplication } from '../src/app.js';
import { loadConfig } from '../src/core/config.js';
import { getDocument, putDocument } from '../src/db/documents.js';
import { writeFile } from 'node:fs/promises';
import { assert } from '../src/core/errors.js';
import { InlineKeyboard } from '../src/bot/keyboard.js';
const app = await createApplication(loadConfig({ ...process.env, PROCESS_ROLE: 'bot' }));
try {
  const s = app.services,
    a: any = await getDocument(app.db, 'v117-acceptance'),
    before = (await app.db.list('post')).length,
    bs = (await s.engagement.jobs()).filter((j) => j.submittedAt).length,
    ids = [a.postSlotId, ...a.replySlotIds],
    results = [];
  assert(
    (await s.autopilotPolicy.settings('threads02')).state === 'ERROR',
    'SAFETY',
    'Во время перепроверки отправка должна быть заблокирована',
  );
  for (const id of ids) results.push(await s.autopilot.previewSlot('threads02', id));
  assert(
    (await app.db.list('post')).length === before &&
      (await s.engagement.jobs()).filter((j) => j.submittedAt).length === bs,
    'DRY_SUBMIT',
    'Опубликованные записи изменились',
  );
  const slots = await s.autopilot.schedule('threads02'),
    prepared = await Promise.all(
      ids.map(async (id) => {
        const slot = slots.find((x) => x.id === id)!,
          work: any = await getDocument(app.db, `autopilot-work-${slot.contentJobId}`);
        return {
          slot,
          text: work.text,
          sourceUrl: work.candidateId
            ? (await s.engagement.candidate('threads02', work.candidateId)).url
            : null,
        };
      }),
    );
  const next = {
    ...a,
    previews: results,
    dryPassedAt: new Date().toISOString(),
    prepared,
    error: undefined,
  };
  await putDocument(app.db, 'v117-acceptance', next);
  await writeFile(
    '/var/lib/content-factory/reports/KEEP-v117-acceptance.json',
    JSON.stringify(next, null, 2),
    { mode: 0o600 },
  );
  await app.bot!.api.sendMessage(
    7842338078,
    'V1.17: полный DRY_RUN пройден. Проверены редактор поста и три ответа, ни одного submit. Отправки пока заблокированы автоматической проверкой разрешений\n\n' +
      prepared
        .map(
          (p, i) =>
            `${i === 0 ? 'ПОСТ' : 'ОТВЕТ ' + i}\n${p.text}\n${p.sourceUrl?.startsWith('https:') ? p.sourceUrl : ''}`,
        )
        .join('\n\n'),
    {
      reply_markup: new InlineKeyboard()
        .text('Расписание', 'ap:schedule:threads02')
        .text('Автопилот', 'ap:home:threads02'),
    },
  );
  console.log(JSON.stringify({ dryPassed: true, results, prepared }));
} finally {
  await app.close();
}
