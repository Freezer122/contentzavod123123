import type { ManualPolicy } from '../policy/manual.js';
import { randomUUID } from 'node:crypto';
import { audit, type Database } from '../db/database.js';
import { getDocument, putDocument, hashDocument } from '../db/documents.js';
import { assert } from '../core/errors.js';
import type { EngagementJob, ReplyDraft, Candidate } from './service.js';
export interface OperatorPermission {
  jobId: string;
  actor: string;
  expiresAt: string;
}
export interface ReplyPermission {
  id: string;
  accountId: string;
  jobId: string;
  url: string;
  hash: string;
  version: number;
  actor: string;
  createdAt: string;
  expiresAt: string;
  state: 'PENDING' | 'CONFIRMED' | 'CONSUMED' | 'REVOKED';
  confirmedAt?: string;
  consumedAt?: string;
  manual?: { sessionId: string; epoch: number };
}
export class ReplyPermissions {
  constructor(
    private db: Database,
    private operator?: OperatorPermission,
    public manual?: ManualPolicy,
  ) {}
  async get(id: string, db: Database = this.db) {
    const p = await getDocument<ReplyPermission>(db, `reply-permission-${id}`);
    assert(p, 'PERMISSION_MISSING', 'Одноразовое разрешение не найдено');
    return p;
  }
  validate(
    p: ReplyPermission,
    actor: string,
    job: EngagementJob,
    draft: ReplyDraft,
    candidate: Candidate,
  ) {
    assert(
      p.actor === actor && /^\d+$/.test(actor),
      'PERMISSION_ACTOR',
      'Разрешение выдано другому пользователю',
    );
    assert(
      Date.parse(p.expiresAt) > Date.now(),
      'PERMISSION_EXPIRED',
      'Срок одноразового разрешения истёк',
    );
    assert(
      p.jobId === job.id &&
        p.accountId === job.accountId &&
        p.url === candidate.url &&
        p.hash === job.hash &&
        p.hash === draft.hash &&
        p.version === (draft.version ?? 1) &&
        draft.hash === hashDocument({ url: candidate.url, text: draft.text }) &&
        draft.status === 'APPROVED',
      'STALE_APPROVAL',
      'Текст или исходная публикация изменились; нужно новое одобрение',
    );
    assert(
      ['QUEUED', 'PREVIEWED'].includes(job.status) && !job.submittedAt && !job.url,
      'ALREADY_SENT',
      'Отправка уже началась или результат требует сверки',
    );
  }
  checkOperator(p: ReplyPermission) {
    assert(
      this.operator?.jobId === p.jobId &&
        this.operator.actor === p.actor &&
        Date.parse(this.operator.expiresAt) > Date.now(),
      'OPERATOR_PERMISSION_REQUIRED',
      'Одноразовое LIVE-разрешение оператора для этого ответа не выдано или истекло. DRY_RUN сохраняется',
    );
  }
  async checkPolicy(p: ReplyPermission, db = this.db) {
    if (p.manual) {
      assert(this.manual, 'MANUAL_DISABLED', 'Ручные публикации выключены');
      await this.manual.assertAllowed(p.accountId, p.actor, p.manual.sessionId, p.manual.epoch, db);
    } else {
      await import('../policy/manual.js').then((m) => m.assertNotEmergency(db));
      this.checkOperator(p);
    }
  }
  async issueManual(
    cardId: string,
    actor: string,
    job: EngagementJob,
    draft: ReplyDraft,
    candidate: Candidate,
  ) {
    assert(this.manual, 'MANUAL_DISABLED', 'Ручные публикации выключены');
    return this.db.transaction(async (tx) => {
      const c = await this.manual!.readCard(cardId, actor, tx);
      assert(
        c.kind === 'REPLY' &&
          c.entityId === draft.id &&
          c.accountId === job.accountId &&
          c.hash === draft.hash &&
          c.version === (draft.version ?? 1) &&
          c.sourceUrl === candidate.url,
        'STALE_CARD',
        'Карточка устарела. Откройте текущую версию ответа',
      );
      if (c.used) {
        assert(c.resultId, 'PERMISSION_USED', 'Задача уже принята');
        return this.get(c.resultId, tx);
      }
      const settings = await this.manual!.assertAllowed(
        job.accountId,
        actor,
        c.sessionId,
        undefined,
        tx,
      );
      const p: ReplyPermission = {
        id: randomUUID().replaceAll('-', ''),
        accountId: job.accountId,
        jobId: job.id,
        url: candidate.url,
        hash: draft.hash,
        version: draft.version ?? 1,
        actor,
        state: 'CONFIRMED',
        createdAt: new Date().toISOString(),
        confirmedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 10 * 60000).toISOString(),
        manual: { sessionId: c.sessionId, epoch: settings.epoch },
      };
      this.validate(p, actor, job, draft, candidate);
      await putDocument(tx, `reply-permission-${p.id}`, p);
      await putDocument(tx, `manual-card-${c.id}`, { ...c, used: true, resultId: p.id });
      await audit(tx, actor, 'MANUAL_REPLY_CONFIRMED', job.id, p.hash);
      return p;
    });
  }
  async issue(job: EngagementJob, draft: ReplyDraft, candidate: Candidate, actor: string) {
    assert(
      job.dryRunHash === job.hash && job.dryRunAt && Date.parse(job.dryRunAt) > Date.now() - 60000,
      'PREFLIGHT_REQUIRED',
      'Нужна свежая read-only проверка текущего текста',
    );
    assert(/^\d+$/.test(actor), 'PERMISSION_ACTOR', 'Нужен Telegram-пользователь');
    const p: ReplyPermission = {
      id: randomUUID().replaceAll('-', ''),
      accountId: job.accountId,
      jobId: job.id,
      url: candidate.url,
      hash: draft.hash,
      version: draft.version ?? 1,
      actor,
      state: 'PENDING',
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 5 * 60000).toISOString(),
    };
    this.validate(p, actor, job, draft, candidate);
    return putDocument(this.db, `reply-permission-${p.id}`, p);
  }
  async confirm(id: string, actor: string) {
    return this.db.transaction(async (tx) => {
      const p = await this.get(id, tx);
      assert(
        p.state === 'PENDING',
        'PERMISSION_USED',
        'Разрешение уже подтверждено или использовано',
      );
      const job = (await getDocument<EngagementJob>(tx, `engagement-job-${p.jobId}`))!,
        d = job?.draftId
          ? await getDocument<ReplyDraft>(tx, `engagement-draft-${job.accountId}-${job.draftId}`)
          : null,
        c = job
          ? await getDocument<Candidate>(
              tx,
              `engagement-candidate-${job.accountId}-${job.candidateId}`,
            )
          : null;
      assert(job && d && c, 'NOT_FOUND', 'Задача не найдена');
      this.validate(p, actor, job, d, c);
      this.checkOperator(p);
      await audit(tx, actor, 'REPLY_PERMISSION_CONFIRMED', p.jobId, p.id);
      return putDocument(tx, `reply-permission-${id}`, {
        ...p,
        state: 'CONFIRMED',
        confirmedAt: new Date().toISOString(),
      } as ReplyPermission);
    });
  }
  async revoke(id: string, actor: string) {
    await this.db.transaction(async (tx) => {
      const p = await this.get(id, tx);
      assert(p.actor === actor, 'PERMISSION_ACTOR', 'Разрешение другого пользователя');
      assert(p.state !== 'CONSUMED', 'PERMISSION_USED', 'Отправка уже началась');
      await putDocument(tx, `reply-permission-${id}`, { ...p, state: 'REVOKED' });
      await audit(tx, actor, 'REPLY_PERMISSION_REVOKED', p.jobId, p.id);
    });
  }
}
