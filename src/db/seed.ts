import { db } from './client.js';
import { permissions, rolePermissions } from './schema/index.js';

/**
 * Seed the canonical permission set + role → permission matrix.
 * Idempotent: safe to run on every deploy.
 */
const ALL_PERMISSIONS: Array<{ key: string; domain: string; action: string; description: string }> = [
  // Organization
  { key: 'org:read', domain: 'org', action: 'read', description: 'View organization details' },
  { key: 'org:create', domain: 'org', action: 'create', description: 'Create an organization' },
  { key: 'org:update', domain: 'org', action: 'update', description: 'Edit organization settings' },
  { key: 'org:delete', domain: 'org', action: 'delete', description: 'Archive an organization' },

  // Location
  { key: 'location:read', domain: 'location', action: 'read', description: 'View locations' },
  { key: 'location:create', domain: 'location', action: 'create', description: 'Create a location' },
  { key: 'location:update', domain: 'location', action: 'update', description: 'Edit a location' },
  { key: 'location:delete', domain: 'location', action: 'delete', description: 'Delete a location' },

  // Department
  { key: 'department:read', domain: 'department', action: 'read', description: 'View departments' },
  { key: 'department:create', domain: 'department', action: 'create', description: 'Create a department' },
  { key: 'department:update', domain: 'department', action: 'update', description: 'Edit a department' },
  { key: 'department:delete', domain: 'department', action: 'delete', description: 'Delete a department' },

  // User / membership
  { key: 'user:read', domain: 'user', action: 'read', description: 'View users in org' },
  { key: 'user:invite', domain: 'user', action: 'invite', description: 'Invite a user' },
  { key: 'user:update', domain: 'user', action: 'update', description: 'Edit a user' },
  { key: 'user:remove', domain: 'user', action: 'remove', description: 'Remove a user from org' },
  { key: 'user:assign_role', domain: 'user', action: 'assign_role', description: 'Change a user role' },

  // Audit
  { key: 'audit:read', domain: 'audit', action: 'read', description: 'View audit log' },
  { key: 'audit:export', domain: 'audit', action: 'export', description: 'Export audit log' },

  // Reporting
  { key: 'report:read', domain: 'report', action: 'read', description: 'View reports' },
  { key: 'report:export', domain: 'report', action: 'export', description: 'Export reports' },

  // Catalog (P1 — declared now so RBAC is forward-compatible)
  { key: 'catalog:read', domain: 'catalog', action: 'read', description: 'View the product catalog' },
  { key: 'catalog:admin', domain: 'catalog', action: 'admin', description: 'Manage the product catalog' },

  // Orders (P2)
  { key: 'order:create', domain: 'order', action: 'create', description: 'Create orders' },
  { key: 'order:read_own', domain: 'order', action: 'read_own', description: 'View own orders' },
  { key: 'order:read_org', domain: 'order', action: 'read_org', description: 'View org orders' },
  { key: 'order:approve', domain: 'order', action: 'approve', description: 'Approve an order' },
  { key: 'order:admin', domain: 'order', action: 'admin', description: 'Administer orders' },

  // Production (P4)
  { key: 'production:read', domain: 'production', action: 'read', description: 'View production queue' },
  { key: 'production:manage', domain: 'production', action: 'manage', description: 'Manage production' },
];

/**
 * Role → permission matrix.
 * Each role inherits everything in its array.
 */
const ROLE_PERMISSIONS: Record<string, string[]> = {
  org_admin: ALL_PERMISSIONS.map((p) => p.key), // every permission
  finance: [
    'org:read', 'location:read', 'department:read', 'user:read',
    'audit:read', 'report:read', 'report:export',
    'catalog:read',
    'order:read_org', 'order:approve',
  ],
  approver: [
    'org:read', 'location:read', 'department:read', 'user:read',
    'report:read',
    'catalog:read',
    'order:read_org', 'order:approve',
  ],
  buyer: [
    'org:read', 'location:read', 'department:read', 'user:read',
    'catalog:read',
    'order:create', 'order:read_own',
  ],
  employee: [
    'org:read', 'location:read', 'department:read',
    'catalog:read',
    'order:read_own',
  ],
  viewer: [
    'org:read', 'location:read', 'department:read',
    'catalog:read',
  ],
};

async function main() {
  console.log('Seeding permissions…');
  for (const p of ALL_PERMISSIONS) {
    await db
      .insert(permissions)
      .values(p)
      .onConflictDoUpdate({
        target: permissions.key,
        set: { domain: p.domain, action: p.action, description: p.description },
      });
  }
  console.log(`  ${ALL_PERMISSIONS.length} permissions seeded.`);

  console.log('Seeding role → permission matrix…');
  for (const [role, perms] of Object.entries(ROLE_PERMISSIONS)) {
    for (const permissionKey of perms) {
      await db
        .insert(rolePermissions)
        .values({ role, permissionKey })
        .onConflictDoNothing();
    }
    console.log(`  ${role}: ${perms.length} permissions`);
  }

  console.log('Done.');
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
