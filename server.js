require('dotenv').config();
const express = require('express');
const path    = require('path');
const jwt     = require('jsonwebtoken');
const bcrypt  = require('bcryptjs');
const config  = require('./config/server-config');
const sheets  = require('./sheets');
const gmail   = require('./gmail');
const bot     = require('./advancingBot');

const app = express();
app.set('trust proxy', true);
app.use(express.json({ limit: '50mb' }));

// Serve React build in production.
// Hashed assets get long cache; HTML and sw.js MUST always be fresh so users
// pick up new Railway deploys without manual cache-clearing.
if (process.env.NODE_ENV === 'production') {
  app.use(express.static(path.join(__dirname, 'client/dist'), {
    setHeaders(res, filePath) {
      const base = path.basename(filePath);
      if (base === 'sw.js' || base === 'index.html' || base === 'manifest.webmanifest') {
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      } else if (/\/assets\//.test(filePath)) {
        // Vite fingerprints assets/* so they're safe to cache forever
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      }
    },
  }));
}

// ── Auth Helpers ─────────────────────────────────────────────────────────────
function signToken(user) {
  return jwt.sign(
    { id: user.id, name: user.name, role: user.role, email: user.email },
    config.jwtSecret,
    { expiresIn: '24h' }
  );
}

function requireAuth(req, res, next) {
  const auth  = req.headers['authorization'] || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ success: false, message: 'Not authenticated' });
  try {
    req.user = jwt.verify(token, config.jwtSecret);
    next();
  } catch {
    return res.status(401).json({ success: false, message: 'Token invalid or expired' });
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user?.role))
      return res.status(403).json({ success: false, message: 'Insufficient permissions' });
    next();
  };
}

// ── Auth ──────────────────────────────────────────────────────────────────────
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ success: false, message: 'Email and password required' });
    const users = await sheets.getRows(config.googleSheets.sheets.users);
    const user  = users.find(u => u.email?.toLowerCase() === email.toLowerCase());
    if (!user)                               return res.status(401).json({ success: false, message: 'Invalid credentials' });
    const valid = await bcrypt.compare(password, user.password);
    if (!valid)                              return res.status(401).json({ success: false, message: 'Invalid credentials' });
    if (user.active?.toLowerCase() === 'false') return res.status(403).json({ success: false, message: 'Account disabled' });
    const token = signToken(user);
    res.json({ success: true, token, user: { id: user.id, name: user.name, role: user.role, email: user.email, staffId: user.staffId || '' } });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

app.get('/api/auth/me', requireAuth, (req, res) => {
  res.json({ success: true, user: req.user });
});

