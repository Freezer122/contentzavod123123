import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { statfs } from 'node:fs/promises';
import type { Database } from '../db/database.js';
import type { BrowserProvider } from '../browser/providers.js';
export class Monitoring {
  private previousCpu = os.cpus();
  constructor(
    private db: Database,
    private providers: BrowserProvider[],
    private redisPing: () => Promise<string>,
    private demo: boolean,
  ) {}
  async snapshot() {
    const cpus = os.cpus();
    let idle = 0,
      totalCpu = 0;
    for (let i = 0; i < cpus.length; i++) {
      const current = cpus[i]!.times,
        previous = this.previousCpu[i]?.times;
      if (!previous) continue;
      idle += current.idle - previous.idle;
      totalCpu +=
        Object.values(current).reduce((a, b) => a + b, 0) -
        Object.values(previous).reduce((a, b) => a + b, 0);
    }
    this.previousCpu = cpus;
    const cpuPercent = totalCpu ? 100 * (1 - idle / totalCpu) : null;
    const now = new Date(),
      requests = await this.db.list('aiRequest'),
      today = now.toISOString().slice(0, 10),
      month = today.slice(0, 7);
    const used = requests.filter((x) => x.createdAt.toISOString().startsWith(today)),
      monthly = requests.filter((x) => x.createdAt.toISOString().startsWith(month));
    const cost = (rows: typeof requests) =>
      rows.reduce(
        (s, r) =>
          s + (r.status === 'RESERVED' || r.status === 'UNKNOWN' ? r.reservedUsd : r.costUsd),
        0,
      );
    const disk = await statfs('.');
    const total = Number(disk.blocks) * Number(disk.bsize),
      free = Number(disk.bavail) * Number(disk.bsize);
    let database = 'OK';
    try {
      await this.db.list('setting');
    } catch {
      database = 'ERROR';
    }
    const active = await Promise.all(
      this.providers.map((p) =>
        p
          .activeSessions()
          .then((s) => s.length)
          .catch(() => null),
      ),
    );
    const profiles = new Set((await this.db.list('browserProfile')).map((p) => p.id));
    const managedBrowsers = (await this.db.list('lease')).filter(
      (l) => profiles.has(l.id) && l.expiresAt.getTime() > Date.now(),
    ).length;
    let browserProcesses: number | null = null;
    try {
      const { stdout } = await promisify(execFile)('ps', ['-axo', 'comm='], {
        timeout: 3000,
        maxBuffer: 1024 * 1024,
      });
      browserProcesses = stdout
        .split('\n')
        .filter((line) => /chrom(e|ium)|adspower|dolphin|sunbrowser/i.test(line)).length;
    } catch {}
    return {
      demo: this.demo,
      cpuPercent,
      cpuLoad1m: os.loadavg()[0],
      cpuCount: os.cpus().length,
      ramTotalBytes: os.totalmem(),
      ramUsedBytes: os.totalmem() - os.freemem(),
      processRssBytes: process.memoryUsage().rss,
      diskTotalBytes: total,
      diskFreeBytes: free,
      activeBrowsers: managedBrowsers,
      browserProcesses,
      providerSessions: active.some((x) => x === null)
        ? null
        : active.reduce<number>((a, b) => a + (b ?? 0), 0),
      queued: (await this.db.list('publishJob', { status: 'QUEUED' })).length,
      errors24h: (await this.db.list('systemEvent', { level: 'ERROR' })).filter(
        (x) => now.getTime() - x.createdAt.getTime() < 86400000,
      ).length,
      database: this.demo ? 'DEMO_FILE' : database,
      redis: await this.redisPing().catch(() => 'ERROR'),
      aiRequests24h: used.length,
      inputTokens24h: used.reduce((s, r) => s + r.inputTokens, 0),
      outputTokens24h: used.reduce((s, r) => s + r.outputTokens, 0),
      aiCostTotal: cost(requests),
      aiCost24h: cost(used),
      aiCostMonth: cost(monthly),
    };
  }
}
