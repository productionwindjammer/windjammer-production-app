require('dotenv').config();
const { google } = require('googleapis');
const path = require('path');

const SPREADSHEET_ID = process.env.SPREADSHEET_ID;

const SCOPES = [
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/drive.file',
];

function getAuth() {
  if (process.env.GOOGLE_SERVICE_ACCOUNT) {
    const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT);
    return new google.auth.GoogleAuth({ credentials, scopes: SCOPES });
  }
  return new google.auth.GoogleAuth({
    keyFile: path.join(__dirname, 'config/google-service-account.json'),
    scopes: SCOPES,
  });
}

async function getSheetsClient() {
  const auth = getAuth();
  const client = await auth.getClient();
  return google.sheets({ version: 'v4', auth: client });
}

async function getRows(sheetName) {
  const api = await getSheetsClient();
  let response;
  try {
    response = await api.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: sheetName,
    });
  } catch (err) {
    if (String(err.message || '').includes('Unable to parse range')) return [];
    throw err;
  }
  const [headers, ...rows] = response.data.values || [];
  if (!headers) return [];
  return rows.map(row => {
    const obj = {};
    headers.forEach((h, i) => { obj[h] = row[i] !== undefined ? row[i] : ''; });
    return obj;
  });
}

async function appendRow(sheetName, data) {
  const api = await getSheetsClient();
  await ensureHeaders(sheetName, Object.keys(data), api);
  const response = await api.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${sheetName}!1:1`,
  });
  const headers = response.data.values?.[0] || Object.keys(data);
  const row = headers.map(h => data[h] !== undefined ? String(data[h]) : '');
  await api.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: sheetName,
    valueInputOption: 'USER_ENTERED',
    resource: { values: [row] },
  });
}

// Append many rows in a single API call. Ensures headers once.
// Returns the number of rows appended.
async function appendRows(sheetName, dataArr) {
  if (!dataArr || dataArr.length === 0) return 0;
  const api = await getSheetsClient();
  const allKeys = Array.from(new Set(dataArr.flatMap(d => Object.keys(d))));
  const headers = await ensureHeaders(sheetName, allKeys, api);
  const values = dataArr.map(d => headers.map(h => d[h] !== undefined ? String(d[h]) : ''));
  await api.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: sheetName,
    valueInputOption: 'USER_ENTERED',
    resource: { values },
  });
  return dataArr.length;
}

async function updateRowById(sheetName, id, data) {
  const api = await getSheetsClient();
  await ensureHeaders(sheetName, Object.keys(data), api);
  const response = await api.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: sheetName,
  });
  const [headers, ...rows] = response.data.values || [];
  if (!headers) throw new Error('Sheet not found or empty');
  const idIdx = headers.indexOf('id');
  const rowIdx = rows.findIndex(r => r[idIdx] === id);
  if (rowIdx === -1) throw new Error('Record not found');
  const sheetRow = rowIdx + 2;
  const updatedRow = headers.map((h, i) =>
    data[h] !== undefined ? String(data[h]) : (rows[rowIdx][i] || '')
  );
  await api.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `${sheetName}!A${sheetRow}`,
    valueInputOption: 'USER_ENTERED',
    resource: { values: [updatedRow] },
  });
}

// Make sure a tab with the given title exists in the spreadsheet. Idempotent.
async function ensureSheet(sheetName, api) {
  api = api || (await getSheetsClient());
  const meta = await api.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
  const exists = meta.data.sheets.some(s => s.properties.title === sheetName);
  if (exists) return false;
  await api.spreadsheets.batchUpdate({
    spreadsheetId: SPREADSHEET_ID,
    resource: { requests: [{ addSheet: { properties: { title: sheetName } } }] },
  });
  return true;
}

// Make sure every key in `keys` exists as a column header in the sheet.
// Appends any new headers to the right of the current header row. No-op if all present.
async function ensureHeaders(sheetName, keys, api) {
  api = api || (await getSheetsClient());
  let headerRes;
  try {
    headerRes = await api.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${sheetName}!1:1`,
    });
  } catch (err) {
    // Sheet/tab probably doesn't exist yet — create it and retry once.
    if (String(err.message || '').includes('Unable to parse range')) {
      await ensureSheet(sheetName, api);
      headerRes = await api.spreadsheets.values.get({
        spreadsheetId: SPREADSHEET_ID,
        range: `${sheetName}!1:1`,
      });
    } else { throw err; }
  }
  const current = headerRes.data.values?.[0] || [];
  const missing = keys.filter(k => k && !current.includes(k));
  if (missing.length === 0) return current;
  const updated = current.concat(missing);
  await api.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `${sheetName}!1:1`,
    valueInputOption: 'RAW',
    resource: { values: [updated] },
  });
  return updated;
}