// Update the currently signed-in user's display name (and optionally email).
// Email changes require re-checking uniqueness across the Users sheet.
app.patch('/api/auth/profile', requireAuth, async (req, res) => {
  try {
    const { name, email } = req.body || {};
    const updates = {};
    if (typeof name === 'string' && name.trim()) updates.name = name.trim();
    if (typeof email === 'string' && email.trim()) {
      const newEmail = email.trim().toLowerCase();
      const users = await sheets.getRows(config.googleSheets.sheets.users);
      const clash = users.find(u => u.email?.toLowerCase() === newEmail && u.id !== req.user.id);
      if (clash) return res.status(409).json({ success: false, message: 'Email already in use' });
      updates.email = newEmail;
    }
    if (!Object.keys(updates).length) return res.status(400).json({ success: false, message: 'No changes provided' });
    await sheets.updateRowById(config.googleSheets.sheets.users, req.user.id, updates);
    res.json({ success: true, user: { ...req.user, ...updates } });
  } catch (err) {
    console.error('Profile update error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// Change the signed-in user's password. Requires the current password.
app.post('/api/auth/change-password', requireAuth, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body || {};
    if (!currentPassword || !newPassword) return res.status(400).json({ success: false, message: 'Both current and new password are required' });
    if (newPassword.length < 8)            return res.status(400).json({ success: false, message: 'New password must be at least 8 characters' });
    const users = await sheets.getRows(config.googleSheets.sheets.users);
    const user  = users.find(u => u.id === req.user.id);
    if (!user)                                       return res.status(404).json({ success: false, message: 'User not found' });
    const valid = await bcrypt.compare(currentPassword, user.password);
    if (!valid)                                      return res.status(401).json({ success: false, message: 'Current password is incorrect' });
    const hash = await bcrypt.hash(newPassword, 12);
    await sheets.updateRowById(config.googleSheets.sheets.users, req.user.id, { password: hash });
    res.json({ success: true });
  } catch (err) {
    console.error('Change password error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── Generic CRUD factory ──────────────────────────────────────────────────────
function crudRoutes(router, path, sheetKey, writeRoles = ['admin','production_manager'], hooks = {}) {
  const deleteRoles = hooks.deleteRoles || writeRoles;
  router.get(path, requireAuth, async (req, res) => {
    try { res.json({ success: true, data: await sheets.getRows(config.googleSheets.sheets[sheetKey]) }); }
    catch (err) { res.status(500).json({ success: false, message: err.message }); }
  });
  router.post(path, requireAuth, requireRole(...writeRoles), async (req, res) => {
    try {
      const record = { id: Date.now().toString(), ...req.body, createdAt: new Date().toISOString() };
      await sheets.appendRow(config.googleSheets.sheets[sheetKey], record);
      let extra;
      if (typeof hooks.afterCreate === 'function') {
        if (hooks.awaitAfterCreate) {
          // Awaited hook may return an object to merge into the response payload.
          try { extra = await hooks.afterCreate(record, req); }
          catch (err) { console.error(`[${sheetKey} afterCreate]`, err.message); }
        } else {
          // Fire-and-forget so the client gets a fast response.
          Promise.resolve()
            .then(() => hooks.afterCreate(record, req))
            .catch(err => console.error(`[${sheetKey} afterCreate]`, err.message));
        }
      }
      res.json({ success: true, data: record, ...(extra || {}) });
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
  });
  router.put(path + '/:id', requireAuth, requireRole(...writeRoles), async (req, res) => {
    try {
      await sheets.updateRowById(config.googleSheets.sheets[sheetKey], req.params.id, req.body);
      res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
  });
  router.delete(path + '/:id', requireAuth, requireRole(...deleteRoles), async (req, res) => {
    try {
      await sheets.deleteRowById(config.googleSheets.sheets[sheetKey], req.params.id);
      res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
  });
}

// ── Auto-advancing kickoff for new shows ─────────────────────────────────────
// When a show is created, automatically:
//   1. Create a matching Advancing record (idempotent — skips if one exists)
//   2. Create the show's Google Drive folder (best-effort)
//   3. If an advance contact email is already known, sync Gmail history and
//      run the bot extractor so the advancer opens to pre-filled suggestions
async function kickoffAdvanceForShow(show) {
  if (!show || !show.id) return;
  const showLabel = show.artist || show.eventName || `Show ${show.id}`;
  console.log(`[kickoff] Preparing advance for show ${show.id} — ${showLabel}`);

  // 1. Create Advancing record if none exists for this showId
  let advanceId = null;
  try {
    const existing = await sheets.getRows(config.googleSheets.sheets.advancing);
    const match    = existing.find(a => a.showId === show.id);
    if (match) {
      advanceId = match.id;
      console.log(`[kickoff] Advance row already exists (${advanceId}); skipping create.`);
    } else {
      const advance = {
        id:                 `${Date.now()}${Math.random().toString(36).slice(2, 6)}`,
        showId:             show.id,
        showName:           showLabel,
        stage:              show.stage || 'inside',
        riderReceived:      'false',
        riderNotes:         '',
        stagingChanges:     '',
        capacityChanges:    '',
        soundRestrictions: '',
        curfew:             '',
        productionNeeds:    '',
        backlineNotes:      '',
        cateringNotes:      '',
        hospitalityNotes:   '',
        localCrewNeeds:     '',
        advancingComplete:  'false',
        advanceContact:     show.tourManager || '',
        advancePhone:       '',
        advanceEmail:       show.advanceEmail || '',
        notes:              '',
        createdAt:          new Date().toISOString(),
      };
      await sheets.appendRow(config.googleSheets.sheets.advancing, advance);
      advanceId = advance.id;
      console.log(`[kickoff] Created advance row ${advanceId}.`);
    }
  } catch (err) {
    console.error('[kickoff] Failed to create advance row:', err.message);
  }

  // 2. Create the show's Drive folder (best-effort)
  try {
    if (!show.driveFolderId) {
      const drive = await sheets.getDriveClient();
      const folderName = `Windjammer — ${show.date || 'TBD'} — ${showLabel}`;
      const folder = await drive.files.create({
        requestBody: { name: folderName, mimeType: 'application/vnd.google-apps.folder' },
        fields: 'id',
      });
      const folderId = folder.data.id;
      await drive.permissions.create({
        fileId: folderId,
        requestBody: { role: 'reader', type: 'anyone' },
      });
      await sheets.updateRowById(config.googleSheets.sheets.shows, show.id, { driveFolderId: folderId });
      console.log(`[kickoff] Created Drive folder ${folderId}.`);
    }
  } catch (err) {
    console.error('[kickoff] Drive folder creation failed:', err.message);
  }

  // 3. If we already have an advance email, do an initial Gmail sync + extract
  const advanceEmail = show.advanceEmail || '';
  if (advanceEmail && gmail.isConfigured() && advanceId) {
    try {
      const newCount = await syncEmailsForShow(show.id, advanceEmail, showLabel);
      console.log(`[kickoff] Pulled ${newCount} initial email(s) for ${advanceEmail}.`);

      // Run the extractor against whatever's in the Emails sheet for this show
      const allEmails  = await getStoredEmails();
      const inbound    = allEmails
        .filter(e => e.showId === show.id && (e.direction || '').toLowerCase() !== 'outbound')
        .sort((a, b) => (Date.parse(b.date) || 0) - (Date.parse(a.date) || 0))
        .slice(0, 30);

      const full = [];
      for (const e of inbound) {
        try {
          const msg    = await gmail.getMessage(e.gmailMessageId);
          const parsed = gmail.parseMessage(msg);
          full.push({
            gmailMessageId: e.gmailMessageId,
            subject:        parsed.subject || e.subject,
            from:           parsed.from || e.from,
            date:           parsed.date || e.date,
            snippet:        e.snippet,
            textBody:       parsed.textBody,
            htmlBody:       parsed.htmlBody,
            attachmentMeta: JSON.stringify(parsed.attachments || []),
            direction:      e.direction,
          });
        } catch { full.push({ ...e }); }
      }

      if (full.length) {
        const extracted = bot.extractFromEmails(full);
        await sheets.updateRowById(config.googleSheets.sheets.advancing, advanceId, {
          botExtracted: JSON.stringify(extracted),
          botLastRun:   extracted.extractedAt,
        });
        console.log(`[kickoff] Bot extracted ${Object.keys(extracted.fields || {}).length} field(s).`);
      }
    } catch (err) {
      console.error('[kickoff] Initial Gmail sync/extract failed:', err.message);
    }
  }
}

crudRoutes(app, '/api/shows',           'shows',     ['admin','production_manager','promoter'], { afterCreate: kickoffAdvanceForShow });
crudRoutes(app, '/api/advancing',       'advancing', ['admin','production_manager','promoter']);
crudRoutes(app, '/api/schedule',        'schedule');
crudRoutes(app, '/api/labor',           'labor');
crudRoutes(app, '/api/vendors',         'vendors');
crudRoutes(app, '/api/vendor-bookings', 'vendorBookings');
crudRoutes(app, '/api/settlement',      'settlement');
crudRoutes(app, '/api/unavailability',  'unavailability', ['admin','production_manager']);
crudRoutes(app, '/api/artists',         'artists',        ['admin','production_manager']);
// Note: artist-documents writes go through the upload endpoint below (which handles Drive too).
// We expose only GET via crudRoutes-equivalent below to avoid orphaning Drive files on direct deletes.

// Staff: auto-provision a default user account when an admin adds a staff
// member with an email address. The account is created with a random unknown
// password and an invite token is emailed to the new hire so they can set
// their own password and complete their profile.
async function autoCreateUserForStaff(staff, req) {
  if (!staff?.email) return null;
  if (!['admin', 'production_manager'].includes(req.user?.role)) return null;
  try {
    const email = staff.email.trim().toLowerCase();
    const existingUsers = await sheets.getRows(config.googleSheets.sheets.users);
    if (existingUsers.some(u => (u.email || '').toLowerCase() === email)) {
      return null; // already has an account
    }
    // Create a placeholder account; the user will set their real password via the invite link.
    const placeholderHash = await bcrypt.hash(`pending-${Date.now()}-${Math.random()}`, 12);
    const user = {
      id:        Date.now().toString(),
      name:      staff.name || email.split('@')[0],
      email,
      role:      'crew',
      password:  placeholderHash,
      active:    'true',
      staffId:   staff.id,
      onboardingComplete: 'false',
      createdAt: new Date().toISOString(),
    };
    await sheets.appendRow(config.googleSheets.sheets.users, user);
    const inviteUrl = await sendInviteEmailIfPossible(user, staff, req);
    return { invited: { email, inviteUrl } };
  } catch (err) {
    console.error('[staff auto-user]', err.message);
    return null;
  }
}

// Determine the public base URL for invite links.
// Priority: PUBLIC_APP_URL env -> Railway public domain -> request host -> localhost.
function resolveAppBaseUrl(req) {
  if (process.env.PUBLIC_APP_URL) return process.env.PUBLIC_APP_URL.replace(/\/$/, '');
  if (process.env.RAILWAY_PUBLIC_DOMAIN) return `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`;
  if (req) {
    const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'http').split(',')[0].trim();
    const host  = req.headers['x-forwarded-host'] || req.get('host');
    if (host) return `${proto}://${host}`;
  }
  return `http://localhost:${config.port === 3001 ? 5173 : config.port}`;
}

// Build a signed invite token (7-day expiry) and return the onboarding URL.
function buildInviteUrl(user, req) {
  const token = jwt.sign({ uid: user.id, t: 'invite' }, config.jwtSecret, { expiresIn: '7d' });
  return `${resolveAppBaseUrl(req)}/onboard/${token}`;
}

// Send the invite email from the house mailbox if one is connected.
// Returns the invite URL whether or not the email was sent (admin can copy it).
async function sendInviteEmailIfPossible(user, staff, req) {
  const url = buildInviteUrl(user, req);
  try {
    const users = await sheets.getRows(config.googleSheets.sheets.users);
    const house = users.find(u => String(u.isHouseMailbox).toLowerCase() === 'true' && u.gmailRefreshToken);
    if (!house) {
      console.log(`[invite] No house mailbox configured. Share this link with ${user.email}: ${url}`);
      return url;
    }
    const client = gmail.getGmailClientForToken(house.gmailRefreshToken);
    const name = (user.name || '').split(' ')[0] || 'there';
    const appBase = resolveAppBaseUrl(req);
    const body = `
      <p>Hi ${name},</p>
      <p>Welcome to the Windjammer Production team! Please finish setting up your account by clicking the link below:</p>
      <p><a href="${url}" style="display:inline-block;padding:10px 20px;background:#3b82f6;color:#fff;text-decoration:none;border-radius:6px;font-weight:600">Complete Your Profile</a></p>
      <p>Or copy and paste this URL into your browser:<br><code>${url}</code></p>
      <p>This link is valid for 7 days. You'll be asked to set a password and fill in a few details — once you log in successfully, you're all set.</p>

      <hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0">
      <h3 style="margin:0 0 8px">Get the Windjammer app on your devices</h3>
      <p style="margin:0 0 8px">After you finish onboarding, you can access Windjammer any time at:<br>
        <a href="${appBase}">${appBase}</a>
      </p>
      <p style="margin:0 0 8px"><strong>Install it like an app</strong> (recommended):</p>
      <ul style="margin:0 0 8px;padding-left:20px">
        <li><strong>iPhone / iPad:</strong> Open the link in Safari → tap the Share button → <em>Add to Home Screen</em>.</li>
        <li><strong>Android:</strong> Open the link in Chrome → tap the ⋮ menu → <em>Install app</em> (or <em>Add to Home screen</em>).</li>
        <li><strong>Desktop (Chrome / Edge):</strong> Open the link → click the install icon (⊕) in the address bar, or use the ⋮ menu → <em>Install Windjammer</em>.</li>
      </ul>
      <p style="color:#6b7280;font-size:13px">Installing gives you a dedicated app icon and a full-screen experience — no app store required.</p>

      <p>— The Windjammer Production Team</p>
    `;
    await gmail.sendEmail({
      to: user.email,
      subject: 'Welcome to Windjammer — Complete Your Profile',
      body,
      client,
    });
    console.log(`[invite] Sent invite to ${user.email} (staff: ${staff?.id || '?'})`);
  } catch (err) {
    console.error(`[invite] Failed to email ${user.email}: ${err.message}. URL: ${url}`);
  }
  return url;
}

// POST /api/staff/:id/invite — resends an invite to an existing staff member.
app.post('/api/staff/:id/invite', requireAuth, requireRole('admin', 'production_manager'), async (req, res) => {
  try {
    const { id } = req.params;
    const staffRows = await sheets.getRows(config.googleSheets.sheets.staff);
    const staff = staffRows.find(s => s.id === id);
    if (!staff)         return res.status(404).json({ success: false, message: 'Staff not found' });
    if (!staff.email)   return res.status(400).json({ success: false, message: 'Staff has no email on file' });
    const users = await sheets.getRows(config.googleSheets.sheets.users);
    let user = users.find(u => (u.email || '').toLowerCase() === staff.email.toLowerCase());
    if (!user) {
      // Create the account on the fly so we always have something to invite.
      const placeholderHash = await bcrypt.hash(`pending-${Date.now()}-${Math.random()}`, 12);
      user = {
        id:        Date.now().toString(),
        name:      staff.name || staff.email.split('@')[0],
        email:     staff.email.toLowerCase(),
        role:      'crew',
        password:  placeholderHash,
        active:    'true',
        staffId:   staff.id,
        onboardingComplete: 'false',
        createdAt: new Date().toISOString(),
      };
      await sheets.appendRow(config.googleSheets.sheets.users, user);
    } else if (user.staffId !== staff.id) {
      // Backfill the link so onboarding updates the correct staff row.
      await sheets.updateRowById(config.googleSheets.sheets.users, user.id, { staffId: staff.id });
      user.staffId = staff.id;
    }
    const inviteUrl = await sendInviteEmailIfPossible(user, staff, req);
    res.json({ success: true, inviteUrl });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/onboard/:token — verify an invite token; return prefill data.
app.get('/api/onboard/:token', async (req, res) => {
  try {
    const payload = jwt.verify(req.params.token, config.jwtSecret);
    if (payload.t !== 'invite') return res.status(400).json({ success: false, message: 'Invalid invite link' });
    const users = await sheets.getRows(config.googleSheets.sheets.users);
    const user  = users.find(u => u.id === payload.uid);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });
    if (user.onboardingComplete === 'true')
      return res.status(400).json({ success: false, message: 'Onboarding already complete. Please sign in normally.' });
    const staffRows = await sheets.getRows(config.googleSheets.sheets.staff);
    const staff = staffRows.find(s => s.id === user.staffId) || {};
    res.json({
      success: true,
      prefill: {
        name:       user.name || staff.name || '',
        email:      user.email,
        phone:      staff.phone || '',
        department: staff.department || '',
        stage:      staff.stage || 'both',
        role:       staff.role || '',
      },
    });
  } catch (err) {
    if (err.name === 'TokenExpiredError')
      return res.status(400).json({ success: false, message: 'This invite link has expired. Ask an admin to resend.' });
    res.status(400).json({ success: false, message: 'Invalid invite link' });
  }
});

// POST /api/onboard/:token — complete onboarding. Body:
// { password, phone, address, emergencyContactName, emergencyContactPhone,
//   emergencyContactRelation, tshirtSize, stage, department, role, rates: [...] }
// Returns { token, user } so the client logs in immediately.
app.post('/api/onboard/:token', async (req, res) => {
  try {
    const payload = jwt.verify(req.params.token, config.jwtSecret);
    if (payload.t !== 'invite') return res.status(400).json({ success: false, message: 'Invalid invite link' });
    const { password, phone, address,
      emergencyContactName, emergencyContactPhone, emergencyContactRelation,
      tshirtSize, stage, department, role, rates,
    } = req.body || {};
    if (!password || password.length < 8)
      return res.status(400).json({ success: false, message: 'Password must be at least 8 characters' });

    const users = await sheets.getRows(config.googleSheets.sheets.users);
    const user  = users.find(u => u.id === payload.uid);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    // Update the user account: real password hash + onboardingComplete.
    const hash = await bcrypt.hash(password, 12);
    await sheets.updateRowById(config.googleSheets.sheets.users, user.id, {
      password: hash,
      onboardingComplete: 'true',
      onboardedAt: new Date().toISOString(),
    });

    // Update (or create) the linked staff record with everything they filled in.
    const staffRows = await sheets.getRows(config.googleSheets.sheets.staff);
    let staff = user.staffId ? staffRows.find(s => s.id === user.staffId) : null;
    // Fallback: match by email so we never create a duplicate staff row when
    // the user record was created without a staffId backlink.
    if (!staff && user.email) {
      staff = staffRows.find(s => (s.email || '').toLowerCase() === user.email.toLowerCase());
      if (staff && staff.id !== user.staffId) {
        await sheets.updateRowById(config.googleSheets.sheets.users, user.id, { staffId: staff.id });
        user.staffId = staff.id;
      }
    }
    const ratesJson = (() => {
      try { return JSON.stringify(Array.isArray(rates) ? rates : JSON.parse(rates || '[]')); }
      catch { return '[]'; }
    })();
    const staffPatch = {
      name:       user.name || '',
      email:      user.email,
      phone:      phone || '',
      address:    address || '',
      emergencyContactName,
      emergencyContactPhone,
      emergencyContactRelation,
      tshirtSize: tshirtSize || '',
      stage:      stage || 'both',
      department: department || '',
      role:       role || '',
      rates:      ratesJson,
      onboardingComplete: 'true',
      active:     'true',
    };
    if (staff) {
      await sheets.updateRowById(config.googleSheets.sheets.staff, staff.id, staffPatch);
    } else {
      const newStaff = {
        id: Date.now().toString(),
        ...staffPatch,
        startDate: new Date().toISOString().slice(0, 10),
        createdAt: new Date().toISOString(),
      };
      await sheets.appendRow(config.googleSheets.sheets.staff, newStaff);
      await sheets.updateRowById(config.googleSheets.sheets.users, user.id, { staffId: newStaff.id });
    }

    // Sign them in.
    const token = signToken({ ...user, password: hash });
    res.json({
      success: true,
      token,
      user: { id: user.id, name: user.name, role: user.role, email: user.email, staffId: user.staffId || '' },
    });
  } catch (err) {
    if (err.name === 'TokenExpiredError')
      return res.status(400).json({ success: false, message: 'This invite link has expired. Ask an admin to resend.' });
    console.error('Onboarding error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});
crudRoutes(app, '/api/staff', 'staff', ['admin','production_manager'], { afterCreate: autoCreateUserForStaff, awaitAfterCreate: true, deleteRoles: ['admin'] });

// ── Users (admin-managed) ─────────────────────────────────────────────────────
app.get('/api/users', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const rows = await sheets.getRows(config.googleSheets.sheets.users);
    res.json({ success: true, data: rows.map(({ password, ...u }) => u) });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.post('/api/users', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const { name, email, password, role } = req.body;
    if (!name || !email || !password || !role)
      return res.status(400).json({ success: false, message: 'All fields required' });
    const hashed = await bcrypt.hash(password, 12);
    const user = { id: Date.now().toString(), name, email, role, password: hashed, active: 'true', createdAt: new Date().toISOString() };
    await sheets.appendRow(config.googleSheets.sheets.users, user);
    const { password: _, ...safe } = user;
    res.json({ success: true, data: safe });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.put('/api/users/:id', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const updates = { ...req.body };
    if (updates.password) updates.password = await bcrypt.hash(updates.password, 12);
    await sheets.updateRowById(config.googleSheets.sheets.users, req.params.id, updates);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// ── Tech Pack ─────────────────────────────────────────────────────────────────
app.get('/api/techpack', requireAuth, async (req, res) => {
  try {
    const rows = await sheets.getRows(config.googleSheets.sheets.techpack);
    res.json({ success: true, data: rows });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.put('/api/techpack/:id', requireAuth, requireRole('admin', 'production_manager'), async (req, res) => {
  try {
    await sheets.updateRowById(config.googleSheets.sheets.techpack, req.params.id, req.body);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// ── Image Upload (Google Drive) ───────────────────────────────────────────────
const { Readable } = require('stream');

async function uploadToDrive(filename, mimeType, base64Data) {
  const drive = await sheets.getDriveClient();
  const buffer = Buffer.from(base64Data, 'base64');
  const readable = Readable.from(buffer);
  const fileRes = await drive.files.create({
    requestBody: { name: filename, mimeType },
    media: { mimeType, body: readable },
    fields: 'id',
  });
  const fileId = fileRes.data.id;
  await drive.permissions.create({
    fileId,
    requestBody: { role: 'reader', type: 'anyone' },
  });
  return `https://drive.google.com/uc?id=${fileId}&export=view`;
}

app.post('/api/upload', requireAuth, async (req, res) => {
  try {
    const { filename, mimeType, data } = req.body;
    if (!filename || !mimeType || !data)
      return res.status(400).json({ success: false, message: 'filename, mimeType and data required' });
    const url = await uploadToDrive(filename, mimeType, data);
    res.json({ success: true, url });
  } catch (err) {
    console.error('Upload error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── Advancing Bot Analysis ────────────────────────────────────────────────────
// Fetches full Gmail bodies for inbound emails on this show, runs the rule-based
// extractor to pull structured advance info, plus runs the legacy flag analyzer.
app.post('/api/advancing/:id/analyze', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;

    // Load advancing record
    const advances = await sheets.getRows(config.googleSheets.sheets.advancing);
    const adv = advances.find(a => a.id === id);
    if (!adv) return res.status(404).json({ success: false, message: 'Advance not found' });

    // Load & concat all tech pack docs for this stage (for flag analyzer)
    const techpackDocs = await sheets.getRows(config.googleSheets.sheets.techpack);
    const techpackText = techpackDocs
      .filter(d => d.stage === adv.stage)
      .map(d => bot.stripHtml(d.content || ''))
      .join(' ');

    // Load email metadata for this show
    let storedEmails = [];
    try {
      const rows = await sheets.getRows(config.googleSheets.sheets.emails);
      storedEmails = rows.filter(e => e.showId === adv.showId);
    } catch { /* emails sheet may not exist yet */ }

    // Fetch full bodies for inbound emails (capped to most recent 30 to bound cost)
    const inbound = storedEmails
      .filter(e => (e.direction || '').toLowerCase() !== 'outbound')
      .sort((a, b) => (Date.parse(b.date) || 0) - (Date.parse(a.date) || 0))
      .slice(0, 30);

    const fullEmails = [];
    if (gmail.isConfigured()) {
      for (const e of inbound) {
        try {
          const msg = await gmail.getMessage(e.gmailMessageId);
          const parsed = gmail.parseMessage(msg);
          fullEmails.push({
            gmailMessageId: e.gmailMessageId,
            subject:        parsed.subject || e.subject,
            from:           parsed.from || e.from,
            date:           parsed.date || e.date,
            snippet:        e.snippet,
            textBody:       parsed.textBody,
            htmlBody:       parsed.htmlBody,
            attachmentMeta: JSON.stringify(parsed.attachments || []),
            direction:      e.direction,
          });
        } catch (fetchErr) {
          // Fall back to snippet-only if Gmail fetch fails
          fullEmails.push({ ...e });
        }
      }
    } else {
      // No Gmail — extractor will run against snippets only
      fullEmails.push(...inbound);
    }

    // Run extractor (structured info → fields)
    const extracted = bot.extractFromEmails(fullEmails);

    // Run legacy flag analyzer (categories vs tech pack)
    const snippets = fullEmails.map(e => e.snippet || '');
    const flagResult = bot.analyzeAdvance(adv, techpackText, snippets);

    // Persist both back to the advancing record
    await sheets.updateRowById(config.googleSheets.sheets.advancing, id, {
      botNotes:        JSON.stringify(flagResult),
      botExtracted:    JSON.stringify(extracted),
      botLastRun:      flagResult.analyzedAt,
    });

    res.json({ success: true, data: { flags: flagResult, extracted } });
  } catch (err) {
    console.error('Bot analysis error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// Accept (or dismiss) bot-extracted fields and write them onto the advance record.
// Body: { updates: { fieldKey: value, ... }, dismissKeys: ['fieldKey', ...] }
// All accepted keys (and dismissKeys) are removed from the staged `botExtracted` blob.
app.post('/api/advancing/:id/accept-extraction',
  requireAuth, requireRole('admin', 'production_manager'),
  async (req, res) => {
    try {
      const { id } = req.params;
      const { updates = {}, dismissKeys = [] } = req.body || {};

      const advances = await sheets.getRows(config.googleSheets.sheets.advancing);
      const adv = advances.find(a => a.id === id);
      if (!adv) return res.status(404).json({ success: false, message: 'Advance not found' });

      let extracted = {};
      try { extracted = adv.botExtracted ? JSON.parse(adv.botExtracted) : {}; } catch { extracted = {}; }
      const fields = extracted.fields || {};

      const sheetUpdates = {};
      for (const [key, value] of Object.entries(updates)) {
        if (value == null || String(value).trim() === '') continue;
        sheetUpdates[key] = String(value);
        delete fields[key];
      }
      for (const key of dismissKeys) {
        delete fields[key];
      }

      sheetUpdates.botExtracted = JSON.stringify({ ...extracted, fields });
      await sheets.updateRowById(config.googleSheets.sheets.advancing, id, sheetUpdates);

      res.json({ success: true, applied: Object.keys(updates), dismissed: dismissKeys });
    } catch (err) {
      console.error('Accept-extraction error:', err.message);
      res.status(500).json({ success: false, message: err.message });
    }
  }
);

// ── Production Notes — send via Gmail ────────────────────────────────────────
app.post('/api/production-notes/send', requireAuth, async (req, res) => {
  if (!gmail.isConfigured())
    return res.status(503).json({ success: false, message: 'Gmail not configured.' });
  try {
    const { to, cc, subject, html } = req.body;
    if (!to || !subject || !html)
      return res.status(400).json({ success: false, message: 'to, subject, and html are required' });
    await gmail.sendEmail({ to, cc, subject, body: html });
    res.json({ success: true });
  } catch (err) {
    console.error('Production notes send error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── Google Drive — create / get show folder ───────────────────────────────────
app.post('/api/shows/:id/drive-folder', requireAuth, async (req, res) => {
  try {
    const shows = await sheets.getRows(config.googleSheets.sheets.shows);
    const show = shows.find(s => s.id === req.params.id);
    if (!show) return res.status(404).json({ success: false, message: 'Show not found' });

    // Return existing folder if already created
    if (show.driveFolderId) {
      return res.json({
        success: true,
        folderId:  show.driveFolderId,
        folderUrl: `https://drive.google.com/drive/folders/${show.driveFolderId}`,
      });
    }

    const drive = await sheets.getDriveClient();
    const folderName = `Windjammer — ${show.date} — ${show.artist || show.eventName || 'Show'}`;

    const folder = await drive.files.create({
      requestBody: { name: folderName, mimeType: 'application/vnd.google-apps.folder' },
      fields: 'id',
    });
    const folderId = folder.data.id;

    // Make readable by anyone with the link
    await drive.permissions.create({
      fileId: folderId,
      requestBody: { role: 'reader', type: 'anyone' },
    });

    // Persist folder ID back to Shows sheet
    await sheets.updateRowById(config.googleSheets.sheets.shows, req.params.id, { driveFolderId: folderId });

    res.json({
      success:   true,
      folderId,
      folderUrl: `https://drive.google.com/drive/folders/${folderId}`,
    });
  } catch (err) {
    console.error('Drive folder error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── Save Gmail attachment to show's Drive folder ──────────────────────────────
app.post('/api/emails/save-to-drive', requireAuth, async (req, res) => {
  try {
    const { messageId, attachmentId, filename, mimeType, showId } = req.body;
    if (!messageId || !attachmentId || !filename || !showId)
      return res.status(400).json({ success: false, message: 'messageId, attachmentId, filename, showId required' });

    // Get or create the show's Drive folder
    const shows = await sheets.getRows(config.googleSheets.sheets.shows);
    const show  = shows.find(s => s.id === showId);
    if (!show) return res.status(404).json({ success: false, message: 'Show not found' });

    let folderId = show.driveFolderId;
    const drive  = await sheets.getDriveClient();

    if (!folderId) {
      const folderName = `Windjammer — ${show.date} — ${show.artist || show.eventName || 'Show'}`;
      const folder = await drive.files.create({
        requestBody: { name: folderName, mimeType: 'application/vnd.google-apps.folder' },
        fields: 'id',
      });
      folderId = folder.data.id;
      await drive.permissions.create({
        fileId: folderId,
        requestBody: { role: 'reader', type: 'anyone' },
      });
      await sheets.updateRowById(config.googleSheets.sheets.shows, showId, { driveFolderId: folderId });
    }

    // Download from Gmail
    const base64 = await gmail.getAttachmentData(messageId, attachmentId);
    const buffer = Buffer.from(base64, 'base64');

    const { Readable } = require('stream');
    const readable = Readable.from(buffer);

    const uploaded = await drive.files.create({
      requestBody: {
        name:    filename,
        mimeType: mimeType || 'application/octet-stream',
        parents: [folderId],
      },
      media: { mimeType: mimeType || 'application/octet-stream', body: readable },
      fields: 'id,webViewLink',
    });

    await drive.permissions.create({
      fileId: uploaded.data.id,
      requestBody: { role: 'reader', type: 'anyone' },
    });

    res.json({
      success:     true,
      fileId:      uploaded.data.id,
      webViewLink: uploaded.data.webViewLink,
      folderUrl:   `https://drive.google.com/drive/folders/${folderId}`,
    });
  } catch (err) {
    console.error('Save-to-drive error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── Artist Registry — Document storage (Drive-backed) ────────────────────────
// One folder per artist (lazily created). Each document is a row in the
// ArtistDocuments sheet referencing a Drive fileId. Everyone can read; PM+
// uploads and deletes (which also removes the Drive file).
async function ensureArtistFolder(artistId) {
  const artists = await sheets.getRows(config.googleSheets.sheets.artists);
  const artist  = artists.find(a => a.id === artistId);
  if (!artist) return { artist: null, folderId: null };
  if (artist.driveFolderId) return { artist, folderId: artist.driveFolderId };

  const drive = await sheets.getDriveClient();
  const folder = await drive.files.create({
    requestBody: {
      name: `Windjammer — Artist — ${artist.name || artist.id}`,
      mimeType: 'application/vnd.google-apps.folder',
    },
    fields: 'id',
  });
  const folderId = folder.data.id;
  await drive.permissions.create({
    fileId: folderId,
    requestBody: { role: 'reader', type: 'anyone' },
  });
  await sheets.updateRowById(config.googleSheets.sheets.artists, artistId, { driveFolderId: folderId });
  return { artist: { ...artist, driveFolderId: folderId }, folderId };
}

// List all documents for an artist (auth-only)
app.get('/api/artists/:id/documents', requireAuth, async (req, res) => {
  try {
    const rows = await sheets.getRows(config.googleSheets.sheets.artistDocuments);
    const docs = rows.filter(d => d.artistId === req.params.id);
    res.json({ success: true, data: docs });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Upload a document to an artist's folder (PM+)
// Body: { filename, mimeType, data (base64), type, year, notes, showId, showDate }
app.post('/api/artists/:id/documents',
  requireAuth, requireRole('admin','production_manager'),
  async (req, res) => {
    try {
      const { filename, mimeType, data, type, year, notes, showId, showDate } = req.body || {};
      if (!filename || !mimeType || !data)
        return res.status(400).json({ success: false, message: 'filename, mimeType, data required' });

      const { artist, folderId } = await ensureArtistFolder(req.params.id);
      if (!artist) return res.status(404).json({ success: false, message: 'Artist not found' });

      const drive  = await sheets.getDriveClient();
      const buffer = Buffer.from(data, 'base64');
      const readable = Readable.from(buffer);
      const uploaded = await drive.files.create({
        requestBody: { name: filename, mimeType, parents: [folderId] },
        media: { mimeType, body: readable },
        fields: 'id,webViewLink',
      });
      await drive.permissions.create({
        fileId: uploaded.data.id,
        requestBody: { role: 'reader', type: 'anyone' },
      });

      const record = {
        id:          Date.now().toString(),
        artistId:    req.params.id,
        artistName:  artist.name || '',
        name:        filename,
        type:        type || 'other',
        year:        year ? String(year) : '',
        notes:       notes || '',
        showId:      showId || '',
        showDate:    showDate || '',
        mimeType,
        driveFileId: uploaded.data.id,
        webViewLink: uploaded.data.webViewLink || `https://drive.google.com/file/d/${uploaded.data.id}/view`,
        uploadedBy:  req.user?.name || req.user?.email || '',
        createdAt:   new Date().toISOString(),
      };
      await sheets.appendRow(config.googleSheets.sheets.artistDocuments, record);

      res.json({ success: true, data: record });
    } catch (err) {
      console.error('Artist doc upload error:', err.message);
      res.status(500).json({ success: false, message: err.message });
    }
  }
);

// Delete a document — removes both the sheet row and the Drive file (PM+)
app.delete('/api/artist-documents/:id',
  requireAuth, requireRole('admin','production_manager'),
  async (req, res) => {
    try {
      const rows = await sheets.getRows(config.googleSheets.sheets.artistDocuments);
      const doc = rows.find(d => d.id === req.params.id);
      if (!doc) return res.status(404).json({ success: false, message: 'Document not found' });

      if (doc.driveFileId) {
        try {
          const drive = await sheets.getDriveClient();
          await drive.files.delete({ fileId: doc.driveFileId });
        } catch (e) {
          console.warn(`[artist-doc] Drive delete failed for ${doc.driveFileId}: ${e.message}`);
        }
      }
      await sheets.deleteRowById(config.googleSheets.sheets.artistDocuments, req.params.id);
      res.json({ success: true });
    } catch (err) {
      console.error('Artist doc delete error:', err.message);
      res.status(500).json({ success: false, message: err.message });
    }
  }
);

// ── Gmail / Email Integration ────────────────────────────────────────────────

// Helper: safely get stored emails, returns [] if sheet doesn't exist yet
async function getStoredEmails() {
  try {
    return await sheets.getRows(config.googleSheets.sheets.emails);
  } catch {
    return [];
  }
}

// ── Windjammer relevance filter ───────────────────────────────────────────────
// Every Gmail query is AND-ed with this so we only ingest show-related mail.
const WINDJAMMER_KEYWORDS = [
  'windjammer',
  '"isle of palms"',
  'IOP',
  'advance',
  'rider',
  '"load-in"',
  'load-in',
  'settlement',
];

function quoteToken(t) {
  const s = (t || '').trim();
  if (!s) return null;
  return /\s/.test(s) ? `"${s.replace(/"/g, '')}"` : s;
}

async function getAllShowNameTokens() {
  try {
    const shows = await sheets.getRows(config.googleSheets.sheets.shows);
    const set = new Set();
    for (const s of shows) {
      const a = quoteToken(s.artist);     if (a) set.add(a);
      const e = quoteToken(s.eventName);  if (e) set.add(e);
    }
    return [...set];
  } catch { return []; }
}

// Filter for the whole-inbox sync — any Windjammer keyword or any show artist/event.
async function buildInboxRelevanceFilter() {
  const showTokens = await getAllShowNameTokens();
  const tokens = [...WINDJAMMER_KEYWORDS, ...showTokens];
  return `(${tokens.join(' OR ')})`;
}

// Filter for one specific show — must reference THIS show's artist/event, or
// fall back to the general Windjammer keywords if no artist/event is recorded.
async function buildShowRelevanceFilter(showId) {
  let artist = '', eventName = '';
  try {
    const shows = await sheets.getRows(config.googleSheets.sheets.shows);
    const s = shows.find(x => x.id === showId);
    if (s) { artist = s.artist || ''; eventName = s.eventName || ''; }
  } catch {}
  const tokens = [];
  const a = quoteToken(artist);    if (a) tokens.push(a);
  const e = quoteToken(eventName); if (e) tokens.push(e);
  tokens.push('windjammer');
  return `(${tokens.join(' OR ')})`;
}

// Build searchable date variants for a YYYY-MM-DD date string.
// Returns lowercase strings to match against email subject + snippet.
function dateVariants(dateStr) {
  if (!dateStr) return [];
  const d = new Date(dateStr);
  if (isNaN(d)) return [];
  const months    = ['january','february','march','april','may','june','july','august','september','october','november','december'];
  const monthsAbb = ['jan','feb','mar','apr','may','jun','jul','aug','sep','sept','oct','nov','dec'];
  const m  = d.getUTCMonth(), day = d.getUTCDate(), y = d.getUTCFullYear();
  const pad = n => String(n).padStart(2, '0');
  return [
    dateStr.toLowerCase(),
    `${pad(m+1)}/${pad(day)}/${y}`,
    `${m+1}/${day}/${y}`,
    `${m+1}/${day}`,
    `${months[m]} ${day}`,
    `${months[m]} ${day}, ${y}`,
    `${monthsAbb[m]} ${day}`,
    `${monthsAbb[m]} ${day}, ${y}`,
    `${day} ${months[m]}`,
    `${day} ${monthsAbb[m]}`,
  ].map(s => s.toLowerCase());
}

// Classify a parsed email to the most likely show based on contact email,
// artist name (incl. registry aliases), event name, and date appearances in
// subject/snippet/from/to + the email's own send date.
// Returns { showId, showName, reason } or null if no confident match.
function classifyEmailToShow(parsed, shows, advances = [], artists = []) {
  const haystackParts = [
    parsed.subject || '',
    parsed.snippet || '',
    parsed.from || '',
    parsed.to || '',
    parsed.cc || '',
  ].map(s => String(s).toLowerCase());
  const hay = haystackParts.join(' \n ');
  const fromTo = `${parsed.from || ''} ${parsed.to || ''} ${parsed.cc || ''}`.toLowerCase();

  // Parse the email's send date (used to weight shows that are temporally close)
  let emailDate = null;
  if (parsed.date) {
    const d = new Date(parsed.date);
    if (!isNaN(d)) emailDate = d;
  }

  // Build a map of show.artist -> alias list (lowercased) from the artist registry
  // so "goose" matches a show whose artist is "Goose (full band)" via the alias entry.
  const aliasMap = new Map(); // key: show artist lowercase -> [aliases...]
  for (const a of artists) {
    const name = (a.name || '').toLowerCase().trim();
    if (!name) continue;
    const aliases = String(a.aliases || '')
      .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    aliasMap.set(name, aliases);
  }

  // 1) Advance contact email match (highest confidence)
  for (const adv of advances) {
    const ae = (adv.advanceEmail || '').toLowerCase().trim();
    if (ae && fromTo.includes(ae)) {
      const show = shows.find(s => s.id === adv.showId);
      const showName = show
        ? `${show.date || ''} — ${show.artist || show.eventName || ''}`.trim().replace(/^—\s*/, '')
        : (adv.showName || '');
      return { showId: adv.showId, showName, reason: `contact:${ae}` };
    }
  }

  // 2) Score every show by artist/event/date hits, longer tokens win.
  let best = null;
  for (const s of shows) {
    let score = 0;
    const hits = [];
    const artist = (s.artist || '').toLowerCase().trim();
    const event  = (s.eventName || '').toLowerCase().trim();

    // Artist hit (direct or via alias from artist registry)
    let artistHit = false;
    if (artist && artist.length >= 3 && hay.includes(artist)) {
      score += 10 + artist.length; hits.push(`artist:${artist}`); artistHit = true;
    } else if (artist) {
      const aliases = aliasMap.get(artist) || [];
      for (const al of aliases) {
        if (al.length >= 3 && hay.includes(al)) {
          score += 10 + al.length; hits.push(`alias:${al}`); artistHit = true; break;
        }
      }
    }

    if (event && event.length >= 4 && hay.includes(event)) {
      score += 8 + event.length; hits.push(`event:${event}`);
    }

    // Date appearance in subject/snippet
    let dateInBody = false;
    if (s.date) {
      for (const v of dateVariants(s.date)) {
        if (v.length >= 4 && hay.includes(v)) {
          score += 5; hits.push(`date:${v}`); dateInBody = true; break;
        }
      }
    }

    // Temporal proximity: email sent within 60 days before or 14 days after the show.
    // Only a small nudge — used as a tie-breaker between same-named shows in different years.
    if (emailDate && s.date) {
      const sd = new Date(s.date);
      if (!isNaN(sd)) {
        const diffDays = (sd - emailDate) / 86400000;
        if (diffDays >= -14 && diffDays <= 60) {
          score += 3; hits.push('proximity');
          // If we also matched on artist, treat date proximity as a stronger confirmation
          if (artistHit) { score += 5; }
        }
      }
    }

    if (score > 0 && (!best || score > best.score)) {
      best = { score, show: s, reason: hits.join('+'), artistHit, dateInBody };
    }
  }

  // Require either a clear artist/event hit OR a date appearance in the body.
  if (!best) return null;
  if (!best.artistHit && !best.dateInBody && best.score < 10) return null;
  if (best.score < 10) return null;

  const s = best.show;
  const showName = `${s.date || ''} — ${s.artist || s.eventName || ''}`.trim().replace(/^—\s*/, '');
  return { showId: s.id, showName, reason: best.reason };
}

// Helper: sync Gmail for one show. If an advance contact email is known,
// scope to messages to/from that address. Otherwise fall back to a
// show-relevance search across the user's inbox + sent mail.
async function syncEmailsForShow(showId, advanceEmail, showName, client = null, sourceUserId = '', sourceEmail = '', storedKeys = null) {
  if (!gmail.isConfigured() && !client) return 0;

  const relevance = await buildShowRelevanceFilter(showId);
  const query = advanceEmail
    ? `({to:${advanceEmail} from:${advanceEmail}}) ${relevance}`
    : `(in:inbox OR in:sent) ${relevance}`;
  let messageRefs;
  try {
    messageRefs = await gmail.searchEmails(query, 100, client);
  } catch (err) {
    console.error('Gmail search error for show', showId, err.message);
    return 0;
  }

  // Dedup by source+messageId so the same message in two mailboxes is stored separately.
  if (!storedKeys) {
    const existing = await getStoredEmails();
    storedKeys = new Set(existing.map(e => `${e.sourceUserId || ''}|${e.gmailMessageId}`));
  }
  const dupKey = (id) => `${sourceUserId}|${id}`;

  let newCount = 0;
  const toAppend = [];
  for (const ref of messageRefs) {
    if (storedKeys.has(dupKey(ref.id))) continue;
    try {
      const msg = await gmail.getMessage(ref.id, client);
      const parsed = gmail.parseMessage(msg);

      const meEmail = (sourceEmail || process.env.GMAIL_USER || '').toLowerCase();
      const direction = meEmail && parsed.from.toLowerCase().includes(meEmail)
        ? 'outbound' : 'inbound';

      const emailRecord = {
        id:              `${Date.now()}${Math.random().toString(36).slice(2, 6)}`,
        showId,
        showName:        showName || '',
        gmailThreadId:   parsed.gmailThreadId,
        gmailMessageId:  parsed.gmailMessageId,
        from:            parsed.from,
        to:              parsed.to,
        cc:              parsed.cc,
        subject:         parsed.subject,
        snippet:         parsed.snippet.slice(0, 300),
        date:            parsed.date,
        direction,
        attachmentMeta:  JSON.stringify(parsed.attachments),
        syncedAt:        new Date().toISOString(),
        sourceUserId,
        sourceEmail,
      };

      toAppend.push(emailRecord);
      storedKeys.add(dupKey(ref.id));
      newCount++;
    } catch (e) {
      console.error('Error syncing message', ref.id, e.message);
    }
  }
  if (toAppend.length) {
    await sheets.appendRows(config.googleSheets.sheets.emails, toAppend);
  }
  return newCount;
}

// GET /api/emails?showId=xxx  — list stored emails (with per-user visibility)
app.get('/api/emails', requireAuth, async (req, res) => {
  try {
    const { showId } = req.query;
    const all = await getStoredEmails();
    const visible = await filterEmailsByVisibility(all, req.user);
    const data = showId ? visible.filter(e => e.showId === showId) : visible;
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/emails/:id/assign  — manually link a stored email to a show
// body: { showId, setAdvanceEmail?: boolean }
// If setAdvanceEmail is true, the email's sender (or recipient if outbound)
// is also written into the Advancing record's advanceEmail so future syncs
// pick up the contact automatically.
app.post('/api/emails/:id/assign', requireAuth, requireRole('admin', 'production_manager', 'promoter'), async (req, res) => {
  try {
    const { id } = req.params;
    const { showId, setAdvanceEmail } = req.body;
    if (!showId) return res.status(400).json({ success: false, message: 'showId required' });

    // Look up the email row
    const all = await getStoredEmails();
    const email = all.find(e => e.id === id);
    if (!email) return res.status(404).json({ success: false, message: 'Email not found' });

    // Look up the show for its display name
    const shows = await sheets.getRows(config.googleSheets.sheets.shows);
    const show = shows.find(s => s.id === showId);
    if (!show) return res.status(404).json({ success: false, message: 'Show not found' });
    const showName = `${show.date || ''} — ${show.artist || show.eventName || ''}`.trim();

    // Update the email row
    await sheets.updateRowById(config.googleSheets.sheets.emails, id, { showId, showName });

    // Optionally set advance email on the Advancing record
    let advanceEmailSet = null;
    if (setAdvanceEmail) {
      // Extract just the address from "Name <addr@x.com>" if present
      const raw = email.direction === 'outbound' ? email.to : email.from;
      const m = (raw || '').match(/<([^>]+)>/);
      const addr = (m ? m[1] : raw || '').trim();
      if (addr) {
        const advances = await sheets.getRows(config.googleSheets.sheets.advancing);
        const adv = advances.find(a => a.showId === showId);
        if (adv) {
          await sheets.updateRowById(config.googleSheets.sheets.advancing, adv.id, { advanceEmail: addr });
          advanceEmailSet = addr;
        }
      }
    }

    res.json({ success: true, showId, showName, advanceEmailSet });
  } catch (err) {
    console.error('Assign email error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/emails/relink-all  — clear all show links and re-classify every
// stored email against the current shows + advances + artist registry.
// Body: { mode?: 'reset' | 'fill' }
//   - 'reset' (default): unlinks everything first, then re-matches.
//   - 'fill': only assigns links to emails that don't currently have a showId.
app.post('/api/emails/relink-all', requireAuth, requireRole('admin', 'production_manager'), async (req, res) => {
  try {
    const mode = (req.body?.mode || 'reset').toLowerCase();
    const [all, shows, advances, artists] = await Promise.all([
      getStoredEmails(),
      sheets.getRows(config.googleSheets.sheets.shows),
      sheets.getRows(config.googleSheets.sheets.advancing),
      sheets.getRows(config.googleSheets.sheets.artists).catch(() => []),
    ]);

    let cleared = 0, linked = 0, unchanged = 0, processed = 0;
    for (const row of all) {
      processed++;
      const had = !!row.showId;
      // Build a "parsed-like" object from the stored row for the classifier
      const parsed = {
        subject: row.subject || '',
        snippet: row.snippet || '',
        from:    row.from    || '',
        to:      row.to      || '',
        cc:      row.cc      || '',
        date:    row.date    || '',
      };
      const match = classifyEmailToShow(parsed, shows, advances, artists);
      const targetShowId   = match?.showId   || '';
      const targetShowName = match?.showName || '';

      if (mode === 'fill' && had) { unchanged++; continue; }

      const changed = (row.showId || '') !== targetShowId || (row.showName || '') !== targetShowName;
      if (!changed) { unchanged++; continue; }

      try {
        await sheets.updateRowById(config.googleSheets.sheets.emails, row.id, {
          showId:   targetShowId,
          showName: targetShowName,
        });
        if (targetShowId) linked++;
        else if (had) cleared++;
      } catch (e) {
        console.error('relink-all row update failed', row.id, e.message);
      }
    }

    res.json({ success: true, processed, linked, cleared, unchanged, mode });
  } catch (err) {
    console.error('relink-all error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/emails/sync  — pull Gmail for one advance record
app.post('/api/emails/sync', requireAuth, async (req, res) => {
  try {
    const picked = await pickGmailClient(req);
    if (!picked) return res.status(503).json({ success: false, message: 'Gmail not configured. Connect your Gmail in Settings.' });
    const { showId, advanceEmail, showName } = req.body;
    const count = await syncEmailsForShow(showId, advanceEmail, showName, picked.client, picked.user?.id || '', picked.user?.gmailEmail || '');
    res.json({ success: true, newEmails: count, mailbox: picked.source });
  } catch (err) {
    if (String(err.message || '').includes('invalid_grant'))
      return res.status(401).json({ success: false, message: 'Your Gmail connection has expired. Reconnect in Settings.' });
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/emails/sync-all  — sync all open advances (also called by auto-sync)
app.post('/api/emails/sync-all', requireAuth, requireRole('admin', 'production_manager', 'promoter'), async (req, res) => {
  try {
    const picked = await pickGmailClient(req);
    if (!picked) return res.status(503).json({ success: false, message: 'Gmail not configured.' });
    const advances = await sheets.getRows(config.googleSheets.sheets.advancing);
    const open = advances.filter(a => a.advancingComplete !== 'true' && a.advanceEmail);
    // Pre-fetch emails sheet once to avoid burning per-minute read quota in the loop.
    const existing = await getStoredEmails();
    const storedKeys = new Set(existing.map(e => `${e.sourceUserId || ''}|${e.gmailMessageId}`));
    let total = 0;
    for (const adv of open) {
      total += await syncEmailsForShow(adv.showId, adv.advanceEmail, adv.showName, picked.client, picked.user?.id || '', picked.user?.gmailEmail || '', storedKeys);
      // Small delay to avoid Gmail rate limits
      await new Promise(r => setTimeout(r, 300));
    }
    res.json({ success: true, synced: open.length, newEmails: total });
  } catch (err) {
    if (String(err.message || '').includes('invalid_grant'))
      return res.status(401).json({ success: false, message: 'Your Gmail connection has expired. Reconnect in Settings.' });
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/emails/send  — compose or reply to an email
app.post('/api/emails/send', requireAuth, async (req, res) => {
  if (!gmail.isConfigured())
    return res.status(503).json({ success: false, message: 'Gmail not configured. See .env.example.' });
  try {
    const { showId, showName, to, cc, subject, body, attachments, inReplyToMsgId, threadId } = req.body;
    if (!to || !subject || !body)
      return res.status(400).json({ success: false, message: 'to, subject, and body are required' });

    const sent = await gmail.sendEmail({ to, cc, subject, body, attachments, inReplyToMsgId, threadId });

    // Store the sent email in Sheets
    const emailRecord = {
      id:             `${Date.now()}${Math.random().toString(36).slice(2, 6)}`,
      showId:         showId || '',
      showName:       showName || '',
      gmailThreadId:  sent.threadId,
      gmailMessageId: sent.id,
      from:           gmail.GMAIL_USER,
      to,
      cc:             cc || '',
      subject,
      snippet:        body.replace(/<[^>]+>/g, '').slice(0, 200),
      date:           new Date().toISOString(),
      direction:      'outbound',
      attachmentMeta: JSON.stringify((attachments || []).map(a => ({ filename: a.filename, mimeType: a.mimeType, size: 0 }))),
      syncedAt:       new Date().toISOString(),
    };

    await sheets.appendRow(config.googleSheets.sheets.emails, emailRecord);
    res.json({ success: true, data: emailRecord });
  } catch (err) {
    console.error('Email send error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/emails/message/:gmailMessageId  — fetch full body + attachments from Gmail
app.get('/api/emails/message/:gmailMessageId', requireAuth, async (req, res) => {
  if (!gmail.isConfigured())
    return res.status(503).json({ success: false, message: 'Gmail not configured.' });
  try {
    const msg = await gmail.getMessage(req.params.gmailMessageId);
    const parsed = gmail.parseMessage(msg);
    res.json({
      htmlBody:    parsed.htmlBody,
      textBody:    parsed.textBody,
      attachments: parsed.attachments,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/emails/attachment  — proxy a Gmail attachment to the browser
app.get('/api/emails/attachment', requireAuth, async (req, res) => {
  if (!gmail.isConfigured())
    return res.status(503).json({ success: false, message: 'Gmail not configured.' });
  try {
    const { messageId, attachmentId, filename } = req.query;
    if (!messageId || !attachmentId)
      return res.status(400).json({ success: false, message: 'messageId and attachmentId are required' });

    const base64 = await gmail.getAttachmentData(messageId, attachmentId);
    const buffer = Buffer.from(base64, 'base64');

    res.setHeader('Content-Disposition', `attachment; filename="${filename || 'attachment'}"`);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.send(buffer);
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── Auto-sync Gmail every 15 minutes ─────────────────────────────────────────
// For every user with a connected Gmail, runs ONE broad inbox/sent search and
// uses content-based classification (artist name, event name, date, contact
// email) to bucket each new message into the right show. This replaces the
// older N-shows × N-users search pattern, so it's both faster and finds
// emails that don't reference a known advance contact.
async function runAutoSync() {
  try {
    const users = await sheets.getRows(config.googleSheets.sheets.users);
    const connected = users.filter(u => u.gmailRefreshToken);
    if (connected.length === 0) return;
    const [shows, advances, existing, artists] = await Promise.all([
      sheets.getRows(config.googleSheets.sheets.shows),
      sheets.getRows(config.googleSheets.sheets.advancing),
      getStoredEmails(),
      sheets.getRows(config.googleSheets.sheets.artists).catch(() => []),
    ]);
    if (shows.length === 0) return;
    const storedKeys = new Set(existing.map(e => `${e.sourceUserId || ''}|${e.gmailMessageId}`));
    const relevance  = await buildInboxRelevanceFilter();

    let grandTotal = 0, grandLinked = 0;
    for (const user of connected) {
      const tag = user.isHouseMailbox === 'true' ? '🏠 ' : '';
      console.log(`[auto-sync] ${tag}Scanning ${user.gmailEmail || user.username}…`);
      let client;
      try {
        client = gmail.getGmailClientForToken(user.gmailRefreshToken);
      } catch (err) {
        console.error(`[auto-sync] Failed to build client for ${user.gmailEmail}: ${err.message}`);
        continue;
      }
      let messageRefs = [];
      try {
        messageRefs = await gmail.searchEmails(`(in:inbox OR in:sent) ${relevance}`, 150, client);
      } catch (err) {
        if (String(err.message || '').includes('invalid_grant')) {
          console.warn(`[auto-sync] ${user.gmailEmail} token expired — user must reconnect.`);
          continue;
        }
        console.error(`[auto-sync] search failed for ${user.gmailEmail}: ${err.message}`);
        continue;
      }
      const toAppend = [];
      let linked = 0;
      for (const ref of messageRefs) {
        if (storedKeys.has(`${user.id}|${ref.id}`)) continue;
        try {
          const msg = await gmail.getMessage(ref.id, client);
          const parsed = gmail.parseMessage(msg);
          const meEmail = (user.gmailEmail || '').toLowerCase();
          const direction = meEmail && parsed.from.toLowerCase().includes(meEmail) ? 'outbound' : 'inbound';
          const match = classifyEmailToShow(parsed, shows, advances, artists);
          if (match) linked++;
          toAppend.push({
            id:             `${Date.now()}${Math.random().toString(36).slice(2, 6)}`,
            showId:         match?.showId   || '',
            showName:       match?.showName || '',
            gmailThreadId:  parsed.gmailThreadId,
            gmailMessageId: parsed.gmailMessageId,
            from:           parsed.from,
            to:             parsed.to,
            cc:             parsed.cc,
            subject:        parsed.subject,
            snippet:        (parsed.snippet || '').slice(0, 300),
            date:           parsed.date,
            direction,
            attachmentMeta: JSON.stringify(parsed.attachments),
            syncedAt:       new Date().toISOString(),
            sourceUserId:   user.id,
            sourceEmail:    user.gmailEmail || '',
          });
          storedKeys.add(`${user.id}|${ref.id}`);
        } catch (err) {
          console.error(`[auto-sync] message ${ref.id}: ${err.message}`);
        }
      }
      if (toAppend.length) {
        try {
          await sheets.appendRows(config.googleSheets.sheets.emails, toAppend);
          console.log(`[auto-sync] ${user.gmailEmail}: +${toAppend.length} new (${linked} auto-linked).`);
        } catch (err) {
          console.error(`[auto-sync] append failed for ${user.gmailEmail}: ${err.message}`);
        }
      }
      grandTotal  += toAppend.length;
      grandLinked += linked;
      await new Promise(r => setTimeout(r, 1000)); // brief pause between users
    }
    if (grandTotal > 0)
      console.log(`[auto-sync] Done — ${grandTotal} new email(s), ${grandLinked} auto-linked across ${connected.length} mailbox(es).`);
  } catch (err) {
    console.error('[auto-sync] Error:', err.message);
  }
}

// Kick off the first run shortly after startup, then every 15 minutes.
setTimeout(runAutoSync, 30 * 1000);
setInterval(runAutoSync, 15 * 60 * 1000);

// ── Inbox sync — pull entire Gmail inbox regardless of advance contact ────────
app.post('/api/emails/sync-inbox', requireAuth, async (req, res) => {
  try {
    const picked = await pickGmailClient(req);
    if (!picked) return res.status(503).json({ success: false, message: 'Gmail not configured.' });
    const relevance = await buildInboxRelevanceFilter();
    const messageRefs = await gmail.searchEmails(`(in:inbox OR in:sent) ${relevance}`, 150, picked.client);
    const existing = await getStoredEmails();
    const storedIds = new Set(existing.map(e => e.gmailMessageId));

    let newCount = 0;
    for (const ref of messageRefs) {
      if (storedIds.has(ref.id)) continue;
      try {
        const msg = await gmail.getMessage(ref.id, picked.client);
        const parsed = gmail.parseMessage(msg);
        const sourceEmail = picked.user?.gmailEmail || process.env.GMAIL_USER || '';
        const direction = parsed.from.toLowerCase().includes(sourceEmail.toLowerCase())
          ? 'outbound' : 'inbound';
        const emailRecord = {
          id:             `${Date.now()}${Math.random().toString(36).slice(2, 6)}`,
          showId:         '',
          showName:       '',
          gmailThreadId:  parsed.gmailThreadId,
          gmailMessageId: parsed.gmailMessageId,
          from:           parsed.from,
          to:             parsed.to,
          cc:             parsed.cc,
          subject:        parsed.subject,
          snippet:        (parsed.snippet || '').slice(0, 300),
          date:           parsed.date,
          direction,
          attachmentMeta: JSON.stringify(parsed.attachments),
          syncedAt:       new Date().toISOString(),
          sourceUserId:   picked.user?.id || '',
          sourceEmail,
        };
        await sheets.appendRow(config.googleSheets.sheets.emails, emailRecord);
        storedIds.add(ref.id);
        newCount++;
      } catch (e) {
        console.error('Error syncing inbox message', ref.id, e.message);
      }
    }
    res.json({ success: true, newEmails: newCount, mailbox: picked.source });
  } catch (err) {
    if (String(err.message || '').includes('invalid_grant'))
      return res.status(401).json({ success: false, message: 'Your Gmail connection has expired. Reconnect in Settings.' });
    console.error('Inbox sync error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── Per-user Gmail OAuth ──────────────────────────────────────────────────────────────
const OAUTH_REDIRECT_URI = process.env.OAUTH_REDIRECT_URI
  || `http://localhost:${config.port}/api/gmail/callback`;

async function getUserById(userId) {
  const users = await sheets.getRows(config.googleSheets.sheets.users);
  return users.find(u => u.id === userId);
}

// Pick a Gmail OAuth client to use for an outbound API call (sync / send / fetch).
// Order of preference:
//   1. The requesting user's own connected Gmail (if any).
//   2. Any user marked isHouseMailbox === 'true' (shared "house" account).
//   3. The legacy shared mailbox configured via env vars (may have stale token).
// Returns { client, user, source } or null if nothing usable.
async function pickGmailClient(req) {
  const users = await sheets.getRows(config.googleSheets.sheets.users);

  // 1. Requester's own Gmail
  if (req?.user?.id) {
    const me = users.find(u => u.id === req.user.id);
    if (me?.gmailRefreshToken) {
      return { client: gmail.getGmailClientForToken(me.gmailRefreshToken), user: me, source: 'self' };
    }
  }

  // 2. House mailbox
  const house = users.find(u => String(u.isHouseMailbox).toLowerCase() === 'true' && u.gmailRefreshToken);
  if (house) {
    return { client: gmail.getGmailClientForToken(house.gmailRefreshToken), user: house, source: 'house' };
  }

  // 3. Legacy env-based client (may be invalid)
  if (gmail.isConfigured()) {
    return { client: null, user: null, source: 'legacy' };
  }
  return null;
}

// Decide which stored-email rows the requesting user is allowed to see.
// Rules:
//   - rows with no sourceUserId (legacy/shared mailbox)  → visible to everyone
//   - rows whose sourceUser is flagged isHouseMailbox=true → visible to everyone
//   - rows whose sourceUserId equals the requester        → visible to that user
async function filterEmailsByVisibility(rows, requester) {
  const users = await sheets.getRows(config.googleSheets.sheets.users);
  const houseIds = new Set(users.filter(u => String(u.isHouseMailbox).toLowerCase() === 'true').map(u => u.id));
  return rows.filter(r => {
    if (!r.sourceUserId) return true;
    if (houseIds.has(r.sourceUserId)) return true;
    return r.sourceUserId === requester.id;
  });
}

// GET /api/gmail/me — current user's connection status
app.get('/api/gmail/me', requireAuth, async (req, res) => {
  try {
    if (!gmail.hasClientCredentials())
      return res.json({ success: true, configured: false });
    const u = await getUserById(req.user.id);
    res.json({
      success: true,
      configured: true,
      connected: !!(u && u.gmailRefreshToken),
      gmailEmail: u?.gmailEmail || '',
      isHouseMailbox: String(u?.isHouseMailbox).toLowerCase() === 'true',
      connectedAt: u?.gmailConnectedAt || '',
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/gmail/auth-url — returns the Google consent URL for this user
app.get('/api/gmail/auth-url', requireAuth, (req, res) => {
  if (!gmail.hasClientCredentials())
    return res.status(503).json({ success: false, message: 'Gmail client credentials not configured.' });
  // Short-lived signed state so the callback can prove which user authorized.
  const state = jwt.sign({ uid: req.user.id, t: 'gmail-oauth' }, config.jwtSecret, { expiresIn: '10m' });
  const url = gmail.buildAuthUrl({ state, redirectUri: OAUTH_REDIRECT_URI });
  res.json({ success: true, url });
});

// GET /api/gmail/callback — Google redirects here with ?code & ?state
app.get('/api/gmail/callback', async (req, res) => {
  const { code, state, error } = req.query;
  const closeHtml = (title, body, ok) => `<!doctype html><html><body style="font-family:system-ui;padding:40px;background:#0b1220;color:${ok?'#86efac':'#fca5a5'}"><h2>${title}</h2><p>${body}</p><p style="color:#94a3b8">You can close this tab.</p><script>setTimeout(()=>window.close(),1500)</script></body></html>`;
  if (error) return res.status(400).send(closeHtml('Authorization denied', String(error), false));
  if (!code || !state) return res.status(400).send(closeHtml('Missing code or state', '', false));
  try {
    const decoded = jwt.verify(state, config.jwtSecret);
    if (decoded.t !== 'gmail-oauth') throw new Error('Bad state token');
    const userId = decoded.uid;
    const { refreshToken, email } = await gmail.exchangeCodeForTokens({ code, redirectUri: OAUTH_REDIRECT_URI });
    if (!refreshToken) {
      return res.status(400).send(closeHtml('No refresh token returned',
        'Google did not issue a refresh token. Revoke the app at myaccount.google.com/permissions and try again.', false));
    }
    await sheets.updateRowById(config.googleSheets.sheets.users, userId, {
      gmailRefreshToken: refreshToken,
      gmailEmail:        email || '',
      gmailConnectedAt:  new Date().toISOString(),
    });
    res.send(closeHtml('✅ Gmail connected', `Connected as <code>${email}</code>.`, true));
  } catch (err) {
    console.error('Gmail callback error:', err.message);
    res.status(400).send(closeHtml('Authorization failed', err.message, false));
  }
});

// POST /api/gmail/disconnect — current user revokes their connection
app.post('/api/gmail/disconnect', requireAuth, async (req, res) => {
  try {
    await sheets.updateRowById(config.googleSheets.sheets.users, req.user.id, {
      gmailRefreshToken: '',
      gmailEmail:        '',
      gmailConnectedAt:  '',
      isHouseMailbox:    'false',
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/gmail/house/:userId — admin sets/unsets the "house" mailbox flag
app.post('/api/gmail/house/:userId', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const { userId } = req.params;
    const { isHouse } = req.body;
    const target = await getUserById(userId);
    if (!target) return res.status(404).json({ success: false, message: 'User not found' });
    if (isHouse && !target.gmailRefreshToken)
      return res.status(400).json({ success: false, message: 'User has not connected Gmail.' });
    await sheets.updateRowById(config.googleSheets.sheets.users, userId, {
      isHouseMailbox: isHouse ? 'true' : 'false',
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/emails/sync-mine — sync current user's connected mailbox
app.post('/api/emails/sync-mine', requireAuth, async (req, res) => {
  try {
    const u = await getUserById(req.user.id);
    if (!u || !u.gmailRefreshToken)
      return res.status(400).json({ success: false, message: 'Connect your Gmail first.' });
    const client = gmail.getGmailClientForToken(u.gmailRefreshToken);
    const relevance = await buildInboxRelevanceFilter();
    const messageRefs = await gmail.searchEmails(`(in:inbox OR in:sent) ${relevance}`, 150, client);
    const [existing, shows, advances, artists] = await Promise.all([
      getStoredEmails(),
      sheets.getRows(config.googleSheets.sheets.shows),
      sheets.getRows(config.googleSheets.sheets.advancing),
      sheets.getRows(config.googleSheets.sheets.artists).catch(() => []),
    ]);
    // Dedup is per (sourceUserId, gmailMessageId) — the same message in two users' mailboxes
    // is stored once per user so visibility/threading stays correct.
    const storedKeys = new Set(existing.map(e => `${e.sourceUserId || ''}|${e.gmailMessageId}`));

    let newCount = 0;
    let classified = 0;
    const toAppend = [];
    for (const ref of messageRefs) {
      if (storedKeys.has(`${req.user.id}|${ref.id}`)) continue;
      try {
        const msg = await gmail.getMessage(ref.id, client);
        const parsed = gmail.parseMessage(msg);
        const meEmail = (u.gmailEmail || '').toLowerCase();
        const direction = parsed.from.toLowerCase().includes(meEmail) ? 'outbound' : 'inbound';
        const match = classifyEmailToShow(parsed, shows, advances, artists);
        if (match) classified++;
        const emailRecord = {
          id:             `${Date.now()}${Math.random().toString(36).slice(2, 6)}`,
          showId:         match?.showId || '',
          showName:       match?.showName || '',
          gmailThreadId:  parsed.gmailThreadId,
          gmailMessageId: parsed.gmailMessageId,
          from:           parsed.from,
          to:             parsed.to,
          cc:             parsed.cc,
          subject:        parsed.subject,
          snippet:        (parsed.snippet || '').slice(0, 300),
          date:           parsed.date,
          direction,
          attachmentMeta: JSON.stringify(parsed.attachments),
          syncedAt:       new Date().toISOString(),
          sourceUserId:   req.user.id,
          sourceEmail:    u.gmailEmail || '',
        };
        toAppend.push(emailRecord);
        storedKeys.add(`${req.user.id}|${ref.id}`);
        newCount++;
      } catch (e) {
        console.error('sync-mine message error', ref.id, e.message);
      }
    }
    if (toAppend.length) {
      await sheets.appendRows(config.googleSheets.sheets.emails, toAppend);
    }
    res.json({ success: true, newEmails: newCount, autoLinked: classified });
  } catch (err) {
    console.error('sync-mine error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── Event scraper — fetch upcoming shows from the-windjammer.com ──────────────
app.get('/api/scrape/shows', requireAuth, async (req, res) => {
  try {
    const VENUE_URL = 'https://the-windjammer.com/events/';
    const html = await fetch(VENUE_URL, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
      signal: AbortSignal.timeout(15000),
    }).then(r => r.text());

    // Site uses custom WordPress theme — events are <div class="event-content-row"> blocks.
    // Date: <div class="event-content-date"><p><b> 23 </b> April, 2026</p></div>
    // URL/Title: <h2><a href="https://the-windjammer.com/event/SLUG">Title text</a></h2>
    // Time: <ul><li>Thursday</li><li>9:30 pm</li></ul>
    const MO = { january:'01',february:'02',march:'03',april:'04',may:'05',june:'06',
                 july:'07',august:'08',september:'09',october:'10',november:'11',december:'12' };
    const decodeHtml = s => s
      .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
      .replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ')
      .replace(/&ndash;/g, '–').replace(/&mdash;/g, '—')
      .replace(/&hellip;/g, '…').replace(/&quot;/g, '"');

    const events = [];
    const seen   = new Set();

    // Split on each event-content-row div
    const rows = html.split('<div class="event-content-row">');
    rows.shift(); // discard content before first row

    for (const row of rows) {
      // URL — first event link in the row
      const urlM = row.match(/href="(https?:\/\/the-windjammer\.com\/event\/[^"]+)"/i);
      if (!urlM) continue;
      const url = urlM[1].replace(/\/$/, '');
      if (seen.has(url)) continue;
      seen.add(url);

      // Title — from <h2><a ...>TITLE</a></h2>
      const h2M = row.match(/<h2[^>]*>\s*<a[^>]*>([^<]+)<\/a>/i);
      const title = decodeHtml(h2M ? h2M[1].trim() : url.split('/event/')[1]?.replace(/-/g,' ') || '');
      if (!title) continue;

      // Date — extract the event-content-date div, strip all HTML, then parse plain text
      // This handles &nbsp; and other entities that would break a raw HTML regex
      let date = '';
      const dateDivM = row.match(/<div[^>]*event-content-date[^>]*>([\s\S]*?)<\/div>/i);
      if (dateDivM) {
        const dateText = dateDivM[1]
          .replace(/<[^>]+>/g, ' ')        // strip all tags
          .replace(/&nbsp;/g, ' ')
          .replace(/&#\d+;/g, ' ')
          .replace(/&[a-z]+;/gi, ' ')
          .replace(/\s+/g, ' ')
          .trim();
        // Match "23 April, 2026" or "23 April 2026"
        const dmy = dateText.match(/(\d{1,2})\s+([a-z]+),?\s+(\d{4})/i);
        if (dmy) {
          const mo = MO[dmy[2].toLowerCase()] || '01';
          date = `${dmy[3]}-${mo}-${dmy[1].padStart(2, '0')}`;
        }
      }

      // Time — second <li> in the first <ul>
      const ulM = row.match(/<ul[^>]*>([\s\S]*?)<\/ul>/i);
      let showTime = '';
      if (ulM) {
        const liM = [...ulM[1].matchAll(/<li[^>]*>([^<]+)<\/li>/gi)];
        showTime = liM[1]?.[1]?.trim() || '';
      }

      const stage = /beach|n[uü]trl/i.test(title) ? 'beach' : 'inside';
      events.push({ title, date, time: showTime, stage, url });
    }

    // Normalize title: strip trailing day-of-week qualifiers like "– Thursday", "(Friday)", etc.
    const normalizeTitle = t => t
      .replace(/\s*[-–]\s*(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b.*/i, '')
      .replace(/\s*\((monday|tuesday|wednesday|thursday|friday|saturday|sunday)\)\s*$/i, '')
      .trim();

    // Sort by date (earliest first), then deduplicate multi-day shows by normalized title
    events.sort((a, b) => (a.date || '9999') < (b.date || '9999') ? -1 : 1);
    const unique    = [];
    const seenTitle = new Set();
    for (const ev of events) {
      const norm = normalizeTitle(ev.title).toLowerCase();
      if (seenTitle.has(norm)) continue;
      seenTitle.add(norm);
      unique.push({ ...ev, title: normalizeTitle(ev.title) });
    }

    // Mark duplicates against existing shows
    const existing = await sheets.getRows(config.googleSheets.sheets.shows);
    const result   = unique.map(ev => {
      const isDuplicate = existing.some(s => {
        if (ev.date && s.date && s.date !== ev.date) return false;
        const a = (s.artist || s.eventName || '').toLowerCase().slice(0, 15);
        const b = ev.title.toLowerCase().slice(0, 15);
        return a && b && (a === b || a.includes(b.slice(0, 8)) || b.includes(a.slice(0, 8)));
      });
      return { ...ev, isDuplicate };
    });

    res.json({ success: true, data: result });
  } catch (err) {
    console.error('Scrape error:', err.message);
    res.status(500).json({ success: false, message: 'Scrape failed: ' + err.message });
  }
});

// ── Import scraped events as shows ───────────────────────────────────────────
app.post('/api/scrape/import', requireAuth, requireRole('admin', 'production_manager'), async (req, res) => {
  try {
    const { events } = req.body;
    if (!Array.isArray(events) || events.length === 0)
      return res.status(400).json({ success: false, message: 'No events provided' });
    let created = 0;
    const createdShows = [];
    for (const ev of events) {
      const show = {
        id:          `${Date.now()}${Math.random().toString(36).slice(2, 6)}`,
        date:        ev.date,
        artist:      ev.title,
        eventName:   '',
        stage:       ev.stage,
        status:      'pending',
        showTime:    ev.time || '',
        doorsTime:   '',
        capacity:    '',
        ticketPrice: '',
        guarantee:   '',
        promoter:    '',
        tourManager: '',
        notes:       `Scraped from the-windjammer.com/events — ${ev.url || ''}`,
        createdAt:   new Date().toISOString(),
      };
      await sheets.appendRow(config.googleSheets.sheets.shows, show);
      createdShows.push(show);
      created++;
    }

    // Fire-and-forget kickoff for every imported show (advance row + Drive folder)
    Promise.resolve()
      .then(async () => {
        for (const s of createdShows) {
          try { await kickoffAdvanceForShow(s); }
          catch (err) { console.error('[scrape-import kickoff]', err.message); }
        }
      })
      .catch(err => console.error('[scrape-import kickoff]', err.message));

    res.json({ success: true, created });
  } catch (err) {
    console.error('Import error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── SPA catch-all (production) ────────────────────────────────────────────────
if (process.env.NODE_ENV === 'production') {
  app.get('*', (req, res) => {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.sendFile(path.join(__dirname, 'client/dist/index.html'));
  });
}

const PORT = config.port;
app.listen(PORT, () => console.log(`Windjammer server running on port ${PORT}`));
