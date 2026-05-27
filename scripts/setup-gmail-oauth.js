/**
 * Windjammer — Gmail OAuth2 Setup Script
 * ---------------------------------------
 * Run this ONCE to generate your GMAIL_REFRESH_TOKEN.
 *
 * STEP 1 — In Google Cloud Console (console.cloud.google.com):
 *   1. APIs & Services → Enabled APIs → enable "Gmail API"
 *   2. APIs & Services → Credentials → Create Credentials → OAuth client ID
 *   3. Application type: "Web application"  (not Desktop)
 *   4. Under "Authorized redirect URIs" add:  http://localhost:3005/oauth2callback
 *   5. Note the Client ID and Client Secret
 *   6. OAuth consent screen → Test users → add productionwindjammer@gmail.com
 *
 * STEP 2 — Add to your .env file:
 *   GMAIL_CLIENT_ID=your_client_id
 *   GMAIL_CLIENT_SECRET=your_client_secret
 *   GMAIL_USER=productionwindjammer@gmail.com
 *
 * STEP 3 — Run this script (keep your main server stopped or on a different port):
 *   node scripts/setup-gmail-oauth.js
 *
 *   Your browser will open automatically. Sign in as productionwindjammer@gmail.com,
 *   click Allow, and the token will be printed in this terminal.
 *
 * STEP 4 — Copy the printed GMAIL_REFRESH_TOKEN into your .env file and restart.
 */

require('dotenv').config();
const { google } = require('googleapis');
const http       = require('http');
const url        = require('url');

const PORT = 3005;
const REDIRECT_URI = `http://localhost:${PORT}/oauth2callback`;

const { GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET } = process.env;

if (!GMAIL_CLIENT_ID || !GMAIL_CLIENT_SECRET) {
  console.error('\nERROR: GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET must be set in your .env file.');
  process.exit(1);
}

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/drive.file',
];

const oAuth2Client = new google.auth.OAuth2(GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, REDIRECT_URI);

const authUrl = oAuth2Client.generateAuthUrl({
  access_type: 'offline',
  scope: SCOPES,
  prompt: 'consent',
});

// Spin up a one-shot local server to catch the OAuth callback
const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  if (!parsed.pathname.startsWith('/oauth2callback')) {
    res.end('Not found');
    return;
  }

  const code = parsed.query.code;
  const error = parsed.query.error;

  if (error) {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<h2>Authorization failed: ${error}</h2><p>Close this tab and check the terminal.</p>`);
    server.close();
    console.error('\n❌ Authorization was denied or failed:', error);
    process.exit(1);
  }

  if (!code) {
    res.end('No code received.');
    server.close();
    return;
  }

  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(`
    <html><body style="font-family:sans-serif;padding:40px;background:#111;color:#0f0">
      <h2>✅ Authorization successful!</h2>
      <p>Your refresh token has been printed in the terminal.</p>
      <p>You can close this tab.</p>
    </body></html>
  `);

  try {
    const { tokens } = await oAuth2Client.getToken(code);
    console.log('\n✅ Success! Add this to your .env file:\n');
    console.log(`GMAIL_REFRESH_TOKEN=${tokens.refresh_token}`);
    console.log('\nThen restart the server — Gmail integration will auto-activate.');
  } catch (err) {
    console.error('\n❌ Error exchanging code for token:', err.message);
  } finally {
    server.close();
  }
});

server.listen(PORT, () => {
  console.log('\n──────────────────────────────────────────────────────');
  console.log('  Windjammer Gmail OAuth2 Setup');
  console.log('──────────────────────────────────────────────────────');
  console.log(`\nOpening browser — sign in as productionwindjammer@gmail.com`);
  console.log('(If the browser does not open, paste this URL manually)\n');
  console.log(' ', authUrl, '\n');

  // Try to open the browser automatically
  const { exec } = require('child_process');
  const open = process.platform === 'win32'
    ? `start "" "${authUrl}"`
    : process.platform === 'darwin'
      ? `open "${authUrl}"`
      : `xdg-open "${authUrl}"`;
  exec(open);
});
