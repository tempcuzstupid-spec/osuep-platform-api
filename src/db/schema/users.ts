import { pgTable, text, timestamp, uuid, varchar, boolean, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { organizations, locations, departments } from './orgs.js';

/**
 * Users — individuals who can sign in.
 * A user can belong to multiple orgs (e.g. a consultant) via memberships.
 */
export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: varchar('email', { length: 320 }).notNull().unique(),
    emailVerifiedAt: timestamp('email_verified_at', { withTimezone: true }),
    // Auth — Lucia-style
    hashedPassword: text('hashed_password'), // null until password set
    // MFA
    mfaEnabled: boolean('mfa_enabled').notNull().default(false),
    mfaSecret: text('mfa_secret'), // TOTP base32, null until enrolled
    mfaEnrolledAt: timestamp('mfa_enrolled_at', { withTimezone: true }),
    // Profile
    fullName: varchar('full_name', { length: 200 }),
    jobTitle: varchar('job_title', { length: 200 }),
    phone: varchar('phone', { length: 50 }),
    avatarUrl: varchar('avatar_url', { length: 500 }),

    // Status
    status: varchar('status', { length: 20 }).notNull().default('active'),
    // 'active' | 'invited' | 'suspended' | 'archived'

    // System / global admin flag (for One Stop Uniforms staff)
    isPlatformAdmin: boolean('is_platform_admin').notNull().default(false),

    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    emailIdx: uniqueIndex('users_email_idx').on(t.email),
  }),
);

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;

/**
 * Memberships — link a user to an org with a role and optional location/department scoping.
 * Per Vol II: "buyers, approvers, finance contacts" — all modeled here.
 */
export const memberships = pgTable(
  'memberships',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),

    // Optional scoping
    locationId: uuid('location_id').references(() => locations.id, { onDelete: 'set null' }),
    departmentId: uuid('department_id').references(() => departments.id, { onDelete: 'set null' }),

    // Role within this org
    role: varchar('role', { length: 50 }).notNull(),
    // 'org_admin' | 'buyer' | 'approver' | 'finance' | 'employee' | 'viewer'

    // Per-membership spending limits / approval caps (Vol II/III)
    spendingLimitCents: text('spending_limit_cents'), // bigint-style as string for portability
    requiresApprovalOverCents: text('requires_approval_over_cents'),

    status: varchar('status', { length: 20 }).notNull().default('active'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userOrgIdx: uniqueIndex('memberships_user_org_idx').on(t.userId, t.orgId),
    orgIdx: index('memberships_org_idx').on(t.orgId),
  }),
);

export type Membership = typeof memberships.$inferSelect;
export type NewMembership = typeof memberships.$inferInsert;

export const ROLES = ['org_admin', 'buyer', 'approver', 'finance', 'employee', 'viewer'] as const;
export type Role = (typeof ROLES)[number];

/**
 * Invitations — pending user invites.
 */
export const invitations = pgTable(
  'invitations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    email: varchar('email', { length: 320 }).notNull(),
    role: varchar('role', { length: 50 }).notNull(),
    locationId: uuid('location_id').references(() => locations.id, { onDelete: 'set null' }),
    departmentId: uuid('department_id').references(() => departments.id, { onDelete: 'set null' }),
    tokenHash: text('token_hash').notNull().unique(),
    invitedBy: uuid('invited_by').references(() => users.id),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    acceptedBy: uuid('accepted_by').references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tokenIdx: uniqueIndex('invitations_token_idx').on(t.tokenHash),
    orgEmailIdx: index('invitations_org_email_idx').on(t.orgId, t.email),
  }),
);

export type Invitation = typeof invitations.$inferSelect;
export type NewInvitation = typeof invitations.$inferInsert;
