require('dotenv').config();
const { google } = require('googleapis');

const GMAIL_USER = process.env.GMAIL_USER || 'productionwindjammer@gmail.com';

const OAUTH_SCOPES = [
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/drive.file',
  'https://www.googleapis.com/auth/userinfo.email',
];

function isConfigured() {
  return !!(
    process.env.GMAIL_CLIENT_ID &&
    process.env.GMAIL_CLIENT_SECRET &&
    process.env.GMAIL_REFRESH_TOKEN
  );
}

// True when OAuth client credentials are set (per-user flow still works
// even if no shared refresh token is present).
function hasClientCredentials() {
  return !!(process.env.GMAIL_CLIENT_ID && process.env.GMAIL_CLIENT_SECRET);
}

function getOAuth2Client(redirectUri) {
  const client = new google.auth.OAuth2(
    process.env.GMAIL_CLIENT_ID,
    process.env.GMAIL_CLIENT_SECRET,
    redirectUri || 'http://localhost:3005/oauth2callback'
  );
  if (process.env.GMAIL_REFRESH_TOKEN) {
    client.setCredentials({ refresh_token: process.env.GMAIL_REFRESH_TOKEN });
  }
  return client;
}

// Per-user OAuth client built from a stored refresh token
function getOAuth2ClientForToken(refreshToken, redirectUri) {
  const client = new google.auth.OAuth2(
    process.env.GMAIL_CLIENT_ID,
    process.env.GMAIL_CLIENT_SECRET,
    redirectUri || 'http://localhost:3005/oauth2callback'
  );
  client.setCredentials({ refresh_token: refreshToken });
  return client;
}

function getGmailClient() {
  return google.gmail({ version: 'v1', auth: getOAuth2Client() });
}

function getGmailClientForToken(refreshToken) {
  return google.gmail({ version: 'v1', auth: getOAuth2ClientForToken(refreshToken) });
}

// Build the consent URL for a user to authorize the app against their Gmail.
// `state` is an opaque string (we use a signed JWT) returned in the callback.
function buildAuthUrl({ state, redirectUri }) {
  const client = new google.auth.OAuth2(
    process.env.GMAIL_CLIENT_ID,
    process.env.GMAIL_CLIENT_SECRET,
    redirectUri
  );
  return client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: OAUTH_SCOPES,
    state,
  });
}

// Exchange an OAuth code for tokens, plus the user's verified gmail address.
async function exchangeCodeForTokens({ code, redirectUri }) {
  const client = new google.auth.OAuth2(
    process.env.GMAIL_CLIENT_ID,
    process.env.GMAIL_CLIENT_SECRET,
    redirectUri
  );
  const { tokens } = await client.getToken(code);
  client.setCredentials(tokens);
  // Fetch the connected gmail address for display/identity
  const oauth2 = google.oauth2({ version: 'v2', auth: client });
  const me = await oauth2.userinfo.get();
  return {
    refreshToken: tokens.refresh_token,
    accessToken:  tokens.access_token,
    email:        me.data.email,
    expiry:       tokens.expiry_date,
  };
}

// ── Parse a full Gmail message into structured data ───────────────────────────
function parseMessage(msg) {
  const headerMap = {};
  for (const h of (msg.payload?.headers || [])) {
    headerMap[h.name.toLowerCase()] = h.value;
  }

  let htmlBody = '';
  let textBody = '';
  const attachments = [];

  function walkParts(parts) {
    if (!parts) return;
    for (const part of parts) {
      if (part.filename && part.body?.attachmentId) {
        attachments.push({
          filename: part.filename,
          mimeType: part.mimeType || 'application/octet-stream',
          attachmentId: part.body.attachmentId,
          size: part.body.size || 0,
        });
      } else if (part.mimeType === 'text/html' && part.body?.data) {
        htmlBody = Buffer.from(part.body.data, 'base64url').toString('utf-8');
      } else if (part.mimeType === 'text/plain' && part.body?.data && !textBody) {
        textBody = Buffer.from(part.body.data, 'base64url').toString('utf-8');
      } else if (part.parts) {
        walkParts(part.parts);
      }
    }
  }

  if (msg.payload?.parts) {
    walkParts(msg.payload.parts);
  } else if (msg.payload?.body?.data) {
    const raw = Buffer.from(msg.payload.body.data, 'base64url').toString('utf-8');
    if ((msg.payload.mimeType || '').includes('html')) htmlBody = raw;
    else textBody = raw;
  }

  return {
    gmailMessageId: msg.id,
    gmailThreadId: msg.threadId,
    from: headerMap['from'] || '',
    to: headerMap['to'] || '',
    cc: headerMap['cc'] || '',
    subject: headerMap['subject'] || '(no subject)',
    date: headerMap['date'] || '',
    snippet: msg.snippet || '',
    htmlBody,
    textBody,
    attachments,
    labelIds: msg.labelIds || [],
  };
}

