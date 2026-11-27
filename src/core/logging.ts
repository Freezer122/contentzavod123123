import { appendFileSync, mkdirSync, statSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { format } from 'node:util';
// Open each record independently: logrotate never needs to interrupt the process.
export function installLogging(env: NodeJS.ProcessEnv) {
  const dir = env.LOG_DIR;
  if (!dir) return;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const secrets = Object.entries(env)
    .filter(([key, value]) => value && /TOKEN|PASSWORD|SECRET|API_KEY|DATABASE_URL/i.test(key))
    .map(([, value]) => value!);
  const redact = (message: string) =>
    secrets.reduce((s, secret) => s.replaceAll(secret, '[REDACTED]'), message);
  const limit = Math.max(65536, Number(env.LOG_MAX_BYTES ?? 10485760));
  for (const [method, level] of [
    ['log', 'INFO'],
    ['warn', 'WARN'],
    ['error', 'ERROR'],
    ['debug', 'DEBUG'],
  ] as const) {
    const original = console[method].bind(console);
    console[method] = (...args: unknown[]) => {
      const line = JSON.stringify({
        at: new Date().toISOString(),
        role: env.PROCESS_ROLE ?? 'worker',
        level,
        message: redact(format(...args)),
      });
      original(line);
      const name = level === 'ERROR' ? 'critical' : level === 'DEBUG' ? 'debug' : 'normal';
      const path = join(dir, `${env.PROCESS_ROLE ?? 'worker'}-${name}.log`);
      try {
        // One bounded rollover also protects between hourly logrotate invocations.
        try {
          if (statSync(path).size >= limit) renameSync(path, path + '.rollover');
        } catch {}
        appendFileSync(path, line + '\n', { mode: 0o600 });
      } catch {
        /* journald remains available if the disk is full */
      }
    };
  }
}
