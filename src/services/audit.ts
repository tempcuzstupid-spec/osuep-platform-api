import { db } from '../db/index.js';
import { auditEvents, type NewAuditEvent } from '../db/schema/index.js';
import { getCtx } from '../plugins/request-context.js';
import type { FastifyRequest } from 'fastify';

export type AuditInput = Omit<NewAuditEvent, 'actorUserId' | 'actorMembershipId' | 'actorIp' | 'actorUserAgent' | 'orgId' | 'occurredAt'> & {
  orgId?: string | null;
};

/**
 * Record an audit event. Fire-and-forget by default; awaits only on demand.
 * Per Vol III: "Immutable audit trail with replayable action timelines."
 */
export async function recordAudit(
  req: FastifyRequest,
  input: AuditInput,
  ctxOverride?: { userId?: string; membershipId?: string; orgId?: string },
): Promise<void> {
  const ctx = (() => {
    try {
      return getCtx(req);
    } catch {
      return null;
    }
  })();

  const row: NewAuditEvent = {
    actorUserId: ctxOverride?.userId ?? ctx?.userId ?? null,
    actorMembershipId: ctxOverride?.membershipId ?? ctx?.membershipId ?? null,
    actorIp: ctx?.ip ?? null,
    actorUserAgent: ctx?.userAgent ?? null,
    orgId: ctxOverride?.orgId ?? input.orgId ?? ctx?.orgId ?? null,
    action: input.action,
    targetType: input.targetType ?? null,
    targetId: input.targetId ?? null,
    metadata: input.metadata ?? {},
    occurredAt: new Date(),
  };

  await db.insert(auditEvents).values(row);
}

/** Synchronous variant that does not throw on DB failure — for auth paths. */
export function recordAuditSafe(req: FastifyRequest, input: AuditInput): void {
  recordAudit(req, input).catch((err) => {
    req.log.error({ err, action: input.action }, 'audit write failed');
  });
}
