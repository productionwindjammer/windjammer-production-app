require('dotenv').config();
const { google } = require('googleapis');
const path = require('path');

const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const SHEET_NAME = 'Shows';

async function main() {
  let auth;
  if (process.env.GOOGLE_SERVICE_ACCOUNT) {
    const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT);
    auth = new google.auth.GoogleAuth({ credentials, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
  } else {
    auth = new google.auth.GoogleAuth({
      keyFile: path.join(__dirname, '../config/google-service-account.json'),
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
  }
  const client = await auth.getClient();
  const api = google.sheets({ version: 'v4', auth: client });

  // Get current data to find how many rows exist
  const res = await api.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: SHEET_NAME });
  const rows = res.data.values || [];
  const total = rows.length;
  if (total <= 1) {
    console.log('No data rows to delete (sheet is already empty or only has a header).');
    return;
  }

  // Get the internal sheetId
  const meta = await api.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
  const sheet = meta.data.sheets.find(s => s.properties.title === SHEET_NAME);
  if (!sheet) throw new Error('Shows sheet not found');
  const sheetId = sheet.properties.sheetId;

  // Delete all rows after the header (rows 2 → end)
  await api.spreadsheets.batchUpdate({
    spreadsheetId: SPREADSHEET_ID,
    resource: {
      requests: [{
        deleteDimension: {
          range: {
            sheetId,
            dimension: 'ROWS',
            startIndex: 1,       // row index 1 = 2nd row (0-based), keeps header
            endIndex: total,
          }
        }
      }]
    }
  });

  console.log(`Done — deleted ${total - 1} show row(s). Header preserved.`);
}

main().catch(err => { console.error(err.message); process.exit(1); });
