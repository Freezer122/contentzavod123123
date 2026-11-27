/** Bounded style preview. Never starts polling or calls browser/publishing APIs. */
import { createApplication } from '../src/app.js';
import { loadConfig } from '../src/core/config.js';
import { getDocument, putDocument, hashDocument } from '../src/db/documents.js';
import { assert } from '../src/core/errors.js';
import { InlineKeyboard, InputFile } from 'grammy';
import { readFile, writeFile } from 'node:fs/promises';
import { REPLY_PROMPT_VERSION, replyPrompt } from '../src/engagement/reply-style.js';
import { INSTRUCTION_VERSION } from '../src/content/service.js';

const config = loadConfig({ ...process.env, PROCESS_ROLE: 'bot' });
const app = await createApplication(config),
  owner = config.TELEGRAM_OWNER_ID;
const key = 'v114-acceptance';
let state: any = (await getDocument(app.db, key)) ?? {};
const save = async (patch: object) => {
  state = { ...state, ...patch };
  await putDocument(app.db, key, state);
};
const snapshot = async () => ({
  manual: await app.services.manual.settings('threads02'),
  factoryPaused: await getDocument(app.db, 'factoryPaused'),
  automationPaused: await getDocument(app.db, 'automationPaused'),
  emergencyStop: await getDocument(app.db, 'emergencyStop'),
  thread01: hashDocument(await app.db.get('account', 'threads01')),
  published: [
    ...(await app.db.list('post')).map((p) => ({
      table: 'post' as const,
      id: p.id,
      hash: hashDocument(p),
    })),
    ...(await app.db.list('comment')).map((p) => ({
      table: 'comment' as const,
      id: p.id,
      hash: hashDocument(p),
    })),
  ],
  publishedReplies: (await app.services.engagement.jobs())
    .filter((j) => j.status === 'PUBLISHED')
    .map((j) => ({ id: j.id, hash: hashDocument(j), text: j.draftId })),
});
try {
  assert(
    owner === '7842338078' && config.allowedIds.map(String).includes(owner),
    'OWNER',
    'Wrong owner',
  );
  assert(
    config.BROWSER_EXECUTION_MODE === 'DRY_RUN' &&
      config.ENGAGEMENT_EXECUTION_MODE === 'DRY_RUN' &&
      config.PROFILE_CHANGES_ALLOWED === '0',
    'SAFETY',
    'Safe automatic modes required',
  );
  assert(
    config.POST_MODEL === 'gpt-6.2-sol' && config.REPLY_MODEL === 'gpt-6.1-terra',
    'MODEL',
    'Keep existing models',
  );
  if (!state.startedAt)
    await save({
      startedAt: new Date().toISOString(),
      before: await snapshot(),
      aiBefore: (await app.db.list('aiRequest')).map((r) => r.id),
      phase: 'STARTED',
    });
  const phase = process.env.V114_PHASE ?? 'configure';
  if (phase === 'configure') {
    if (!state.configuredAt) {
      await app.services.engagement.configure(
        'threads02',
        {
          replyManner: 'LIVELY',
          replyProfanity: true,
          replySlang: true,
          replyHumor: true,
          replyLength: 'SHORT',
        },
        owner,
      );
      const own = await app.services.templates.ensureOwnStyle('threads02');
      const extra =
        'V1.14: цельный самостоятельный разговорный пост, живой интернет-сленг, ирония и мат только по контексту, без обязательной шутки и грубости; не выдумывать факты, результаты и личные истории';
      await app.db.update('style', own.id, {
        slang: true,
        profanity: true,
        extra: own.extra.includes('V1.14:')
          ? own.extra
          : [own.extra, extra].filter(Boolean).join('\n'),
      });
      await save({ configuredAt: new Date().toISOString(), solStyleId: own.id });
    }
    const examples = [
      {
        source: 'сильное падение нескольких активов одновременно',
        answer: 'там фада нагнали, людей в шорты загнали ща выебут всех',
      },
      {
        source:
          'Биткоин не может быть принят, как стандарт сохранения капитала, он упал на 30% от своих сентябрьских хаев\n\nА погодите, этож график золота….',
        answer:
          'лоховозка сейчас на всем рынке, нужно очень грамотно работать, это раньше можно было на похуй позы открывать в пробой и все летело',
      },
      {
        source:
          'В 2030-м все устанут от нейросетей и вернутся в аську, форумы и ко мне в браузер — пить чай по вечерам без алгоритмов и бесконечных лент',
        answer: 'в аське также мертвый нейросеточный интернет построят',
      },
    ];
    for (const pair of examples) {
      const existing = (await app.services.quality.humanExamples()).find(
        (e) => e.source === pair.source && e.answer === pair.answer,
      );
      if (!existing)
        await app.services.quality.saveHuman(
          { ...pair, accountIds: ['threads02'], manner: 'LIVELY' },
          owner,
        );
    }
    await save({
      humanExampleIds: (await app.services.quality.humanExamples('threads02')).map((e) => e.id),
      settings: await app.services.engagement.settings('threads02'),
      phase: 'CONFIGURED',
    });
  }
  if (phase === 'previews') {
    assert(state.configuredAt, 'CONFIGURE_FIRST', 'Configure first');
    const baseline = JSON.parse(
      await readFile('/var/lib/content-factory/reports/KEEP-v111-acceptance.json', 'utf8'),
    );
    const oldSource = await app.services.engagement.candidate(
      'threads02',
      '52d6c0eae54955f838c43af1',
    );
    const inputs = [
      {
        label: 'BTC и золото: реакция на шутку',
        source:
          'Биткоин не может быть принят, как стандарт сохранения капитала, он упал на 30% от своих сентябрьских хаев\n\nА погодите, этож график золота…',
      },
      {
        label: 'фад и шортисты',
        source: 'на рынке опять фад, цену резко продавили и толпу загнали в шорты',
      },
      {
        label: 'нейросети и аська',
        source:
          'В 2030-м все устанут от нейросетей и вернутся в аську, форумы и ко мне в браузер — пить чай по вечерам без алгоритмов и бесконечных лент',
      },
      {
        label: 'сравнение с V1.11 на том же исходнике',
        source: oldSource.text,
        old: baseline.terra?.text,
      },
    ];
    for (let i = 0; i < inputs.length; i++) {
      if (state.previews?.[i]) continue;
      // The auxiliary cache/receipt prevents another charge after a completed request.
      // UNKNOWN receipts stop further requests through the existing budget guard.
      const preview = await app.services.engagement.previewReply(
        'threads02',
        inputs[i]!.source,
        owner,
      );
      await save({
        previews: {
          ...state.previews,
          [i]: { ...preview, label: inputs[i]!.label, old: inputs[i]!.old },
        },
      });
    }
    await save({ phase: 'PREVIEWS_READY' });
  }
  if (phase === 'send') {
    assert(
      Object.keys(state.previews ?? {}).length === 4,
      'PREVIEW_FIRST',
      'Four bounded previews required',
    );
    await app.bot!.init(
      AbortSignal.timeout(20000) as unknown as Parameters<NonNullable<typeof app.bot>['init']>[0],
    );
    if (!state.introSentAt) {
      await app.bot!.api.sendMessage(
        Number(owner),
        'V1.14 установлен: Threads 02 → Взаимодействия → Стиль ответов. Живая манера, мат/сленг/юмор разрешены, короткая длина. В «Мои примеры» сохранены три твоих пары. Восемь контекстов проверены на фикстурах; ниже четыре настоящих предпросмотра Terra. Кнопки Хорошо/Плохо сохраняют только оценку. Публикации не выполняются',
        {
          reply_markup: new InlineKeyboard()
            .text('Стиль ответов', 'v111style:threads02')
            .row()
            .text('Мои примеры', 'v114examples:threads02'),
        },
      );
      await save({ introSentAt: new Date().toISOString() });
    }
    for (const [i, p] of Object.entries<any>(state.previews)) {
      if (state.delivered?.[i]) continue;
      const message = `V1.14 · реальная генерация Terra · ${p.label}\n\nИсходник:\n${p.source.slice(0, 1400)}\n${p.old ? '\nРаньше (V1.11):\n' + p.old + '\n' : ''}\nНовый ответ:\n${p.text}\n\n${[...p.text].length} символов · ${p.errors.length ? 'Нужно редактирование: ' + p.errors.join('; ') : 'Формат пройден'}\nТокены ${p.inputTokens}/${p.outputTokens} · $${Number(p.costUsd).toFixed(6)}\nТолько предпросмотр, без отправки в Threads`;
      const sent = await app.bot!.api.sendMessage(Number(owner), message, {
        reply_markup: new InlineKeyboard()
          .text('👍 Хорошо', `v114rate:GOOD:${p.id}`)
          .text('👎 Плохо', `v114rate:BAD:${p.id}`),
      });
      await save({
        delivered: {
          ...state.delivered,
          [i]: { messageId: sent.message_id, at: new Date().toISOString() },
        },
      });
    }
    if (!state.fixtureReportSentAt) {
      const body = Buffer.from(
        'ОФЛАЙН-ФИКСТУРЫ V1.14\nОтветы заранее заданы в тестах. Это не выдача Terra и не дополнительные платные запросы.\n\n' +
          [
            ['BTC упал на 30% от сентябрьских хаев', 'рынок опять устроил проверку на прочность'],
            [
              'на рынке фад, толпу загнали в шорты',
              'там фада нагнали, людей в шорты загнали ща выебут всех',
            ],
            ['шортистов вынесли после отскока на рынке', 'ща ещё лонгусты поверят, что всё поняли'],
            [
              'в 2030-м все устанут от нейросетей и вернутся в аську',
              'в аське также мертвый нейросеточный интернет построят',
            ],
            ['как не открывать позы на похуй в пробой?', 'хотя бы не жать кнопку от скуки'],
            [
              'риск на сделку 2%, без увеличения плеча после убытка',
              'самое сложное тут не переписать правила после первого стопа',
            ],
            [
              'BTC по 100000, риск 2%, контракт API_Key',
              'риск 2% приятнее записывать до входа, чем после',
            ],
            ['ну и что теперь делать?', 'бывает'],
          ]
            .map(
              ([source, answer], i) =>
                `${i + 1}. исходник: ${source}\nответ фикстуры: ${answer}\nпроверки: формат, длина, числа/идентификаторы, один запрос + кэш, нет заданий публикации — PASS`,
            )
            .join('\n\n'),
      );
      await app.bot!.api.sendDocument(
        Number(owner),
        new InputFile(body, 'v114-offline-results.txt'),
        {
          caption:
            'Офлайн-проверки: BTC, фад, ликвидации, AI-шутка, вопрос, риск, числа, неоднозначность. Это кодовые фикстуры с подставными ответами, не дополнительные вызовы модели и не публикации',
        },
      );
      await save({ fixtureReportSentAt: new Date().toISOString() });
    }
    await save({ phase: 'DELIVERED' });
  }
  const after = await snapshot();
  for (const field of [
    'manual',
    'factoryPaused',
    'automationPaused',
    'emergencyStop',
    'thread01',
  ] as const)
    assert(
      hashDocument(after[field]) === hashDocument(state.before[field]),
      'SAFETY_CHANGED',
      field,
    );
  for (const p of state.before.published)
    assert(hashDocument(await app.db.get(p.table, p.id)) === p.hash, 'PUBLISHED_CHANGED', p.id);
  for (const p of state.before.publishedReplies)
    assert(
      hashDocument((await app.services.engagement.jobs()).find((j) => j.id === p.id)) === p.hash,
      'PUBLISHED_REPLY_CHANGED',
      p.id,
    );
  const previewRequests = new Set(Object.values<any>(state.previews ?? {}).map((p) => p.requestId));
  const sinceStart = (await app.db.list('aiRequest')).filter((r) => !state.aiBefore.includes(r.id));
  const ai = sinceStart.filter((r) => previewRequests.has(r.id));
  await save({
    checkedAt: new Date().toISOString(),
    safetyUnchanged: true,
    settings: await app.services.engagement.settings('threads02'),
    promptVersion: REPLY_PROMPT_VERSION,
    solPromptVersion: INSTRUCTION_VERSION,
    prompt: replyPrompt('SHORT', await app.services.engagement.settings('threads02')),
    requests: ai.map((r) => ({
      id: r.id,
      status: r.status,
      model: r.model,
      inputTokens: r.inputTokens,
      outputTokens: r.outputTokens,
      costUsd: r.costUsd,
    })),
    inputTokens: ai.reduce((n, r) => n + r.inputTokens, 0),
    outputTokens: ai.reduce((n, r) => n + r.outputTokens, 0),
    costUsd: ai.reduce((n, r) => n + r.costUsd, 0),
    otherRequestIdsSinceStart: sinceStart
      .filter((r) => !previewRequests.has(r.id))
      .map((r) => r.id),
    posts: (await app.db.list('post')).length,
    comments: (await app.db.list('comment')).length,
  });
  await writeFile(
    '/var/lib/content-factory/reports/KEEP-v114-acceptance.json',
    JSON.stringify(state, null, 2),
    { mode: 0o600 },
  );
  console.log(
    JSON.stringify({
      phase: state.phase,
      requests: ai.length,
      inputTokens: state.inputTokens,
      outputTokens: state.outputTokens,
      costUsd: state.costUsd,
      delivered: state.delivered,
      safetyUnchanged: true,
      settings: state.settings,
    }),
  );
} finally {
  await app.close();
}
