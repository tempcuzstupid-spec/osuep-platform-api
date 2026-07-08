import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../db/index.js';
import { auditEvents } from '../db/schema/index.js'
import { and, desc, eq, gte, lte } from 'drizzle-orm';
import { requirePermission } from '../services/rbac.js';
import { getCtx } from '../plugins/request-context.js';
import { BadRequestError } from '../plugins/error-handler.js';

const QuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(100),
  before: z.string().datetime().optional(),
  since: z.string().datetime().optional(),
  action: z.string().optional(),
});

export async function auditRoutes(app: FastifyInstance) {
  app.get('/', { preHandler: app.requireAuth }, async (req) => {
    await requirePermission(req, 'audit:read');
    const ctx = getCtx(req);
    if (!ctx.orgId) throw new BadRequestError('No active org');
    const q = QuerySchema.parse(req.query);
    const where = [eq(auditEvents.orgId, ctx.orgId)];
    if (q.before) where.push(lte(auditEvents.occurredAt, new Date(q.before)));
    if (q.since) where.push(gte(auditEvents.occurredAt, new Date(q.since)));
    if (q.action) where.push(eq(auditEvents.action, q.action));
    return db
      .select()
      .from(auditEvents)
      .where(and(...where))
      .orderBy(desc(auditEvents.occurredAt))
      .limit(q.limit);
  });
}
