import type { Database } from '../db/database.js';
import type { Account, Post } from '../core/domain.js';
import type { Insights } from '../analytics/collector.js';
import type { EngagementPort, Candidate } from '../engagement/service.js';
import type { AutopilotPolicy } from './policy.js';
import { observe } from './viral.js';
/** Low priority read-only fallback. Hidden views/followers stay null. */
export class AutopilotInsights implements Insights {
  constructor(
    private db: Database,
    private official: Insights,
    private policy: AutopilotPolicy,
    private port: EngagementPort,
  ) {}
  async post(post: Post, account: Account) {
    const values = await this.official.post(post, account);
    if (
      (await this.db.get('setting', 'emergencyStop'))?.value === 'true' ||
      (await this.db.get('setting', 'automationPaused'))?.value === 'true'
    )
      return values;
    if (
      values.status === 'AVAILABLE' ||
      (await this.policy.settings(account.id)).state !== 'RUNNING' ||
      !this.port.readPost
    )
      return values;
    if (
      (await this.db.list('publishJob')).some(
        (j) =>
          j.status === 'RUNNING' ||
          (j.status === 'QUEUED' && j.scheduledAt.getTime() <= Date.now() + 60000),
      )
    )
      return { ...values, status: 'DEFERRED_HIGHER_PRIORITY' };
    if (
      (await this.policy.works()).some(
        (w) => ['QUEUED', 'RUNNING', 'SCHEDULED'].includes(w.status) && w.kind !== 'STATS',
      )
    )
      return { ...values, status: 'DEFERRED_HIGHER_PRIORITY' };
    const read = await this.port.readPost(account.id, post.url),
      o = observe({ ...read, id: post.id, url: post.url } as Candidate);
    const available = [o.likes, o.replies, o.reposts].some((v) => v.value !== null);
    return {
      views: null,
      likes: o.likes.value,
      replies: o.replies.value,
      reposts: o.reposts.value,
      quotes: null,
      source: 'THREADS_VISIBLE_READ_ONLY',
      status: available ? 'PARTIAL' : 'UNAVAILABLE',
    };
  }
  followers(account: Account) {
    return this.official.followers(account);
  }
}