async function deleteRowById(sheetName, id) {
  const api = await getSheetsClient();
  const meta = await api.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
  const sheet = meta.data.sheets.find(s => s.properties.title === sheetName);
  if (!sheet) throw new Error('Sheet not found');
  const sheetId = sheet.properties.sheetId;
  const response = await api.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: sheetName,
  });
  const [headers, ...rows] = response.data.values || [];
  const idIdx = headers.indexOf('id');
  const rowIdx = rows.findIndex(r => r[idIdx] === id);
  if (rowIdx === -1) throw new Error('Record not found');
  await api.spreadsheets.batchUpdate({
    spreadsheetId: SPREADSHEET_ID,
    resource: {
      requests: [{
        deleteDimension: {
          range: {
            sheetId,
            dimension: 'ROWS',
            startIndex: rowIdx + 1,
            endIndex: rowIdx + 2,
          }
        }
      }]
    }
  });
}

// Root folder (or Shared Drive) ID where this app's files live.
// Set DRIVE_ROOT_FOLDER_ID to either:
//   • a Shared Drive ID (preferred — service account writes use the drive's quota), or
//   • a regular Drive folder ID shared with the service account from a user
//     account (files use that user's quota, anyone-link permissions work).
function getDriveRoot() {
  return (
    process.env.DRIVE_ROOT_FOLDER_ID ||
    process.env.SHARED_DRIVE_ID ||
    process.env.GDRIVE_SHARED_DRIVE_ID ||
    ''
  );
}

async function getDriveClient() {
  // Prefer the OAuth user (e.g. productionwindjammer@gmail.com) for Drive when
  // a refresh token is available. Service accounts have 0 storage quota, so
  // files they create fail uploading even into folders shared with them.
  // OAuth users have their own Drive quota (15GB free) and own the files
  // they create, which sidesteps the quota error entirely.
  let drive;
  if (
    process.env.GMAIL_CLIENT_ID &&
    process.env.GMAIL_CLIENT_SECRET &&
    process.env.GMAIL_REFRESH_TOKEN
  ) {
    const oauth = new google.auth.OAuth2(
      process.env.GMAIL_CLIENT_ID,
      process.env.GMAIL_CLIENT_SECRET
    );
    oauth.setCredentials({ refresh_token: process.env.GMAIL_REFRESH_TOKEN });
    drive = google.drive({ version: 'v3', auth: oauth });
  } else {
    const auth = getAuth();
    const client = await auth.getClient();
    drive = google.drive({ version: 'v3', auth: client });
  }
  const root = getDriveRoot();

  // Wrap files.create / files.delete / permissions.create so every call
  // automatically uses supportsAllDrives and parents into the root folder.
  const origCreate = drive.files.create.bind(drive.files);
  drive.files.create = (params = {}, opts) => {
    const p = { ...params, supportsAllDrives: true };
    if (p.requestBody && !p.requestBody.parents && root) {
      p.requestBody = { ...p.requestBody, parents: [root] };
    }
    return origCreate(p, opts);
  };

  const origDelete = drive.files.delete.bind(drive.files);
  drive.files.delete = (params = {}, opts) =>
    origDelete({ ...params, supportsAllDrives: true }, opts);

  const origPerm = drive.permissions.create.bind(drive.permissions);
  drive.permissions.create = async (params = {}, opts) => {
    try {
      return await origPerm({ ...params, supportsAllDrives: true }, opts);
    } catch (err) {
      // Shared Drives often forbid "anyone with link" perms by policy — log
      // and continue. The file is still accessible to anyone with access to
      // the Shared Drive itself.
      console.warn('[drive] permissions.create skipped:', err.message);
      return { data: null };
    }
  };

  const origList = drive.files.list.bind(drive.files);
  drive.files.list = (params = {}, opts) =>
    origList(
      { ...params, supportsAllDrives: true, includeItemsFromAllDrives: true },
      opts
    );

  return drive;
}

module.exports = { getRows, appendRow, appendRows, updateRowById, deleteRowById, getDriveClient, getDriveRoot, ensureHeaders, ensureSheet };
