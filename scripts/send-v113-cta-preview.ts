import { createApplication } from '../src/app.js';
import { loadConfig } from '../src/core/config.js';
import { getDocument, putDocument } from '../src/db/documents.js';
import { assert } from '../src/core/errors.js';
const config = loadConfig({ ...process.env, PROCESS_ROLE: 'bot' }),
  app = await createApplication(config),
  key = 'v113-cta-recovery-preview';
try {
  const prior = await getDocument<any>(app.db, key);
  if (prior?.sent) {
    console.log('CTA_PREVIEW_ALREADY_SENT');
  } else {
    const job = await app.db.get('publishJob', '3a54f7b8-c10c-48d6-9726-b118718f1446');
    assert(
      job?.postStatus === 'PUBLISHED' && !job.ctaSubmitAt,
      'UNSAFE',
      'Only confirmed post without CTA submit',
    );
    await app.bot!.init();
    let previewDelivered = false;
    app.bot!.api.config.use(async (prev, method, payload, signal) => {
      if (method === 'answerCallbackQuery') return { ok: true, result: true } as any;
      const result = await prev(method, payload, signal);
      if (
        result.ok &&
        (method === 'sendPhoto' ||
          (method === 'sendMessage' &&
            String((payload as any).text ?? '').startsWith('CTA к подтверждённому посту')))
      )
        previewDelivered = true;
      return result;
    });
    const updateId = Math.floor(Date.now() / 1000) + 1500000000,
      owner = Number(config.TELEGRAM_OWNER_ID);
    await putDocument(app.db, key, {
      syntheticPreviewUpdate: updateId,
      sent: false,
      jobId: job.id,
    });
    await app.bot!.api.sendMessage(
      owner,
      'Пост подтверждён чтением. Повторной отправки не будет. Первоначальное 10-минутное разрешение отправки истекло во время сверки; ниже показаны точный CTA и его фотография. Только ваше нажатие «Опубликовать этот CTA» отправит комментарий к подтверждённому посту',
    );
    await app.bot!.handleUpdate({
      update_id: updateId,
      callback_query: {
        id: String(updateId),
        chat_instance: 'v113-preview-only',
        from: { id: owner, is_bot: false, first_name: 'Owner' },
        data: `v113cta:${job.id}`,
        message: {
          message_id: updateId,
          date: Math.floor(Date.now() / 1000),
          chat: { id: owner, type: 'private', first_name: 'Owner' },
          text: 'Read-only CTA preview',
        },
      },
    });
    assert(previewDelivered, 'PREVIEW_NOT_DELIVERED', 'CTA preview was not accepted by Telegram');
    await putDocument(app.db, key, {
      syntheticPreviewUpdate: updateId,
      sent: true,
      jobId: job.id,
      sentAt: new Date().toISOString(),
    });
    console.log('CTA_PREVIEW_DELIVERED_NO_SUBMIT');
  }
} finally {
  await app.close();
}
