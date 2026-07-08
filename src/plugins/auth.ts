import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import fp from 'fastify-plugin';
import { loadSession, SESSION_COOKIE, touchSession } from '../services/auth.js';
import { getCtx } from './request-context.js';
import { UnauthorizedError } from './error-handler.js';
import { db } from '../db/index.js';
import { memberships } from '../db/index.js';
import { eq, and } from 'drizzle-orm';

declare module 'fastify' {
  interface FastifyInstance {
    requireAuth: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requireSession: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

const authPluginImpl = async (app: FastifyInstance) => {
  /**
   * Requires a valid signed session cookie. Throws UnauthorizedError otherwise.
   * Populates ctx.userId and ctx.membershipId and (req as any).activeRole.
   */
  app.decorate('requireAuth', async function (req: FastifyRequest, _reply: FastifyReply) {
    const sid = req.cookies[SESSION_COOKIE];
    if (!sid) throw new UnauthorizedError('Not signed in');
    const session = await loadSession(sid);
    if (!session) throw new UnauthorizedError('Session expired');
    if (session.state === 'pending_mfa') throw new UnauthorizedError('MFA required');
    await touchSession(sid);
    const ctx = getCtx(req);
    ctx.userId = session.userId;
    ctx.membershipId = session.activeMembershipId ?? undefined;
    ctx.orgId = session.activeOrgId ?? undefined;
    if (session.activeMembershipId) {
      const [m] = await db
        .select({ role: memberships.role })
        .from(memberships)
        .where(and(eq(memberships.id, session.activeMembershipId), eq(memberships.userId, session.userId)))
        .limit(1);
      (req as any).activeRole = m?.role;
    }
  });

  /**
   * Soft: parses session if present, populates ctx, but does not require.
   */
  app.decorate('requireSession', async function (req: FastifyRequest, _reply: FastifyReply) {
    const sid = req.cookies[SESSION_COOKIE];
    if (!sid) return;
    const session = await loadSession(sid);
    if (!session) return;
    await touchSession(sid);
    const ctx = getCtx(req);
    ctx.userId = session.userId;
    ctx.membershipId = session.activeMembershipId ?? undefined;
    ctx.orgId = session.activeOrgId ?? undefined;
    if (session.activeMembershipId) {
      const [m] = await db
        .select({ role: memberships.role })
        .from(memberships)
        .where(and(eq(memberships.id, session.activeMembershipId), eq(memberships.userId, session.userId)))
        .limit(1);
      (req as any).activeRole = m?.role;
    }
  });
}

export const authPlugin = fp(authPluginImpl, { name: 'authPlugin' });
