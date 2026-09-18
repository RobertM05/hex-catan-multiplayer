/**
 * email.js
 * Thin wrapper around the Resend HTTP API for transactional emails.
 * No SDK required — pure fetch. Set RESEND_API_KEY in the environment.
 */

const RESEND_API = 'https://api.resend.com/emails';

/**
 * Send a transactional email via Resend.
 * @param {object} opts
 * @param {string}   opts.to        – recipient email
 * @param {string}   opts.subject   – email subject
 * @param {string}   opts.html      – HTML body
 * @param {string}  [opts.text]     – plain-text fallback
 * @param {string}  [opts.from]     – override sender (defaults to EMAIL_FROM env)
 * @param {object}  [opts.env]      – injectable env (for tests)
 * @returns {Promise<{ id: string }>}
 */
export async function sendEmail({ to, subject, html, text, from, env = process.env } = {}) {
  const apiKey = env.RESEND_API_KEY;
  if (!apiKey) throw new Error('EMAIL_NOT_CONFIGURED');

  const sender = from || env.EMAIL_FROM || 'noreply@hexcatan.online';

  const res = await fetch(RESEND_API, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: sender,
      to: [to],
      subject,
      html,
      ...(text ? { text } : {})
    })
  });

  if (!res.ok) {
    const body = await res.text();
    const err = new Error(`EMAIL_SEND_FAILED`);
    err.status = res.status;
    err.details = body;
    throw err;
  }

  return res.json();
}

/**
 * Build a password-reset email body.
 * @param {string} resetLink – full URL including token
 * @param {string} [appName]
 * @returns {{ subject: string, html: string, text: string }}
 */
export function buildPasswordResetEmail(resetLink, appName = 'HexSettlers Online') {
  const subject = `Reset your ${appName} password`;
  const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>${subject}</title></head>
<body style="font-family:Arial,sans-serif;background:#0f172a;color:#e2e8f0;margin:0;padding:0;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#0f172a;padding:40px 0;">
    <tr><td align="center">
      <table width="480" cellpadding="0" cellspacing="0"
             style="background:#1e293b;border-radius:12px;padding:40px;border:1px solid #334155;">
        <tr><td>
          <h1 style="margin:0 0 8px;font-size:28px;color:#f8fafc;text-align:center;">
            🏰 ${appName}
          </h1>
          <h2 style="margin:0 0 24px;font-size:18px;color:#94a3b8;font-weight:400;text-align:center;">
            Password Reset Request
          </h2>
          <p style="color:#cbd5e1;margin:0 0 16px;line-height:1.6;">
            We received a request to reset your password. Click the button below to choose a new one.
          </p>
          <p style="text-align:center;margin:32px 0;">
            <a href="${resetLink}"
               style="background:linear-gradient(135deg,#6366f1,#8b5cf6);color:#fff;
                      text-decoration:none;padding:14px 32px;border-radius:8px;
                      font-size:16px;font-weight:600;display:inline-block;">
              Reset Password
            </a>
          </p>
          <p style="color:#64748b;font-size:13px;margin:24px 0 0;line-height:1.6;">
            This link expires in <strong>1 hour</strong>. If you didn't request a password reset,
            you can safely ignore this email.
          </p>
          <hr style="border:none;border-top:1px solid #334155;margin:24px 0;">
          <p style="color:#475569;font-size:12px;margin:0;text-align:center;">
            ${appName} · Sent via Resend
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

  const text = `Reset your ${appName} password\n\n` +
    `Click the link below to choose a new password:\n${resetLink}\n\n` +
    `This link expires in 1 hour. If you didn't request a reset, ignore this email.`;

  return { subject, html, text };
}
