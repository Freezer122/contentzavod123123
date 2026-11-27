import type { Database } from '../db/database.js';
import type { Post, PublishJob } from '../core/domain.js';
import { getDocument, putDocument, listDocuments, hashDocument } from '../db/documents.js';
import { assert } from '../core/errors.js';
import { renderCta } from './service.js';
import { localTime } from '../autopilot/schedule.js';

/** Durable child of the existing PublishingJob, dispatched by the same queue. */
export interface CtaTask {
  id: string;
  jobId: string;
  accountId: string;
  parentPostId: string;
  parentPermalink: string;
  ctaVersion: number;
  text: string;
  url: string | null;
  contentHash: string;
  imageHash: string | null;
  imagePath: string | null;
  scheduledAt: string;
  status: 'WAITING' | 'SENDING' | 'PUBLISHED' | 'FAILED' | 'UNCERTAIN' | 'DISABLED';
  submittedAt?: string;
  confirmedAt?: string;
  permalink?: string | null;
  reason?: string;
  delayReason?: string;
  manualRequestedBy?: string;
  createdAt: string;
  notifiedSignature?: string;
}
export const ctaKey = (jobId: string) => `cta-task-${jobId}`;
export const ctaState = (status: string): CtaTask['status'] =>
  status === 'PENDING'
    ? 'WAITING'
    : status === 'COMMENT_FAILED'
      ? 'FAILED'
      : (status as CtaTask['status']);
export async function createCtaTask(
  db: Database,
  job: PublishJob,
  post: Post,
  manualRequestedBy?: string,
) {
  const old = await getDocument<CtaTask>(db, ctaKey(job.id));
  if (old) return old; // One child for a parent, including across restarts and CTA edits.
  const account = await db.get('account', job.accountId),
    u = new URL(post.url);
  assert(
    account &&
      post.jobId === job.id &&
      post.accountId === account.id &&
      job.postStatus === 'PUBLISHED' &&
      u.protocol === 'https:' &&
      ['www.threads.com', 'threads.com', 'www.threads.net', 'threads.net'].includes(u.hostname) &&
      u.pathname.startsWith(`/@${account.username}/post/`),
    'CTA_PARENT',
    'CTA разрешён только под подтверждённым собственным постом',
  );
  assert(job.ctaEnabled, 'CTA_DISABLED', 'CTA выключен');
  const task: CtaTask = {
    id: ctaKey(job.id),
    jobId: job.id,
    accountId: job.accountId,
    parentPostId: post.id,
    parentPermalink: post.url,
    ctaVersion: job.ctaVersion ?? 1,
    text: job.ctaText ?? '',
    url: job.ctaUrl ?? null,
    contentHash: hashDocument(renderCta(job.ctaText ?? '', job.ctaUrl)),
    imageHash: job.ctaMediaSha256 ?? null,
    imagePath: job.ctaMediaPath ?? null,
    scheduledAt: (manualRequestedBy
      ? new Date()
      : (job.ctaScheduledAt ?? new Date((job.postSubmitAt ?? post.publishedAt).getTime() + 20000))
    ).toISOString(),
    status: job.ctaText?.trim() ? ctaState(job.commentStatus) : 'FAILED',
    reason: job.ctaText?.trim() ? undefined : 'CTA не настроен',
    manualRequestedBy,
    createdAt: new Date().toISOString(),
  };
  await putDocument(db, task.id, task);
  return task;
}
export async function updateCtaTask(db: Database, jobId: string, patch: Partial<CtaTask>) {
  const t = await getDocument<CtaTask>(db, ctaKey(jobId));
  if (t) await putDocument(db, t.id, { ...t, ...patch });
}
export async function ctaStatus(db: Database, job: PublishJob) {
  const task = await getDocument<CtaTask>(db, ctaKey(job.id)),
    post = (await db.list('post', { jobId: job.id }))[0],
    comment = post ? (await db.list('comment', { postId: post.id }))[0] : undefined;
  return {
    status: task?.status ?? ctaState(job.commentStatus),
    reason:
      task?.reason ??
      (job.commentStatus === 'DISABLED'
        ? 'CTA был выключен при отправке поста; автоматическая досылка не выполняется'
        : (job.lastError ??
          (job.commentStatus === 'PENDING' ? 'Ожидает подтверждения поста и срока CTA' : ''))),
    url: task?.permalink ?? comment?.url,
    scheduledAt: task?.scheduledAt ?? job.ctaScheduledAt?.toISOString(),
  };
}
export async function ctaStats(
  db: Database,
  accountId: string,
  day?: string,
  timezone = 'Europe/Moscow',
) {
  const posts = (await db.list('post', { accountId })).filter(
      (p) => !day || localTime(p.publishedAt.getTime(), timezone).day === day,
    ),
    jobs = (await db.list('publishJob', { accountId })).filter((j) =>
      posts.some((p) => p.jobId === j.id),
    ),
    states = await Promise.all(jobs.map((j) => ctaStatus(db, j)));
  return {
    published: states.filter((s) => s.status === 'PUBLISHED').length,
    waiting: states.filter((s) => s.status === 'WAITING' || s.status === 'SENDING').length,
    failed: states.filter((s) => s.status === 'FAILED').length,
    uncertain: states.filter((s) => s.status === 'UNCERTAIN').length,
  };
}
export const ctaTasks = (db: Database) => listDocuments<CtaTask>(db, 'cta-task-');
export async function ctaLabel(db: Database, jobId: string) {
  const j = await db.get('publishJob', jobId);
  if (!j) return '';
  const c = await ctaStatus(db, j);
  return `CTA: ${c.status}${c.url ? '\n' + c.url : ''}${c.reason ? '\nПричина: ' + c.reason : ''}`;
}
