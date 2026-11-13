import type { Config } from './config.js';

export type EmailSender = (to: string, subject: string, html: string, text: string) => Promise<void>;

/** Resend (https://resend.com) when RESEND_API_KEY is set. Without a key, dev mode prints emails to the log. */
export function makeEmailSender(cfg: Config): EmailSender {
  if (cfg.resendApiKey) {
    const key = cfg.resendApiKey;
    return async (to, subject, html, text) => {
      const r = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: cfg.emailFrom, to: [to], subject, html, text }),
      });
      if (!r.ok) throw new Error(`Resend rejected the email (${r.status}): ${(await r.text()).slice(0, 200)}`);
    };
  }
  if (!cfg.production) {
    return async (to, subject, _html, text) => {
      console.log(`\n[dev email] To: ${to}\n[dev email] Subject: ${subject}\n${text}\n`);
    };
  }
  return async () => { throw new Error('RESEND_API_KEY is not configured'); };
}

const esc = (s: string) => s.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);

export function verificationEmail(link: string, name?: string | null) {
  const hi = name ? `Hi ${name},` : 'Hi,';
  return {
    subject: 'Confirm your email for Pathy Studio',
    text: `${hi}\n\nConfirm your email to activate your Pathy account and use the AI features:\n${link}\n\nThe link expires in 24 hours. If you didn't sign up, you can ignore this email.`,
    html: `<p>${esc(hi)}</p><p>Confirm your email to activate your Pathy account and use the AI features:</p>
<p><a href="${esc(link)}" style="display:inline-block;padding:10px 18px;border-radius:8px;background:#4282c9;color:#fff;text-decoration:none">Confirm my email</a></p>
<p style="color:#666;font-size:13px">Or paste this link into your browser:<br>${esc(link)}<br>It expires in 24 hours. If you didn't sign up, ignore this email.</p>`,
  };
}
