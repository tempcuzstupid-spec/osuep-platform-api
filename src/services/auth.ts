import { db } from '../db/index.js';
import { sessions, users, memberships, invitations, passwordResets, organizations } from '../db/schema';
import { eq, and, isNull } from 'drizzle-orm';
import { hash, verify } from '../auth/index.js';
import { createHash, randomBytes } from 'node:crypto';
import { env } from '../env.js';
import { BadRequestError, UnauthorizedError, ConflictError } from '../plugins/error-handler.js';
import { recordAudit } from './audit.js';
import type { FastifyRequest } from 'fastify';

/** Generate a 25-char base32-like opaque session ID (no external Lucia dep needed). */
function generateIdFromEntropySize(bytes: number): string {
  return randomBytes(bytes).toString('base64url').slice(0, Math.ceil(bytes * 1.6));
}

const SESSION_COOKIE = 'osuep_session';
const SESSION_TTL_DAYS = 30;

/**
 * Hash a token (for invites, password resets, email verifications).
 * Tokens are random, large-entropy, and one-shot.
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function newOpaqueToken(): string {
  return randomBytes(32).toString('base64url');
}

export function setSessionCookie(reply: any, sessionId: string) {
  reply.setCookie(SESSION_COOKIE, sessionId, {
    httpOnly: true,
    sameSite: 'lax',
    secure: env.NODE_ENV === 'production',
    path: '/',
    maxAge: 60 * 60 * 24 * SESSION_TTL_DAYS,
    signed: true,
  });
}

export function clearSessionCookie(reply: any) {
  reply.clearCookie(SESSION_COOKIE, { path: '/' });
}

export async function createSession(opts: {
  userId: string;
  ip: string;
  userAgent: string | undefined;
  pendingMfa?: boolean;
  activeOrgId?: string | null;
  activeMembershipId?: string | null;
}): Promise<{ id: string; expiresAt: Date }> {
  const id = generateIdFromEntropySize(25);
  const expiresAt = new Date(Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000);
  await db.insert(sessions).values({
    id,
    userId: opts.userId,
    state: opts.pendingMfa ? 'pending_mfa' : 'active',
    ip: opts.ip,
    userAgent: opts.userAgent,
    activeOrgId: opts.activeOrgId ?? null,
    activeMembershipId: opts.activeMembershipId ?? null,
    expiresAt,
  });
  return { id, expiresAt };
}

export async function loadSession(sessionId: string) {
  const [s] = await db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1);
  if (!s) return null;
  if (s.expiresAt < new Date()) {
    await db.update(sessions).set({ state: 'expired' }).where(eq(sessions.id, sessionId));
    return null;
  }
  if (s.state === 'revoked' || s.state === 'expired') return null;
  return s;
}

export async function touchSession(sessionId: string) {
  await db.update(sessions).set({ lastSeenAt: new Date() }).where(eq(sessions.id, sessionId));
}

export async function revokeSession(sessionId: string) {
  await db.update(sessions).set({ state: 'revoked' }).where(eq(sessions.id, sessionId));
}

/* ----------------------- Registration / login ----------------------- */

export async function registerOrgWithOwner(opts: {
  email: string;
  password: string;
  fullName: string;
  orgName: string;
  orgType?: string;
}) {
  // Check email not already used
  const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.email, opts.email)).limit(1);
  if (existing) throw new ConflictError('Email already registered');

  // Slugify org name
  const slug = (opts.orgName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'org')
    + '-' + randomBytes(3).toString('hex');

  const passwordHash = await hash(opts.password);

  // Create user + org + owner membership in a transaction
  return await db.transaction(async (tx) => {
    const [u] = await tx
      .insert(users)
      .values({
        email: opts.email,
        hashedPassword: passwordHash,
        fullName: opts.fullName,
        status: 'active',
        emailVerifiedAt: null,
      })
      .returning();
    if (!u) throw new Error('user insert failed');

    const [o] = await tx
      .insert(organizations)
      .values({
        name: opts.orgName,
        slug,
        type: opts.orgType ?? 'company',
      })
      .returning();
    if (!o) throw new Error('org insert failed');

    const [m] = await tx
      .insert(memberships)
      .values({
        userId: u.id,
        orgId: o.id,
        role: 'org_admin',
      })
      .returning();
    if (!m) throw new Error('membership insert failed');

    return { user: u, org: o, membership: m };
  });
}

