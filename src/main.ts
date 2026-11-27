import { loadConfig } from './core/config.js';
import { createApplication } from './app.js';
import { installLogging } from './core/logging.js';
const env = {
  ...process.env,
  ...(process.argv.includes('--demo') ? { APP_MODE: 'demo' } : {}),
  ...(process.argv.includes('--worker') ? { PROCESS_ROLE: 'worker' } : {}),
};
let closing = false;
installLogging(env);
const config = loadConfig(env);
const safeError = (error: unknown) => {
  const message = error instanceof Error ? error.message : 'Application error';
  return config.TELEGRAM_BOT_TOKEN
    ? message.replaceAll(config.TELEGRAM_BOT_TOKEN, '[REDACTED]')
    : message;
};
const app = await createApplication(config, undefined, {
  onFatal: () => {
    if (closing) return;
    closing = true;
    void app.close().finally(() => {
      process.exitCode = 1;
    });
  },
});
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.on(signal, () => {
    if (closing) return;
    closing = true;
    void app
      .close()
      .then(() => {
        process.exitCode = 0;
      })
      .catch((e) => {
        console.error(safeError(e));
        process.exitCode = 1;
      });
  });
try {
  await app.start();
} catch (e) {
  console.error(safeError(e));
  await app.close();
  process.exitCode = 1;
}
