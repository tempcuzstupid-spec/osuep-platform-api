import { db } from '../db/index.js';
import { rolePermissions, type Role } from '../db/schema/index.js'
import { sql } from 'drizzle-orm';
import { ForbiddenError } from '../plugins/error-handler.js';
import type { FastifyRequest } from 'fastify';
import { getCtx } from '../plugins/request-context.js';

/**
 * Per Vol III: "Granular RBAC with segregation-of-duties checks."
 * Returns the set of permission keys available to the active role on this request.
 */
export async function getPermissionsForActiveRole(req: FastifyRequest): Promise<Set<string>> {
  const role = (req as any).activeRole as Role | undefined;
  if (!role) return new Set();
  const rows = await db
    .select({ permissionKey: rolePermissions.permissionKey })
    .from(rolePermissions)
    .where(sql`${rolePermissions.role} = ${role}`);
  return new Set(rows.map((r) => r.permissionKey));
}

/** Throws ForbiddenError if the active role lacks the given permission. */
export async function requirePermission(req: FastifyRequest, permissionKey: string): Promise<void> {
  const perms = await getPermissionsForActiveRole(req);
  if (!perms.has(permissionKey)) {
    throw new ForbiddenError(`Missing permission: ${permissionKey}`);
  }
}

/** Returns true if the active role has the permission. Does not throw. */
export async function hasPermission(req: FastifyRequest, permissionKey: string): Promise<boolean> {
  const perms = await getPermissionsForActiveRole(req);
  return perms.has(permissionKey);
}
