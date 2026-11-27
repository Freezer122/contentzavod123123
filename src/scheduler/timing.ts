import type { PublishJob } from '../core/domain.js';
export function publicationTiming(job: PublishJob) {
  const iso = (date: Date | null | undefined) => date?.toISOString() ?? null;
  return {
    post_submit_at: iso(job.postSubmitAt),
    post_confirmed_at: iso(job.postConfirmedAt),
    cta_scheduled_at: iso(job.ctaScheduledAt),
    cta_submit_at: iso(job.ctaSubmitAt),
    cta_confirmed_at: iso(job.ctaConfirmedAt),
    actual_interval_seconds:
      job.postSubmitAt && job.ctaSubmitAt
        ? (job.ctaSubmitAt.getTime() - job.postSubmitAt.getTime()) / 1000
        : null,
    cta_lateness_seconds:
      job.ctaScheduledAt && job.ctaSubmitAt
        ? Math.max(0, (job.ctaSubmitAt.getTime() - job.ctaScheduledAt.getTime()) / 1000)
        : null,
  };
}
