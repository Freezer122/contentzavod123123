import { createApplication } from '../src/app.js';
import { loadConfig } from '../src/core/config.js';
import { writeFile } from 'node:fs/promises';
const config = loadConfig({
  ...process.env,
  PROCESS_ROLE: 'bot',
  BROWSER_EXECUTION_MODE: 'DRY_RUN',
  LLM_API_KEY: '',
});
const app = await createApplication(config);
const report: Record<string, unknown> = {
  mode: 'HANDLER_CHECK_WITH_REAL_TELEGRAM_REPLIES',
  pollingStarted: false,
  commands: [],
  llmRequests: 0,
};
try {
  await app.bot!.init();
  let responses = 0;
  app.bot!.api.config.use(async (previous, method, payload, signal) => {
    const result = await previous(method, payload, signal);
    if (method === 'sendMessage' && result.ok) responses++;
    return result;
  });
  let sequence = 991500000;
  for (const command of ['/accounts', '/queue']) {
    const id = config.allowedIds[0]!;
    const before = responses;
    await app.bot!.handleUpdate({
      update_id: sequence++,
      message: {
        message_id: sequence,
        date: Math.floor(Date.now() / 1000),
        from: { id, is_bot: false, first_name: 'V1.5 test' },
        chat: { id, type: 'private', first_name: 'V1.5 test' },
        text: command,
        entities: [{ type: 'bot_command', offset: 0, length: command.length }],
      },
    });
    (report.commands as unknown[]).push({ command, telegramReplyAccepted: responses > before });
  }
  report.factoryPaused = (await app.db.get('setting', 'factoryPaused'))?.value;
  report.botRole = config.PROCESS_ROLE;
  report.ok = (report.commands as { telegramReplyAccepted: boolean }[]).every(
    (c) => c.telegramReplyAccepted,
  );
  await writeFile(
    '/var/lib/content-factory/reports/v15-telegram-handlers.json',
    JSON.stringify(report, null, 2),
    { mode: 0o600 },
  );
  console.log(JSON.stringify(report));
} finally {
  await app.close();
}