export async function loginWithPassword(opts: { email: string; password: string }) {
  const [u] = await db.select().from(users).where(eq(users.email, opts.email)).limit(1);
  if (!u || !u.hashedPassword) throw new UnauthorizedError('Invalid email or password');
  if (u.status !== 'active') throw new UnauthorizedError('Account is not active');
  const ok = await verify(u.hashedPassword, opts.password);
  if (!ok) throw new UnauthorizedError('Invalid email or password');

  await db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, u.id));
  return u;
}

/* ----------------------- Password reset ----------------------- */

export async function createPasswordReset(email: string) {
  const [u] = await db.select().from(users).where(eq(users.email, email)).limit(1);
  // Always succeed silently to avoid user enumeration
  if (!u) return null;
  const token = newOpaqueToken();
  const tokenHash = hashToken(token);
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
  await db.insert(passwordResets).values({ userId: u.id, tokenHash, expiresAt });
  return { token, user: u };
}

export async function consumePasswordReset(token: string, newPassword: string) {
  const tokenHash = hashToken(token);
  const [r] = await db
    .select()
    .from(passwordResets)
    .where(and(eq(passwordResets.tokenHash, tokenHash), isNull(passwordResets.usedAt)))
    .limit(1);
  if (!r) throw new BadRequestError('Invalid or expired token');
  if (r.expiresAt < new Date()) throw new BadRequestError('Token expired');
  const passwordHash = await hash(newPassword);
  await db.transaction(async (tx) => {
    await tx.update(users).set({ hashedPassword: passwordHash }).where(eq(users.id, r.userId));
    await tx.update(passwordResets).set({ usedAt: new Date() }).where(eq(passwordResets.id, r.id));
  });
}

/* ----------------------- Invitations ----------------------- */

export async function createInvitation(opts: {
  orgId: string;
  email: string;
  role: 'org_admin' | 'buyer' | 'approver' | 'finance' | 'employee' | 'viewer';
  invitedBy: string;
  locationId?: string;
  departmentId?: string;
}) {
  const token = newOpaqueToken();
  const tokenHash = hashToken(token);
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  const [inv] = await db
    .insert(invitations)
    .values({
      orgId: opts.orgId,
      email: opts.email,
      role: opts.role,
      invitedBy: opts.invitedBy,
      locationId: opts.locationId,
      departmentId: opts.departmentId,
      tokenHash,
      expiresAt,
    })
    .returning();
  if (!inv) throw new Error('invite insert failed');
  return { token, invitation: inv };
}

export async function acceptInvitation(opts: { token: string; fullName: string; password: string; req: FastifyRequest }) {
  const tokenHash = hashToken(opts.token);
  const [inv] = await db
    .select()
    .from(invitations)
    .where(and(eq(invitations.tokenHash, tokenHash), isNull(invitations.acceptedAt)))
    .limit(1);
  if (!inv) throw new BadRequestError('Invalid or expired invitation');
  if (inv.expiresAt < new Date()) throw new BadRequestError('Invitation expired');

  const passwordHash = await hash(opts.password);

  return await db.transaction(async (tx) => {
    // Get or create user
    let [u] = await tx.select().from(users).where(eq(users.email, inv.email)).limit(1);
    if (!u) {
      [u] = await tx.insert(users).values({
        email: inv.email,
        hashedPassword: passwordHash,
        fullName: opts.fullName,
        status: 'active',
      }).returning();
      if (!u) throw new Error('user create failed');
    } else {
      // Add the password if they don't have one
      if (!u.hashedPassword) {
        await tx.update(users).set({ hashedPassword: passwordHash }).where(eq(users.id, u.id));
      }
    }

    // Create membership
    await tx.insert(memberships).values({
      userId: u.id,
      orgId: inv.orgId,
      role: inv.role as any,
      locationId: inv.locationId,
      departmentId: inv.departmentId,
    });

    // Mark invite accepted
    await tx
      .update(invitations)
      .set({ acceptedAt: new Date(), acceptedBy: u.id })
      .where(eq(invitations.id, inv.id));

    await recordAudit(opts.req, {
      action: 'invitation.accepted',
      targetType: 'invitation',
      targetId: inv.id,
      orgId: inv.orgId,
    });

    return { user: u, orgId: inv.orgId, role: inv.role };
  });
}

export { SESSION_COOKIE };
