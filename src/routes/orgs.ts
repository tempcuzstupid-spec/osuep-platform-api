import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../db/index.js';
import { organizations, locations, departments } from '../db/schema/index.js';
import { eq } from 'drizzle-orm';
import { requirePermission } from '../services/rbac.js';
import { recordAuditSafe } from '../services/audit.js';
import { getCtx } from '../plugins/request-context.js';
import { NotFoundError, BadRequestError } from '../plugins/error-handler.js';

const CreateOrgBody = z.object({
  name: z.string().min(1).max(200),
  type: z.string().min(1).max(50).optional(),
});

const UpdateOrgBody = z.object({
  name: z.string().min(1).max(200).optional(),
  type: z.string().min(1).max(50).optional(),
  settings: z.record(z.unknown()).optional(),
});

const CreateLocationBody = z.object({
  name: z.string().min(1).max(200),
  code: z.string().max(50).optional(),
  address1: z.string().max(200).optional(),
  city: z.string().max(100).optional(),
  region: z.string().max(100).optional(),
  postalCode: z.string().max(30).optional(),
  country: z.string().length(2).optional(),
  isPrimary: z.boolean().optional(),
});

const CreateDepartmentBody = z.object({
  name: z.string().min(1).max(200),
  code: z.string().max(50).optional(),
  locationId: z.string().uuid().optional(),
});

export async function orgRoutes(app: FastifyInstance) {
  /* ---------- Create new org (platform-admin style; for self-serve, see /register) ---------- */
  app.post('/', { preHandler: app.requireAuth }, async (req) => {
    const body = CreateOrgBody.parse(req.body);
    // Self-serve org creation happens via /api/auth/register.
    // This endpoint is reserved for platform admins creating orgs on behalf of customers.
    await requirePermission(req, 'org:create');
    return { ok: true, body };
  });

  /* ---------- Get current org ---------- */
  app.get('/current', { preHandler: app.requireAuth }, async (req) => {
    const ctx = getCtx(req);
    if (!ctx.orgId) throw new BadRequestError('No active org');
    const [org] = await db.select().from(organizations).where(eq(organizations.id, ctx.orgId)).limit(1);
    if (!org) throw new NotFoundError('Organization not found');
    return org;
  });

  app.patch('/current', { preHandler: app.requireAuth }, async (req) => {
    await requirePermission(req, 'org:update');
    const ctx = getCtx(req);
    if (!ctx.orgId) throw new BadRequestError('No active org');
    const body = UpdateOrgBody.parse(req.body);
    const [org] = await db
      .update(organizations)
      .set({
        ...(body.name ? { name: body.name } : {}),
        ...(body.type ? { type: body.type } : {}),
        ...(body.settings ? { settings: body.settings as any } : {}),
        updatedAt: new Date(),
      })
      .where(eq(organizations.id, ctx.orgId))
      .returning();
    recordAuditSafe(req, { action: 'org.updated', targetType: 'org', targetId: ctx.orgId, orgId: ctx.orgId });
    return org;
  });

  /* ---------- Locations ---------- */
  app.get('/current/locations', { preHandler: app.requireAuth }, async (req) => {
    await requirePermission(req, 'location:read');
    const ctx = getCtx(req);
    if (!ctx.orgId) throw new BadRequestError('No active org');
    return db.select().from(locations).where(eq(locations.orgId, ctx.orgId));
  });

  app.post('/current/locations', { preHandler: app.requireAuth }, async (req, reply) => {
    await requirePermission(req, 'location:create');
    const ctx = getCtx(req);
    if (!ctx.orgId) throw new BadRequestError('No active org');
    const body = CreateLocationBody.parse(req.body);
    const [loc] = await db
      .insert(locations)
      .values({ ...body, orgId: ctx.orgId })
      .returning();
    recordAuditSafe(req, { action: 'location.created', targetType: 'location', targetId: loc!.id, orgId: ctx.orgId });
    reply.status(201);
    return loc;
  });

  /* ---------- Departments ---------- */
  app.get('/current/departments', { preHandler: app.requireAuth }, async (req) => {
    await requirePermission(req, 'department:read');
    const ctx = getCtx(req);
    if (!ctx.orgId) throw new BadRequestError('No active org');
    return db.select().from(departments).where(eq(departments.orgId, ctx.orgId));
  });

  app.post('/current/departments', { preHandler: app.requireAuth }, async (req, reply) => {
    await requirePermission(req, 'department:create');
    const ctx = getCtx(req);
    if (!ctx.orgId) throw new BadRequestError('No active org');
    const body = CreateDepartmentBody.parse(req.body);
    const [dep] = await db
      .insert(departments)
      .values({ ...body, orgId: ctx.orgId })
      .returning();
    recordAuditSafe(req, { action: 'department.created', targetType: 'department', targetId: dep!.id, orgId: ctx.orgId });
    reply.status(201);
    return dep;
  });
}
