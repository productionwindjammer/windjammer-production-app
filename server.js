require('dotenv').config();
const express = require('express');
const path = require('path');
const jwt = require('jsonwebtoken');
const config = require('./config/server-config');

const app = express();

// ── Middleware ──────────────────────────────────────────────────────────────
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname)));

// ── Auth helpers ────────────────────────────────────────────────────────────
function signToken(user) {
    return jwt.sign(
        { name: user.name, role: user.role, email: user.email || '' },
        config.jwtSecret,
        { expiresIn: '24h' }
    );
}

function requireAuth(req, res, next) {
    const auth = req.headers['authorization'] || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
    if (!token) return res.status(401).json({ success: false, message: 'Not authenticated' });
    try {
        req.user = jwt.verify(token, config.jwtSecret);
        next();
    } catch {
        res.status(401).json({ success: false, message: 'Session expired' });
    }
}

function requireRole(...roles) {
    return (req, res, next) => {
        if (!roles.includes(req.user?.role)) {
            return res.status(403).json({ success: false, message: 'Forbidden' });
        }
        next();
    };
}

// ── Google Sheets helper ────────────────────────────────────────────────────
const { google } = require('googleapis');

async function getSheetsClient() {
    const auth = new google.auth.GoogleAuth({
        keyFile: path.join(__dirname, 'config', 'google-service-account.json'),
        scopes: ['https://www.googleapis.com/auth/spreadsheets']
    });
    const authClient = await auth.getClient();
    return google.sheets({ version: 'v4', auth: authClient });
}

async function readSheet(sheetName) {
    try {
        const sheets = await getSheetsClient();
        const res = await sheets.spreadsheets.values.get({
            spreadsheetId: config.googleSheets.spreadsheetId,
            range: sheetName
        });
        const rows = res.data.values || [];
        if (rows.length < 2) return [];
        const headers = rows[0];
        return rows.slice(1).map((row, i) => {
            const obj = {};
            headers.forEach((h, j) => { obj[h] = row[j] || ''; });
            obj._rowIndex = i + 2; // 1-based, skipping header
            return obj;
        });
    } catch (err) {
        console.error(`Error reading sheet "${sheetName}":`, err.message);
        return [];
    }
}

async function updateCell(sheetName, rowIndex, colIndex, value) {
    const sheets = await getSheetsClient();
    const col = String.fromCharCode(64 + colIndex); // 1=A, 2=B, ...
    await sheets.spreadsheets.values.update({
        spreadsheetId: config.googleSheets.spreadsheetId,
        range: `${sheetName}!${col}${rowIndex}`,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [[value]] }
    });
}

async function appendRow(sheetName, values) {
    const sheets = await getSheetsClient();
    await sheets.spreadsheets.values.append({
        spreadsheetId: config.googleSheets.spreadsheetId,
        range: sheetName,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [values] }
    });
}

// ── Auth routes ─────────────────────────────────────────────────────────────
app.post('/api/auth/login', async (req, res) => {
    const { name, pin } = req.body;
    if (!name || !pin) return res.json({ success: false, message: 'Name and PIN required' });

    try {
        const users = await readSheet(config.googleSheets.sheets.users);
        const user = users.find(u =>
            u.Name && u.Name.trim().toLowerCase() === name.trim().toLowerCase() &&
            u.PIN  && u.PIN.trim() === pin.trim()
        );

        if (!user) return res.json({ success: false, message: 'Invalid name or PIN' });

        const token = signToken({ name: user.Name, role: (user.Role || 'user').toLowerCase(), email: user.Email || '' });
        res.json({ success: true, token, user: { name: user.Name, role: (user.Role || 'user').toLowerCase(), email: user.Email || '' } });
    } catch (err) {
        console.error('Login error:', err);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

app.get('/api/auth/me', requireAuth, (req, res) => {
    res.json({ success: true, user: req.user });
});

app.post('/api/auth/logout', requireAuth, (req, res) => {
    res.json({ success: true });
});

// ── Data routes ─────────────────────────────────────────────────────────────

// Productions (shows) — filtered optionally by stage
app.get('/api/productions', requireAuth, async (req, res) => {
    const { stage } = req.query;
    let productions = await readSheet(config.googleSheets.sheets.productions);
    if (stage) productions = productions.filter(p => (p.Stage || '').toLowerCase() === stage.toLowerCase());
    res.json({ success: true, data: productions });
});

// Crew — shared across both stages
app.get('/api/crew', requireAuth, async (req, res) => {
    const crew = await readSheet(config.googleSheets.sheets.crew);
    res.json({ success: true, data: crew });
});

// Tasks — filtered optionally by stage or production
app.get('/api/tasks', requireAuth, async (req, res) => {
    const { stage, production } = req.query;
    let tasks = await readSheet(config.googleSheets.sheets.tasks);
    if (stage) tasks = tasks.filter(t => (t.Stage || '').toLowerCase() === stage.toLowerCase());
    if (production) tasks = tasks.filter(t => (t.Production || t['Show Name'] || '').toLowerCase() === production.toLowerCase());
    res.json({ success: true, data: tasks });
});

// Update task status
app.post('/api/tasks/update-status', requireAuth, async (req, res) => {
    const { rowIndex, status } = req.body;
    if (!rowIndex || !status) return res.status(400).json({ success: false, message: 'rowIndex and status required' });
    try {
        // Column C = Status (adjust if your sheet differs)
        await updateCell(config.googleSheets.sheets.tasks, rowIndex, 3, status);
        res.json({ success: true });
    } catch (err) {
        console.error('Update task status error:', err);
        res.status(500).json({ success: false, message: 'Failed to update task' });
    }
});

// Equipment
app.get('/api/equipment', requireAuth, async (req, res) => {
    const { stage } = req.query;
    let equipment = await readSheet(config.googleSheets.sheets.equipment);
    if (stage) equipment = equipment.filter(e => (e.Stage || '').toLowerCase() === stage.toLowerCase());
    res.json({ success: true, data: equipment });
});

// Users (admin only)
app.get('/api/users', requireAuth, requireRole('admin', 'owner'), async (req, res) => {
    const users = await readSheet(config.googleSheets.sheets.users);
    res.json({ success: true, data: users.map(u => ({ name: u.Name, role: u.Role, email: u.Email })) });
});

// ── Stages info ─────────────────────────────────────────────────────────────
app.get('/api/stages', requireAuth, (req, res) => {
    res.json({ success: true, stages: Object.values(config.stages) });
});

// ── Serve SPA ───────────────────────────────────────────────────────────────
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// ── Start ───────────────────────────────────────────────────────────────────
const PORT = config.port;
app.listen(PORT, () => {
    console.log(`\n🎭 Windjammer Production App running on http://localhost:${PORT}`);
    console.log(`   Inside Stage  |  Beach Stage\n`);
});
