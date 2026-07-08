import { Resend } from 'resend';
import { env } from '../env.js';

let resend: Resend | null = null;
function getClient(): Resend | null {
  if (!env.RESEND_API_KEY) return null;
  if (!resend) resend = new Resend(env.RESEND_API_KEY);
  return resend;
}

export type EmailParams = {
  to: string;
  subject: string;
  html: string;
  text?: string;
};

export async function sendEmail(params: EmailParams): Promise<{ ok: boolean; id?: string; error?: string }> {
  const client = getClient();
  if (!client) {
    // In dev/test without a Resend key, log and report.
    // eslint-disable-next-line no-console
    console.warn('[email] RESEND_API_KEY not set; would have sent:', {
      to: params.to,
      subject: params.subject,
    });
    return { ok: true, id: 'mock-no-key' };
  }
  try {
    const result = await client.emails.send({
      from: env.EMAIL_FROM,
      to: params.to,
      subject: params.subject,
      html: params.html,
      text: params.text,
      reply_to: env.EMAIL_REPLY_TO,
    });
    if (result.error) {
      return { ok: false, error: result.error.message };
    }
    return { ok: true, id: result.data?.id };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'unknown' };
  }
}

// ---- Templates --------------------------------------------------------

export function welcomeEmail(opts: { fullName?: string; orgName: string; setPasswordUrl: string }): EmailParams {
  const greeting = opts.fullName ? `Hi ${opts.fullName},` : 'Welcome,';
  return {
    to: '', // filled by caller
    subject: `Welcome to ${opts.orgName} on One Stop Uniforms`,
    html: `<!doctype html>
<html><body style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#0a0612;color:#e8e1f5;padding:32px">
  <table width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto">
    <tr><td>
      <h1 style="color:#c9a2ff;margin:0 0 16px">${greeting}</h1>
      <p>You've been added to <strong style="color:#fff">${opts.orgName}</strong> on the One Stop Uniforms Enterprise Platform.</p>
      <p>Set your password to activate your account and get started.</p>
      <p style="margin:32px 0">
        <a href="${opts.setPasswordUrl}" style="background:linear-gradient(135deg,#a855f7,#7c3aed);color:#fff;padding:14px 24px;border-radius:8px;text-decoration:none;font-weight:600;display:inline-block">Set your password</a>
      </p>
      <p style="color:#9a8fbf;font-size:13px">If you didn't expect this email, you can safely ignore it.</p>
    </td></tr>
  </table>
</body></html>`,
    text: `${greeting}\n\nYou've been added to ${opts.orgName}. Set your password: ${opts.setPasswordUrl}`,
  };
}

export function passwordResetEmail(opts: { fullName?: string; resetUrl: string }): EmailParams {
  const greeting = opts.fullName ? `Hi ${opts.fullName},` : 'Hi,';
  return {
    to: '',
    subject: 'Reset your One Stop Uniforms password',
    html: `<!doctype html>
<html><body style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#0a0612;color:#e8e1f5;padding:32px">
  <table width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto">
    <tr><td>
      <h1 style="color:#c9a2ff;margin:0 0 16px">${greeting}</h1>
      <p>Click the button below to reset your password. The link expires in 1 hour.</p>
      <p style="margin:32px 0">
        <a href="${opts.resetUrl}" style="background:linear-gradient(135deg,#a855f7,#7c3aed);color:#fff;padding:14px 24px;border-radius:8px;text-decoration:none;font-weight:600;display:inline-block">Reset password</a>
      </p>
      <p style="color:#9a8fbf;font-size:13px">If you didn't request this, you can safely ignore this email.</p>
    </td></tr>
  </table>
</body></html>`,
    text: `${greeting}\n\nReset your password: ${opts.resetUrl}\n\nThis link expires in 1 hour.`,
  };
}
