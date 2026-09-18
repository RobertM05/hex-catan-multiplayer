import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { sendEmail, buildPasswordResetEmail } from '../server/email.js';

describe('Transactional Email (Resend)', () => {
  it('throws EMAIL_NOT_CONFIGURED when RESEND_API_KEY is not set', async () => {
    await assert.rejects(
      () => sendEmail({ to: 'test@example.com', subject: 'Hi', html: '<p>Hi</p>', env: {} }),
      /EMAIL_NOT_CONFIGURED/
    );
  });

  it('builds password reset email with correct resetLink and appName', () => {
    const link = 'https://example.com/reset?token=xyz123';
    const email = buildPasswordResetEmail(link, 'HexSettlers Online');
    assert.match(email.subject, /Reset your HexSettlers Online password/);
    assert.match(email.html, /https:\/\/example.com\/reset\?token=xyz123/);
    assert.match(email.text, /https:\/\/example.com\/reset\?token=xyz123/);
  });
});
