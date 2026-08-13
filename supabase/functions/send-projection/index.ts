// ════════════════════════════════════════════
//  send-projection — email a generated Projection Report to a client.
//
//  The app is a static page, so it cannot hold a mail-provider key: anything
//  shipped to the browser is readable by anyone who opens devtools. This
//  function exists for exactly that reason and does exactly that one job —
//  it is the key's hiding place, not a general-purpose mailer.
//
//  Two checks stand between a caller and the firm's mail quota:
//    1. a valid Supabase session (the JWT the rest of the app already uses), and
//    2. membership of `app_users`.
//  The second is the one that matters. Authentication alone proves someone
//  signed up with Supabase, not that they work here — the same distinction the
//  RLS policies draw (CLAUDE.md §6: "membership, not authentication, grants
//  access"). Without it the publishable key plus any self-serve account would
//  be enough to send mail under the firm's name.
//
//  Secrets (set with `supabase secrets set`, never committed):
//    BREVO_API_KEY   the provider key
//    MAIL_FROM       the verified sender address
//    MAIL_FROM_NAME  display name on the message  (optional)
// ════════════════════════════════════════════

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.110.7';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });

// Brevo is one POST with the attachment inline as base64. Kept in its own
// function so swapping providers is this block and nothing else.
async function sendViaBrevo(opts: {
  apiKey: string; fromEmail: string; fromName: string;
  to: string; subject: string; html: string;
  fileName: string; pdfBase64: string;
}) {
  const resp = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: {
      'api-key': opts.apiKey,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify({
      sender: { email: opts.fromEmail, name: opts.fromName },
      to: [{ email: opts.to }],
      subject: opts.subject,
      htmlContent: opts.html,
      attachment: [{ content: opts.pdfBase64, name: opts.fileName }],
    }),
  });
  if (!resp.ok) {
    // Surface the provider's own message — "sender not verified" and "quota
    // exceeded" need completely different fixes, and a generic failure hides
    // which one happened.
    let detail = `HTTP ${resp.status}`;
    try {
      const err = await resp.json();
      if (err && (err.message || err.code)) detail = `${err.code ?? ''} ${err.message ?? ''}`.trim();
    } catch (_) { /* keep the status line */ }
    throw new Error(`mail provider rejected the message: ${detail}`);
  }
}

const esc = (s: string) =>
  String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ ok: false, error: 'POST only' }, 405);

  try {
    const apiKey = Deno.env.get('BREVO_API_KEY');
    const fromEmail = Deno.env.get('MAIL_FROM');
    const fromName = Deno.env.get('MAIL_FROM_NAME') ?? 'Shailesh & Associates';
    if (!apiKey || !fromEmail) {
      return json({ ok: false, error: 'email is not configured yet — BREVO_API_KEY and MAIL_FROM are not set on this function' }, 503);
    }

    // ── Who is calling ──
    const authHeader = req.headers.get('Authorization') ?? '';
    const sb = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
      { auth: { persistSession: false } },
    );
    const jwt = authHeader.replace(/^Bearer\s+/i, '');
    const { data: userData, error: userErr } = await sb.auth.getUser(jwt);
    const email = userData?.user?.email;
    if (userErr || !email) return json({ ok: false, error: 'not signed in' }, 401);

    // Membership, not merely authentication. `.ilike` because the app_users
    // lookup elsewhere is case-insensitive and the two must not disagree.
    const { data: member } = await sb.from('app_users').select('email').ilike('email', email).maybeSingle();
    if (!member) return json({ ok: false, error: 'not authorised to send mail' }, 403);

    // ── What to send ──
    const body = await req.json();
    const { to, company, fiscalYears, note, fileName, pdfBase64 } = body ?? {};
    if (!to || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(to))) {
      return json({ ok: false, error: 'a valid recipient address is required' }, 400);
    }
    if (!pdfBase64) return json({ ok: false, error: 'no report attached' }, 400);
    // base64 is ~4/3 of the raw size; refuse before handing the provider
    // something it will reject anyway.
    if (String(pdfBase64).length > 10 * 1024 * 1024) {
      return json({ ok: false, error: 'the attachment is too large to email' }, 413);
    }

    const subject = `Projection Report — ${company || 'Financial Projection'}`;
    const html = `
      <div style="font-family:Arial,Helvetica,sans-serif; font-size:14px; color:#0d131c; line-height:1.6;">
        ${note ? `<p>${esc(note)}</p>` : ''}
        <p>Please find attached the financial projection report${company ? ` for <strong>${esc(company)}</strong>` : ''}${
          fiscalYears ? `, covering fiscal years ${esc(fiscalYears)}` : ''
        }.</p>
        <p style="margin-top:22px; color:#3f4a5a;">
          ${esc(fromName)}<br/>
          <span style="font-size:12.5px;">Sent by ${esc(email)}</span>
        </p>
      </div>`;

    await sendViaBrevo({
      apiKey, fromEmail, fromName,
      to: String(to),
      subject,
      html,
      fileName: String(fileName || 'Projection Report.pdf'),
      pdfBase64: String(pdfBase64),
    });

    return json({ ok: true });
  } catch (e) {
    // The attachment is never logged — it is the client's financial position.
    console.error('send-projection failed:', e instanceof Error ? e.message : e);
    return json({ ok: false, error: e instanceof Error ? e.message : 'unexpected error' }, 500);
  }
});
