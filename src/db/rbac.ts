import { pgTable, varchar, text, timestamp, uuid, index, primaryKey, jsonb } from 'drizzle-orm/pg-core';

/**
 * Permissions — atomic capability identifiers.
 * Format: `<domain>:<action>` e.g. `org:read`, `order:approve`, `product:create`
 */
export const permissions = pgTable('permissions', {
  key: varchar('key', { length: 100 }).primaryKey(),
  domain: varchar('domain', { length: 50 }).notNull(),
  action: varchar('action', { length: 50 }).notNull(),
  description: text('description'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export type Permission = typeof permissions.$inferSelect;

/**
 * Role permissions — what each platform role can do.
 * Pre-seeded with sensible defaults; orgs can also define their own custom roles.
 */
export const rolePermissions = pgTable(
  'role_permissions',
  {
    role: varchar('role', { length: 50 }).notNull(),
    permissionKey: varchar('permission_key', { length: 100 })
      .notNull()
      .references(() => permissions.key, { onDelete: 'cascade' }),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.role, t.permissionKey] }),
    roleIdx: index('role_permissions_role_idx').on(t.role),
  }),
);

/**
 * Audit log — append-only, immutable record of every privileged action.
 * Per Vol III: "Audit Logs & Activity History — Immutable audit trail with
 * replayable action timelines."
 *
 * Immutability is enforced at the DB level via a trigger (added in a migration)
 * that REJECTs any UPDATE or DELETE.
 */
export const auditEvents = pgTable(
  'audit_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // Who
    actorUserId: uuid('actor_user_id'),
    actorMembershipId: uuid('actor_membership_id'),
    actorIp: varchar('actor_ip', { length: 64 }),
    actorUserAgent: text('actor_user_agent'),
    // Scope
    orgId: uuid('org_id'),
    // What
    action: varchar('action', { length: 100 }).notNull(),
    // e.g. 'org.created', 'user.invited', 'order.approved', 'auth.login.failed'
    targetType: varchar('target_type', { length: 50 }),
    targetId: varchar('target_id', { length: 100 }),
    // Context
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    // When
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    orgIdx: index('audit_org_idx').on(t.orgId, t.occurredAt),
    actorIdx: index('audit_actor_idx').on(t.actorUserId, t.occurredAt),
    actionIdx: index('audit_action_idx').on(t.action, t.occurredAt),
  }),
);

export type AuditEvent = typeof auditEvents.$inferSelect;
export type NewAuditEvent = typeof auditEvents.$inferInsert;
