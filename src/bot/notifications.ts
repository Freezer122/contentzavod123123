import type { Database } from '../db/database.js';
import { base } from '../db/database.js';

// One durable cursor per allowed recipient; no replay of historical test notifications.
export class TelegramNotifications {
  private timer?: NodeJS.Timeout;
  private busy = false;
  constructor(
    private db: Database,
    private recipients: number[],
    private send: (id: number, text: string) => Promise<unknown>,
  ) {}
  async start() {
    const events = (await this.db.list('systemEvent', { code: 'NOTIFICATION' })).sort(
      (a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id),
    );
    const latest = events.at(-1);
    for (const id of this.recipients)
      if (!(await this.db.get('setting', `telegram-notification-cursor-${id}`)))
        await this.db.insert('setting', {
          ...base(`telegram-notification-cursor-${id}`),
          value: JSON.stringify({
            at: latest?.createdAt.toISOString() ?? new Date().toISOString(),
            id: latest?.id ?? '',
            ids: latest
              ? events
                  .filter((e) => e.createdAt.getTime() === latest.createdAt.getTime())
                  .map((e) => e.id)
              : [],
          }),
        });
    this.timer = setInterval(() => {
      void this.tick().catch(() => {});
    }, 5000);
  }
  async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      const events = (await this.db.list('systemEvent', { code: 'NOTIFICATION' })).sort(
        (a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id),
      );
      for (const id of this.recipients) {
        const key = `telegram-notification-cursor-${id}`;
        const state = await this.db.get('setting', key);
        if (!state) continue;
        let cursor = JSON.parse(state.value);
        for (const event of events
          .filter(
            (e) =>
              e.createdAt.toISOString() > cursor.at ||
              (e.createdAt.toISOString() === cursor.at &&
                !(cursor.ids ?? [cursor.id]).includes(e.id)),
          )
          .slice(0, 10)) {
          try {
            await this.send(id, event.message.slice(0, 4000));
          } catch {
            break;
          }
          cursor = {
            at: event.createdAt.toISOString(),
            id: event.id,
            ids:
              event.createdAt.toISOString() === cursor.at
                ? [...(cursor.ids ?? [cursor.id]), event.id]
                : [event.id],
          };
          await this.db.update('setting', key, { value: JSON.stringify(cursor) });
        }
      }
    } finally {
      this.busy = false;
    }
  }
  close() {
    if (this.timer) clearInterval(this.timer);
  }
}
