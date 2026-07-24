/**
 * Run once to initialize all Google Sheet tabs with correct headers.
 *
 * Usage:
 *   node scripts/setup-sheets.js
 *
 * Requirements:
 *   - .env file with SPREADSHEET_ID and either GOOGLE_SERVICE_ACCOUNT or
 *     config/google-service-account.json present
 */

require('dotenv').config();
const { google } = require('googleapis');
const path = require('path');

const SPREADSHEET_ID = process.env.SPREADSHEET_ID;

if (!SPREADSHEET_ID) {
  console.error('ERROR: SPREADSHEET_ID not set in .env');
  process.exit(1);
}

// ── Sheet definitions ─────────────────────────────────────────────────────────
const SHEETS = [
  {
    name: 'Users',
    headers: ['id', 'name', 'email', 'password', 'role', 'active', 'createdAt'],
    note: 'Roles: admin | production_manager | stagehand | vendor'
  },
  {
    name: 'Shows',
    headers: [
      'id', 'date', 'artist', 'eventName', 'stage', 'status',
      'showTime', 'doorsTime', 'capacity', 'ticketPrice', 'guarantee',
      'promoter', 'tourManager', 'advancingComplete', 'settled', 'notes', 'createdAt'
    ]
  },
  {
    name: 'Advancing',
    headers: [
      'id', 'showId', 'showName', 'stage',
      'riderReceived', 'riderNotes',
      'stagingChanges', 'capacityChanges',
      'soundRestrictions', 'curfew',
      'productionNeeds', 'backlineNotes',
      'cateringNotes', 'hospitalityNotes',
      'localCrewNeeds', 'advancingComplete',
      'advanceContact', 'advancePhone', 'advanceEmail',
      'notes', 'createdAt'
    ]
  },
  {
    name: 'Schedule',
    headers: [
      'id', 'showId', 'showName', 'stage', 'date',
      'label', 'time', 'duration', 'responsible', 'notes', 'createdAt'
    ]
  },
  {
    name: 'Labor',
    headers: [
      'id', 'showId', 'showName', 'stage',
      'workerName', 'role', 'callTime', 'wrapTime',
      'hours', 'rate', 'total', 'union', 'notes', 'createdAt'
    ]
  },
  {
    name: 'Vendors',
    headers: [
      'id', 'company', 'contactName', 'phone', 'email',
      'category', 'website', 'notes', 'active', 'createdAt'
    ]
  },
  {
    name: 'VendorBookings',
    headers: [
      'id', 'showId', 'showName', 'vendorId', 'vendorName',
      'service', 'confirmedDate', 'amount', 'paid', 'notes', 'createdAt'
    ]
  },
  {
    name: 'Settlement',
    headers: [
      'id', 'showId', 'showName', 'stage',
      'artistGuarantee', 'ticketRevenue', 'otherRevenue', 'totalRevenue',
      'productionCost', 'laborCost', 'vendorCost', 'cateringCost', 'securityCost', 'miscCost',
      'totalCosts', 'netSettlement',
      'artistPayment', 'artistPaymentDate', 'artistPaymentMethod',
      'settledBy', 'status', 'notes', 'createdAt'
    ]
  },
  {
    name: 'Staff',
    headers: [
      'id', 'name', 'role', 'email', 'phone', 'department',
      'startDate', 'stage', 'onboardingComplete', 'certifications', 'notes', 'active', 'createdAt'
    ]
  },
  {
    name: 'TechPack',
    headers: ['id', 'stage', 'docType', 'title', 'content', 'updatedAt']
  },
  {
    name: 'PatchLists',
    headers: [
      'id', 'showId', 'artistId', 'artistName', 'name',
      'inputPatchPoints', 'outputPatchPoints',
      'inputs', 'outputs',
      'isTemplate', 'createdBy', 'createdAt', 'updatedAt'
    ],
    note: 'inputs/outputs/patch-points stored as JSON blobs'
  }
];

// ── Auth ──────────────────────────────────────────────────────────────────────
function getAuth() {
  if (process.env.GOOGLE_SERVICE_ACCOUNT) {
    return new google.auth.GoogleAuth({
      credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT),
      scopes: ['https://www.googleapis.com/auth/spreadsheets']
    });
  }
  return new google.auth.GoogleAuth({
    keyFile: path.join(__dirname, '..', 'config', 'google-service-account.json'),
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  });
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function run() {
  const auth   = getAuth();
  const client = await auth.getClient();
  const api    = google.sheets({ version: 'v4', auth: client });

  // Get existing sheets
  const meta = await api.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
  const existing = new Set(meta.data.sheets.map(s => s.properties.title));

  // Create missing tabs
  const toCreate = SHEETS.filter(s => !existing.has(s.name));
  if (toCreate.length > 0) {
    console.log(`Creating ${toCreate.length} new tab(s): ${toCreate.map(s => s.name).join(', ')}`);
    await api.spreadsheets.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      resource: {
        requests: toCreate.map(s => ({
          addSheet: { properties: { title: s.name } }
        }))
      }
    });
  } else {
    console.log('All tabs already exist — will write headers only.');
  }

  // Write headers row to each sheet (row 1 only — does NOT overwrite existing data)
  for (const sheet of SHEETS) {
    // Check if row 1 already has data
    const existing = await api.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${sheet.name}!A1:A1`
    });
    if (existing.data.values?.length) {
      console.log(`  ⏭  ${sheet.name} — headers already present, skipping`);
      continue;
    }
    await api.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `${sheet.name}!A1`,
      valueInputOption: 'RAW',
      resource: { values: [sheet.headers] }
    });
    console.log(`  ✅ ${sheet.name} — ${sheet.headers.length} columns written`);
    if (sheet.note) console.log(`     Note: ${sheet.note}`);
  }

  // Seed default TechPack documents if empty
  const tpCheck = await api.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: 'TechPack!A2:A2'
  });
  if (!tpCheck.data.values?.length) {
    const DOC_TYPES = [
      { key: 'overview',  label: 'Stage Overview & Specs' },
      { key: 'techpack',  label: 'Full Tech Pack' },
      { key: 'lighting',  label: 'Lighting Patch & Fixture List' },
      { key: 'audio',     label: 'Audio Spec Sheet' },
      { key: 'stageplot', label: 'Stage Plot / Dimensions' },
      { key: 'power',     label: 'Power Distribution' },
      { key: 'catering',  label: 'Catering / Hospitality Rider' },
      { key: 'loadinmap', label: 'Load-in Map / Directions' },
    ];
    const rows = [];
    let idCounter = 1;
    for (const stage of ['inside', 'beach']) {
      for (const doc of DOC_TYPES) {
        rows.push([String(idCounter++), stage, doc.key, doc.label, '', '']);
      }
    }
    await api.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: 'TechPack',
      valueInputOption: 'RAW',
      resource: { values: rows }
    });
    console.log(`  ✅ TechPack — seeded ${rows.length} default documents (8 per stage)`);
  } else {
    console.log('  ⏭  TechPack — documents already seeded, skipping');
  }

  console.log('\nSetup complete!\n');
  console.log('Next: add your first admin user to the Users tab.');
  console.log('Use this command to generate a bcrypt password hash:\n');
  console.log('  node scripts/hash-password.js yourpassword\n');
}

run().catch(err => {
  console.error('Setup failed:', err.message);
  process.exit(1);
});
