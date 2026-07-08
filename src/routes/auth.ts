import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../db/index.js';
import { users, memberships, organizations, invitations } from '../db/index.js';
import { eq, and, isNull } from 'drizzle-orm';
import { env } from '../env.js';
import { BadRequestError, UnauthorizedError } from '../plugins/error-handler.js';
import { getCtx } from '../plugins/request-context.js';
import {
  registerOrgWithOwner,
  loginWithPassword,
  createSession,
  loadSession,
  touchSession,
  revokeSession,
  setSessionCookie,
  clearSessionCookie,
  SESSION_COOKIE,
  createPasswordReset,
  consumePasswordReset,
  createInvitation,
  acceptInvitation,
} from '../services/auth.js';
import { recordAuditSafe } from '../services/audit.js';
import { requirePermission } from '../services/rbac.js';
import { sendEmail, welcomeEmail, passwordResetEmail } from '../services/email.js';

const RegisterBody = z.object({
  email: z.string().email(),
  password: z.string().min(10).max(200),
  fullName: z.string().min(1).max(200),
  orgName: z.string().min(1).max(200),
  orgType: z.string().optional(),
});

const LoginBody = z.object({
  email: z.string().email(),
  password: z.string(),
});

const ForgotBody = z.object({ email: z.string().email() });
const ResetBody = z.object({ token: z.string(), password: z.string().min(10).max(200) });

const InviteBody = z.object({
  email: z.string().email(),
  role: z.enum(['org_admin', 'buyer', 'approver', 'finance', 'employee', 'viewer']),
  locationId: z.string().uuid().optional(),
  departmentId: z.string().uuid().optional(),
});
const AcceptInviteBody = z.object({
  token: z.string(),
  fullName: z.string().min(1).max(200),
  password: z.string().min(10).max(200),
});

export async function authRoutes(app: FastifyInstance) {
  /* ---------- Register (creates org + owner) ---------- */
  app.post('/register', async (req, reply) => {
    const body = RegisterBody.parse(req.body);
    const { user, org, membership } = await registerOrgWithOwner(body);
    const ctx = getCtx(req);
    const { id: sessionId } = await createSession({
      userId: user.id,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      activeOrgId: org.id,
      activeMembershipId: membership.id,
    });
    setSessionCookie(reply, sessionId);
    recordAuditSafe(req, { action: 'user.registered', targetType: 'user', targetId: user.id, orgId: org.id });
    recordAuditSafe(req, { action: 'org.created', targetType: 'org', targetId: org.id, orgId: org.id });
    reply.status(201);
    return { user: { id: user.id, email: user.email, fullName: user.fullName }, org, membership: { id: membership.id, role: membership.role } };
  });

  /* ---------- Login ---------- */
  app.post('/login', async (req, reply) => {
    const body = LoginBody.parse(req.body);
    const user = await loginWithPassword({ email: body.email, password: body.password });
    const ctx = getCtx(req);
    const { id: sessionId } = await createSession({
      userId: user.id,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
    setSessionCookie(reply, sessionId);
    recordAuditSafe(req, { action: 'auth.login.succeeded', targetType: 'user', targetId: user.id });
    return { user: { id: user.id, email: user.email, fullName: user.fullName, mfaEnabled: user.mfaEnabled } };
  });

  /* ---------- Logout ---------- */
  app.post('/logout', async (req, reply) => {
    const raw = req.cookies[SESSION_COOKIE];
    if (raw) {
      const unsigned = req.unsignCookie(raw);
      if (unsigned.valid) {
        try {
          await revokeSession(unsigned.value);
        } catch {}
      }
    }
    clearSessionCookie(reply);
    return { ok: true };
  });

  /* ---------- Forgot password ---------- */
  app.post('/forgot', async (req) => {
    const body = ForgotBody.parse(req.body);
    const result = await createPasswordReset(body.email);
    if (result) {
      const url = `${env.WEB_ORIGIN}/reset?token=${result.token}`;
      const tpl = passwordResetEmail({ fullName: result.user.fullName ?? undefined, resetUrl: url });
      await sendEmail({ ...tpl, to: result.user.email });
      recordAuditSafe(req, { action: 'auth.password_reset.requested', targetType: 'user', targetId: result.user.id });
    }
    // Always return ok
    return { ok: true };
  });

  /* ---------- Reset password ---------- */
  app.post('/reset', async (req) => {
    const body = ResetBody.parse(req.body);
    await consumePasswordReset(body.token, body.password);
    return { ok: true };
  });

  /* ---------- Me (current session) ---------- */
  app.get('/me', async (req) => {
    const raw = req.cookies[SESSION_COOKIE];
    if (!raw) throw new UnauthorizedError('Not signed in');
    const unsigned = req.unsignCookie(raw);
    if (!unsigned.valid) throw new UnauthorizedError('Invalid session signature');
    const sid = unsigned.value;
    const session = await loadSession(sid);
    if (!session) throw new UnauthorizedError('Session expired');
    await touchSession(sid);
    const [u] = await db.select().from(users).where(eq(users.id, session.userId)).limit(1);
    if (!u) throw new UnauthorizedError('User not found');
    // List memberships
    const mems = await db
      .select({
        membershipId: memberships.id,
        orgId: memberships.orgId,
        role: memberships.role,
        orgName: organizations.name,
        orgSlug: organizations.slug,
        orgType: organizations.type,
      })
      .from(memberships)
      .innerJoin(organizations, eq(organizations.id, memberships.orgId))
      .where(and(eq(memberships.userId, u.id), eq(memberships.status, 'active')));
    return {
      user: {
        id: u.id,
        email: u.email,
        fullName: u.fullName,
        jobTitle: u.jobTitle,
        mfaEnabled: u.mfaEnabled,
        isPlatformAdmin: u.isPlatformAdmin,
      },
      session: {
        id: session.id,
        state: session.state,
        activeOrgId: session.activeOrgId,
        activeMembershipId: session.activeMembershipId,
      },
      memberships: mems,
    };
  });

  /* ---------- Invitations ---------- */
  app.post('/invitations', { preHandler: app.requireAuth }, async (req) => {
    await requirePermission(req, 'user:invite');
    const body = InviteBody.parse(req.body);
    const ctx = getCtx(req);
    if (!ctx.orgId) throw new BadRequestError('No active org');
    const inv = await createInvitation({
      orgId: ctx.orgId,
      email: body.email,
      role: body.role,
      invitedBy: ctx.userId!,
      locationId: body.locationId,
      departmentId: body.departmentId,
    });
    const url = `${env.WEB_ORIGIN}/invite?token=${inv.token}`;
    const org = await db.select().from(organizations).where(eq(organizations.id, ctx.orgId)).limit(1);
    const tpl = welcomeEmail({ orgName: org[0]?.name ?? 'your organization', setPasswordUrl: url });
    await sendEmail({ ...tpl, to: body.email });
    recordAuditSafe(req, { action: 'user.invited', targetType: 'user', targetId: body.email, orgId: ctx.orgId, metadata: { role: body.role } });
    return { id: inv.invitation.id, email: body.email, role: body.role, expiresAt: inv.invitation.expiresAt };
  });

  app.post('/invitations/accept', async (req) => {
    const body = AcceptInviteBody.parse(req.body);
    const { user, orgId, role } = await acceptInvitation({ ...body, req });
    return { user: { id: user.id, email: user.email, fullName: user.fullName }, orgId, role };
  });
}
