import { createHmac, randomBytes } from 'node:crypto';
import type { Database } from '../db/database.js';
import { base } from '../db/database.js';
import { assert } from '../core/errors.js';
import { encryptMember, rebuildCohorts } from './retention.js';
export class Tracking {
  constructor(
    private db: Database,
    private secret: string,
  ) {}
  hash(value: string) {
    return createHmac('sha256', this.secret).update(value).digest('hex');
  }
  async create(
    accountId: string,
    destination: string,
    ctaId: string | null = null,
    postId: string | null = null,
  ) {
    const url = new URL(destination);
    assert(
      url.protocol === 'https:' && url.hostname === 't.me' && !url.username && !url.password,
      'INVALID_DESTINATION',
      'Разрешены только HTTPS-ссылки t.me',
    );
    assert(await this.db.get('account', accountId), 'NOT_FOUND', 'Аккаунт не найден');
    if (ctaId) assert(await this.db.get('cta', ctaId), 'NOT_FOUND', 'CTA не найден');
    assert(
      !postId,
      'ACCOUNT_ATTRIBUTION_ONLY',
      'V1.1 использует постоянную ссылку аккаунта без привязки к посту',
    );
    return this.db.transaction(async (tx) => {
      const links = (await tx.list('trackingLink', { accountId })).sort(
        (a, b) => a.createdAt.getTime() - b.createdAt.getTime(),
      );
      const current = links.find((l) => l.permanent) || links[0];
      if (current) {
        const invite = (await tx.list('invite', { accountId, active: true }))[0];
        const destination = invite?.inviteUrl ?? url.href;
        return tx.update('trackingLink', current.id, {
          permanent: true,
          postId: null,
          destination,
          ctaId: ctaId ?? current.ctaId,
        });
      }
      return tx.insert('trackingLink', {
        ...base(),
        code: randomBytes(9).toString('base64url'),
        accountId,
        destination: url.href,
        ctaId,
        postId: null,
        permanent: true,
      });
    });
  }

  async click(code: string, ip: string, userAgent: string) {
    const link = (await this.db.list('trackingLink', { code }))[0];
    assert(link, 'NOT_FOUND', 'Ссылка не найдена');
    // Store a keyed hash only; raw IP and user agent never enter the database or logs.
    await this.db.insert('click', {
      ...base(),
      linkId: link.id,
      visitorHash: this.hash(`${ip}|${userAgent}`),
    });
    return link.destination;
  }
  async registerInvite(
    accountId: string,
    inviteUrl: string,
    channelId: string,
    ctaId: string | null = null,
    postId: string | null = null,
  ) {
    assert(!postId, 'ACCOUNT_ATTRIBUTION_ONLY', 'Приглашения привязываются только к аккаунту');
    return this.db.transaction(async (tx) => {
      const existing = (await tx.list('invite', { accountId })).find((i) => i.active);
      if (existing) {
        assert(
          existing.channelId === channelId,
          'CHANNEL_CONFLICT',
          'Сначала перенесите приглашение аккаунта в другой канал вручную',
        );
        const link = await new Tracking(tx, this.secret).create(
          accountId,
          existing.inviteUrl,
          ctaId,
        );
        return { link, invite: existing };
      }
      const link = await new Tracking(tx, this.secret).create(accountId, inviteUrl, ctaId);
      const invite = await tx.insert('invite', {
        ...base(),
        accountId,
        linkId: link.id,
        inviteUrl,
        channelId,
        active: true,
      });
      // Adopt the invite without changing the account's public redirect code.
      await tx.update('trackingLink', link.id, { destination: inviteUrl });
      return { link: { ...link, destination: inviteUrl }, invite };
    });
  }
  async ensureInvite(accountId: string, channelId: string, create: () => Promise<string>) {
    const { withProfileLease } = await import('../scheduler/lease.js');
    return withProfileLease(this.db, `invite-${accountId}`, async () => {
      const existing = (await this.db.list('invite', { accountId, active: true }))[0];
      if (existing) return this.registerInvite(accountId, existing.inviteUrl, channelId);
      return this.registerInvite(accountId, await create(), channelId);
    });
  }

  async membership(input: {
    eventKey: string;
    channelId: string;
    userId: string;
    kind: 'JOIN' | 'LEAVE';
    inviteUrl?: string;
    occurredAt: Date;
  }) {
    return this.db.transaction(async (tx) => {
      if ((await tx.list('membership', { eventKey: input.eventKey })).length) return null;
      const invite = input.inviteUrl
        ? (await tx.list('invite', { inviteUrl: input.inviteUrl, channelId: input.channelId }))[0]
        : null;
      const userHash = this.hash(input.userId),
        identityId = this.hash(`${input.channelId}|${input.userId}`);
      if (!(await tx.get('memberIdentity', identityId)))
        await tx.insert('memberIdentity', {
          ...base(identityId),
          channelId: input.channelId,
          userHash,
          encryptedUserId: encryptMember(
            input.userId,
            this.secret,
            `${input.channelId}|${userHash}`,
          ),
        });
      const event = await tx.insert('membership', {
        ...base(),
        eventKey: input.eventKey,
        channelId: input.channelId,
        userHash: this.hash(input.userId),
        kind: input.kind,
        inviteId: invite?.id ?? null,
        occurredAt: input.occurredAt,
      });
      if (input.kind === 'JOIN' && invite?.linkId) {
        const link = await tx.get('trackingLink', invite.linkId);
        assert(link, 'NOT_FOUND', 'Tracking-ссылка не найдена');
        await tx.insert('conversion', {
          ...base(),
          createdAt: input.occurredAt,
          eventId: event.id,
          linkId: link.id,
          accountId: link.accountId,
          postId: null,
        });
      }
      await rebuildCohorts(tx, input.channelId, userHash);
      return event;
    });
  }
}