// ── Search Gmail for messages matching a query ────────────────────────────────
// Optional `client` overrides the shared client (used for per-user mailboxes).
async function searchEmails(query, maxResults = 100, client) {
  const gmail = client || getGmailClient();
  const res = await gmail.users.messages.list({
    userId: 'me',
    q: query,
    maxResults,
  });
  return res.data.messages || [];
}

// ── Fetch a full message by ID ────────────────────────────────────────────────
async function getMessage(messageId, client) {
  const gmail = client || getGmailClient();
  const res = await gmail.users.messages.get({
    userId: 'me',
    id: messageId,
    format: 'full',
  });
  return res.data;
}

// ── Fetch raw attachment bytes (returns base64-encoded string) ────────────────
async function getAttachmentData(messageId, attachmentId, client) {
  const gmail = client || getGmailClient();
  const res = await gmail.users.messages.attachments.get({
    userId: 'me',
    messageId,
    id: attachmentId,
  });
  // Gmail returns base64url; convert to standard base64
  return res.data.data.replace(/-/g, '+').replace(/_/g, '/');
}

// ── Build a MIME message string and base64url-encode it ───────────────────────
function buildMimeRaw({ from, to, cc, subject, body, attachments = [], inReplyToMsgId }) {
  const boundary = `wj_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;

  const headerLines = [
    `From: ${from || GMAIL_USER}`,
    `To: ${to}`,
    cc ? `Cc: ${cc}` : null,
    `Subject: ${subject}`,
    `MIME-Version: 1.0`,
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    inReplyToMsgId ? `In-Reply-To: ${inReplyToMsgId}` : null,
    inReplyToMsgId ? `References: ${inReplyToMsgId}` : null,
  ].filter(Boolean);

  let mime = headerLines.join('\r\n') + '\r\n\r\n';
  mime += `--${boundary}\r\n`;
  mime += `Content-Type: text/html; charset="UTF-8"\r\n\r\n`;
  mime += body + '\r\n\r\n';

  for (const att of attachments) {
    mime += `--${boundary}\r\n`;
    mime += `Content-Type: ${att.mimeType}; name="${att.filename}"\r\n`;
    mime += `Content-Disposition: attachment; filename="${att.filename}"\r\n`;
    mime += `Content-Transfer-Encoding: base64\r\n\r\n`;
    mime += att.data + '\r\n\r\n';
  }

  mime += `--${boundary}--`;
  return Buffer.from(mime).toString('base64url');
}

// ── Send or reply to an email ─────────────────────────────────────────────────
// opts: { from, to, cc, subject, body (HTML), attachments, inReplyToMsgId, threadId, client }
async function sendEmail(opts) {
  const gmail = opts.client || getGmailClient();
  const raw = buildMimeRaw(opts);
  const requestBody = { raw };
  if (opts.threadId) requestBody.threadId = opts.threadId;
  const res = await gmail.users.messages.send({ userId: 'me', requestBody });
  return res.data; // { id, threadId, labelIds }
}

module.exports = {
  isConfigured,
  hasClientCredentials,
  parseMessage,
  listLabels,
  searchEmails,
  getMessage,
  getAttachmentData,
  sendEmail,
  buildAuthUrl,
  exchangeCodeForTokens,
  getGmailClientForToken,
  GMAIL_USER,
  OAUTH_SCOPES,
};
