// Startup diagnostic for Google credentials.
// Runs once at boot to detect stale service-account keys or revoked OAuth
// refresh tokens BEFORE the first user action fails with `invalid_grant`.
//
// Exported as `checkGoogleAuth()` — call it and forget it; it logs results
// and never throws. Nothing here mutates data.

const { google } = require('googleapis');
const path = require('path');

function loadServiceAccountAuth() {
  const SCOPES = [
    'https://www.googleapis.com/auth/spreadsheets',
    'https://www.googleapis.com/auth/drive.file',
  ];
  if (process.env.GOOGLE_SERVICE_ACCOUNT) {
    return new google.auth.GoogleAuth({
      credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT),
      scopes: SCOPES,
    });
  }
  return new google.auth.GoogleAuth({
    keyFile: path.join(__dirname, '..', 'config', 'google-service-account.json'),
    scopes: SCOPES,
  });
}

async function checkServiceAccount() {
  try {
    const auth = loadServiceAccountAuth();
    const client = await auth.getClient();
    // getAccessToken triggers a live JWT exchange with Google; any
    // invalid_grant / signature failure surfaces here.
    const token = await client.getAccessToken();
    if (!token || !token.token) throw new Error('empty token');
    const email = client.email || client._email || '(unknown)';
    console.log(`[auth-check] ✅ Service account OK — ${email}`);
    return { ok: true, email };
  } catch (err) {
    const msg = String(err.message || err);
    console.error('[auth-check] ❌ Service account FAILED:', msg);
    if (msg.includes('invalid_grant')) {
      console.error('[auth-check]    Cause: JWT signature was rejected by Google.');
      console.error('[auth-check]    Fix:   The service-account private key is stale or was rotated in GCP.');
      console.error('[auth-check]           Create a new key in the GCP console (IAM → Service Accounts → Keys)');
      console.error('[auth-check]           and paste the entire JSON into the GOOGLE_SERVICE_ACCOUNT env var.');
    }
    return { ok: false, error: msg };
  }
}

async function checkOAuthRefreshToken() {
  if (!process.env.GMAIL_CLIENT_ID || !process.env.GMAIL_CLIENT_SECRET) {
    console.log('[auth-check] ℹ️  OAuth not configured (GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET missing) — skipping.');
    return { ok: null, skipped: true };
  }
  if (!process.env.GMAIL_REFRESH_TOKEN) {
    console.log('[auth-check] ℹ️  OAuth refresh token not set — Drive uploads will use the service account.');
    return { ok: null, skipped: true };
  }
  try {
    const oauth = new google.auth.OAuth2(
      process.env.GMAIL_CLIENT_ID,
      process.env.GMAIL_CLIENT_SECRET
    );
    oauth.setCredentials({ refresh_token: process.env.GMAIL_REFRESH_TOKEN });
    // getAccessToken forces a refresh call against Google — surfaces
    // revoked / expired refresh tokens immediately.
    const token = await oauth.getAccessToken();
    if (!token || !token.token) throw new Error('empty token');
    console.log('[auth-check] ✅ OAuth refresh token OK — Drive uploads will use the user account.');
    return { ok: true };
  } catch (err) {
    const msg = String(err.message || err);
    console.error('[auth-check] ❌ OAuth refresh token FAILED:', msg);
    if (msg.includes('invalid_grant')) {
      console.error('[auth-check]    Cause: Refresh token was revoked or expired.');
      console.error('[auth-check]           Common triggers: user clicked "Remove access" on the Google');
      console.error('[auth-check]           account permissions page, changed their Google password,');
      console.error('[auth-check]           or the token sat unused for 6+ months.');
      console.error('[auth-check]    Fix:   Re-run the OAuth flow to mint a new refresh token:');
      console.error('[auth-check]             node scripts/setup-gmail-oauth.js');
      console.error('[auth-check]           Then update GMAIL_REFRESH_TOKEN in Railway → Variables.');
      console.error('[auth-check]    Impact: File uploads (rider PDFs, images, etc.) will fail until fixed.');
    }
    return { ok: false, error: msg };
  }
}

async function checkGoogleAuth() {
  console.log('[auth-check] Verifying Google credentials…');
  await checkServiceAccount();
  await checkOAuthRefreshToken();
}

module.exports = { checkGoogleAuth };
