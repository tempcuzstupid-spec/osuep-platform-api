import type { FastifyInstance } from 'fastify';
import { db } from '../db/index.js';
import { users, memberships, organizations } from '../db/schema/index.js';
import { eq, and } from 'drizzle-orm';
import { requirePermission } from '../services/rbac.js';
import { getCtx } from '../plugins/request-context.js';
import { BadRequestError } from '../plugins/error-handler.js';

export async function userRoutes(app: FastifyInstance) {
  /* List users in the active org */
  app.get('/', { preHandler: app.requireAuth }, async (req) => {
    await requirePermission(req, 'user:read');
    const ctx = getCtx(req);
    if (!ctx.orgId) throw new BadRequestError('No active org');
    return db
      .select({
        userId: users.id,
        email: users.email,
        fullName: users.fullName,
        jobTitle: users.jobTitle,
        status: users.status,
        role: memberships.role,
        membershipId: memberships.id,
        mfaEnabled: users.mfaEnabled,
        lastLoginAt: users.lastLoginAt,
      })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(eq(memberships.orgId, ctx.orgId));
  });
}
