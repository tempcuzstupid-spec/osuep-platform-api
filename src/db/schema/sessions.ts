import { pgTable, text, timestamp, uuid, varchar, index, jsonb } from 'drizzle-orm/pg-core';
import { users } from './users';

/**
 * Sessions — server-side session store.
 * Per Vol VI: "Session management as part of secure auth design."
 *
 * Cookie holds an opaque session ID; the rest lives here.
 * MFA state is tracked per-session: a session that hasn't completed MFA is
 * `pending_mfa` and has restricted permissions until the user provides TOTP.
 */
export const sessions = pgTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    state: varchar('state', { length: 20 }).notNull().default('active'),
    // 'active' | 'pending_mfa' | 'expired' | 'revoked'

    ip: varchar('ip', { length: 64 }),
    userAgent: text('user_agent'),

    // Active org context (user may belong to many)
    activeOrgId: uuid('active_org_id'),
    activeMembershipId: uuid('active_membership_id'),

    // Per-session metadata (e.g. cart id, last seen path)
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userIdx: index('sessions_user_idx').on(t.userId),
    expiresIdx: index('sessions_expires_idx').on(t.expiresAt),
  }),
);

export type Session = typeof sessions.$inferSelect;
export type NewSession = typeof sessions.$inferInsert;

/**
 * Password reset tokens
 */
export const passwordResets = pgTable('password_resets', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  tokenHash: text('token_hash').notNull().unique(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  usedAt: timestamp('used_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export type PasswordReset = typeof passwordResets.$inferSelect;

/**
 * Email verification tokens
 */
export const emailVerifications = pgTable('email_verifications', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  tokenHash: text('token_hash').notNull().unique(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  usedAt: timestamp('used_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export type EmailVerification = typeof emailVerifications.$inferSelect;
