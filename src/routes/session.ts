import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../db/index.js';
import { sessions, memberships } from '../db/index.js';
import { and, eq } from 'drizzle-orm';
import { SESSION_COOKIE } from '../services/auth.js';
import { getCtx } from '../plugins/request-context.js';
import { BadRequestError, ForbiddenError } from '../plugins/error-handler.js';
import { recordAuditSafe } from '../services/audit.js';

const Body = z.object({ orgId: z.string().uuid() });

export async function setActiveOrgRoutes(app: FastifyInstance) {
  /* Switch active org (a user can belong to many) */
  app.post('/active-org', { preHandler: app.requireAuth }, async (req, reply) => {
    const { orgId } = Body.parse(req.body);
    const ctx = getCtx(req);
    if (!ctx.userId) throw new BadRequestError('Not signed in');
    // Verify user is a member of the requested org
    const [m] = await db
      .select()
      .from(memberships)
      .where(and(eq(memberships.userId, ctx.userId), eq(memberships.orgId, orgId)))
      .limit(1);
    if (!m) throw new ForbiddenError('Not a member of this organization');
    const raw = req.cookies[SESSION_COOKIE];
    if (!raw) throw new BadRequestError('No session');
    const unsigned = req.unsignCookie(raw);
    if (!unsigned.valid) throw new BadRequestError('Invalid session');
    const sid = unsigned.value;
    await db
      .update(sessions)
      .set({ activeOrgId: orgId, activeMembershipId: m.id })
      .where(eq(sessions.id, sid));
    recordAuditSafe(req, { action: 'session.active_org_changed', targetType: 'org', targetId: orgId, orgId });
    return { ok: true, activeOrgId: orgId, activeMembershipId: m.id, role: m.role };
  });
}
