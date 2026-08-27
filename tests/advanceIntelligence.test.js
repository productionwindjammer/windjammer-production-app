'use strict';

/**
 * Advance Intelligence — end-to-end.
 *
 * Feeds the SYNTHETIC_DEMO_EMAIL (multi-message thread with dozens of
 * operational details) through the full pipeline with a StubProvider
 * standing in as the LLM. Verifies:
 *
 *   - Comprehensive schema coverage (every category with evidence has atoms).
 *   - Field-fact reconciliation runs against rules-v1 output.
 *   - Show-state diff identifies changes vs existingShowData.
 *   - Persist writes to AdvanceFacts and dedupes on re-run.
 *   - PM view has actionable sections.
 */

const test   = require('node:test');
const assert = require('node:assert/strict');
const path   = require('node:path');

// ── In-memory sheets fake (same pattern as productionExtractor.test.js) ────
const store = new Map();
function resetStore() {
  store.clear();
  for (const s of ['VenueKnowledge','VenueKnowledgeHistory','EmailFacts','EmailThreads','EmailIssues','AiChangeLog','Shows','Advancing','Schedule','AdvanceFacts']) {
    store.set(s, []);
  }
}
const fakeSheets = {
  async getRows(name)          { return (store.get(name) || []).map(r => ({ ...r })); },
  async appendRow(name, row)   { if (!store.has(name)) store.set(name, []); store.get(name).push({ ...row }); },
  async appendRows(name, rows) { for (const r of rows) await fakeSheets.appendRow(name, r); },
  async updateRowById(name, id, patch) {
    const rows = store.get(name) || [];
    const i = rows.findIndex(r => String(r.id) === String(id));
    if (i < 0) throw new Error('missing row ' + id);
    rows[i] = { ...rows[i], ...patch };
  },
  async deleteRowById(name, id) { store.set(name, (store.get(name)||[]).filter(r => String(r.id)!==String(id))); },
  async ensureHeaders() {}, async ensureSheet() {},
};
const sheetsPath = path.resolve(__dirname, '..', 'sheets.js');
require.cache[sheetsPath] = { id: sheetsPath, filename: sheetsPath, loaded: true, exports: fakeSheets };

const advance         = require('../advanceIntelligence');
const { StubProvider } = require('../llm/provider');
const { COMPREHENSIVE_SCHEMA, CATEGORIES } = require('../llm/comprehensiveSchema');

// The stub's job is to model what a compliant LLM would emit. We keep it
// intentionally short but populate every category so the test proves the
// pipeline propagates each one end-to-end. Provenance points at real
// message ids from the demo email.
function buildStubOutput() {
  const msg1 = 'demo-msg-1';
  const msg2 = 'demo-msg-2';
  const prov = (id, text, sender = 'Jane Doe', email = 'jane@examplemgmt.com') => ({
    source_message_id: id, quoted_text: text, sender, sender_email: email, sender_org: 'Nova Falls Touring',
  });
  return {
    people: [
      { full_name: 'Jane Doe',      role: 'Tour Manager',          role_category: 'tour_manager',           organization: 'Nova Falls Touring',  emails: ['jane@examplemgmt.com'],       is_decision_maker: true,  is_action_owner: true,  info_only: false, status: 'confirmed', confidence: 'high',   provenance: prov(msg1, 'I\'m the Tour Manager.') },
      { full_name: 'Mark Rivera',   role: 'Production Manager',    role_category: 'production_manager',     organization: 'Nova Falls Touring',  emails: ['mark@novafalls.tour'],        phones: ['+1-555-201-9902'], is_decision_maker: true,  is_action_owner: true,  info_only: false, status: 'confirmed', confidence: 'high',   provenance: prov(msg1, 'Mark Rivera, Production Manager, Nova Falls Touring, mark@novafalls.tour, +1-555-201-9902') },
      { full_name: 'Priya Shah',    role: 'FOH Engineer',          role_category: 'foh_engineer',           phones: ['+1-555-201-4110'],                                                                                                        status: 'confirmed', confidence: 'high',   provenance: prov(msg1, 'Priya Shah, FOH Engineer, +1-555-201-4110') },
      { full_name: 'Diego Morales', role: 'Monitor Engineer',      role_category: 'monitor_engineer',                                                                                                                                             status: 'confirmed', confidence: 'medium', provenance: prov(msg1, 'Diego Morales, Monitor Engineer') },
      { full_name: 'Alex Kim',      role: 'Lighting Designer',     role_category: 'lighting_designer',      organization: 'Spectral Lighting Co.', emails: ['alex@spectrall.co'],                                                                 status: 'confirmed', confidence: 'high',   provenance: prov(msg1, 'Alex Kim, Lighting Designer, alex@spectrall.co (Spectral Lighting Co.)') },
      { full_name: 'Sam Lee',       role: 'Head Rigger',           role_category: 'head_rigger',            organization: 'Big Top Rigging',        emails: ['sam@bigtoprig.com'],                                                                status: 'confirmed', confidence: 'high',   provenance: prov(msg1, 'Sam Lee, Head Rigger, sam@bigtoprig.com (Big Top Rigging)') },
      { full_name: 'Terry Nguyen',  role: 'Bus Driver',            role_category: 'bus_driver',             phones: ['+1-555-201-8877'],                                                                                                        status: 'confirmed', confidence: 'high',   provenance: prov(msg1, 'Bus driver: Terry Nguyen, +1-555-201-8877') },
    ],
    organizations: [
      { name: 'Nova Falls Touring',   type: 'artist_org',   status: 'confirmed', confidence: 'high', provenance: prov(msg1, 'Nova Falls Touring') },
      { name: 'Spectral Lighting Co.', type: 'equipment_vendor', status: 'confirmed', confidence: 'high', provenance: prov(msg1, '(Spectral Lighting Co.)') },
      { name: 'Big Top Rigging',      type: 'equipment_vendor', status: 'confirmed', confidence: 'high', provenance: prov(msg1, '(Big Top Rigging)') },
    ],
    schedule: [
      { kind: 'truck_arrival', time_local_hhmm: '06:00', time_text: '6:00 AM',  status: 'proposed', confidence: 'high', provenance: prov(msg1, 'Truck arrival: 6:00 AM (2 trucks — 53\' tractor-trailers)') },
      { kind: 'load_in',       time_local_hhmm: '08:00', time_text: '8:00 AM',  status: 'proposed', confidence: 'high', provenance: prov(msg1, 'Load-in: 8:00 AM') },
      { kind: 'rigger_call',   time_local_hhmm: '07:30', time_text: '7:30 AM',  status: 'proposed', confidence: 'high', provenance: prov(msg1, 'Rigger call: 7:30 AM') },
      { kind: 'soundcheck',    time_local_hhmm: '15:30', time_text: '3:30 PM',  status: 'proposed', confidence: 'high', provenance: prov(msg1, 'Soundcheck: 3:30 PM') },
      { kind: 'doors',         time_local_hhmm: '18:30', time_text: '6:30 PM',  status: 'proposed', confidence: 'high', provenance: prov(msg1, 'Doors: 6:30 PM') },
      { kind: 'show',          time_local_hhmm: '20:45', time_text: '8:45 PM',  status: 'proposed', confidence: 'high', provenance: prov(msg1, 'Show: 8:45 PM') },
      { kind: 'curfew',        time_local_hhmm: '23:15', time_text: '11:15 PM', status: 'confirmed', confidence: 'high', provenance: prov(msg2, 'Curfew is still 11:15 PM hard.', 'Mark Rivera', 'mark@novafalls.tour') },
    ],
    production: [
      { category: 'audio',    path: 'consoles.foh',         value: 'DiGiCo SD10',  status: 'confirmed', confidence: 'high', provenance: prov(msg1, 'Audio: FOH DiGiCo SD10') },
      { category: 'audio',    path: 'wireless.channels',    count: 24,             status: 'requested', confidence: 'high', needs_venue_approval: true, provenance: prov(msg1, '24 channels of wireless mics') },
      { category: 'lighting', path: 'moving_lights.total',  count: 32,             status: 'requested', confidence: 'high', provenance: prov(msg1, '32 moving lights') },
      { category: 'video',    path: 'led.wall_size',        value: '20x11 P2.9',   status: 'proposed',  confidence: 'high', provenance: prov(msg2, 'P2.9 20\'x11\' wall', 'Mark Rivera', 'mark@novafalls.tour') },
      { category: 'rigging',  path: 'chain_motors.total',   count: 18,             status: 'requested', confidence: 'high', needs_specialist: true, provenance: prov(msg1, '18 chain motors') },
      { category: 'power',    path: 'stage_service',        value: '400A 3-phase', status: 'requested', confidence: 'high', needs_venue_approval: true, provenance: prov(msg1, '400A 3-phase at stage') },
      { category: 'rf',       path: 'iem.channels',         count: 12,             status: 'requested', confidence: 'high', provenance: prov(msg1, '12 IEM channels') },
      { category: 'fx',       path: 'co2.jets',             count: 4,              status: 'requested', confidence: 'high', needs_permit: true, needs_venue_approval: true, provenance: prov(msg1, '4 CO2 jets during song 6') },
    ],
    labor: [
      { department: 'stagehand',    headcount: 12, call_time: '08:00',                 status: 'requested', confidence: 'high', provenance: prov(msg1, '12 stagehands @ 8:00 AM') },
      { department: 'electrician',  headcount: 2,  call_time: '08:00',                 status: 'requested', confidence: 'high', provenance: prov(msg1, '2 electricians @ 8:00 AM') },
      { department: 'rigger',       headcount: 8,  call_time: '07:30', responsibilities: '4 up-riggers, 4 ground', status: 'requested', confidence: 'high', provenance: prov(msg1, '4 up-riggers, 4 ground-riggers') },
      { department: 'forklift_op',  headcount: 1,  call_time: '06:00',                 status: 'requested', confidence: 'high', provenance: prov(msg1, '1 forklift + operator @ 6:00 AM') },
    ],
    hospitality: [
      { category: 'dressing_room', count: 4,                                                        status: 'requested', confidence: 'high', provenance: prov(msg1, '4 dressing rooms') },
      { category: 'meal', count: 22, description: 'breakfast', time_hhmm: '06:30',                  status: 'requested', confidence: 'high', provenance: prov(msg1, 'Breakfast for 22 at 6:30 AM') },
      { category: 'meal', count: 40, description: 'lunch',     time_hhmm: '12:30',                  status: 'requested', confidence: 'high', provenance: prov(msg1, 'Lunch for 40 at 12:30 PM') },
      { category: 'meal', count: 40, description: 'dinner',    time_hhmm: '17:30', dietary: 'one member vegan', status: 'requested', confidence: 'high', provenance: prov(msg1, 'one member is vegan') },
      { category: 'shower', count: 8,                                                               status: 'requested', confidence: 'high', provenance: prov(msg1, 'Showers for 8') },
      { category: 'runner', count: 1, description: 'load-in and load-out',                          status: 'requested', confidence: 'high', provenance: prov(msg1, '1 runner during load-in and load-out') },
    ],
    transportation: [
      { kind: 'truck',    count: 3, arrival_time: '06:00-07:00', parking_required: true,                                        status: 'proposed', confidence: 'high', notes: 'was 2, updated to 3 in msg2', provenance: prov(msg2, 'adding a third truck', 'Mark Rivera', 'mark@novafalls.tour') },
      { kind: 'tour_bus', count: 1, arrival_time: '05:00', parking_required: true, overnight_parking: true, driver_name: 'Terry Nguyen', driver_phone: '+1-555-201-8877', status: 'proposed', confidence: 'high', provenance: prov(msg1, '1 tour bus arriving 5 AM (needs overnight parking + shore power)') },
    ],
    venue_requirements: [
      { requirement: '400A 3-phase at stage',              category: 'power', action_owner: 'venue', status: 'requested', confidence: 'high', provenance: prov(msg1, 'Please confirm venue can accommodate.') },
      { requirement: 'Provide venue RF coordinator contact', category: 'rf',    action_owner: 'venue', status: 'requested', confidence: 'high', provenance: prov(msg1, 'Please provide venue RF coord contact.') },
      { requirement: 'Rigging engineer sign-off',           category: 'rigging', action_owner: 'venue', status: 'requested', confidence: 'high', provenance: prov(msg1, 'confirm venue rigging engineer sign-off deadline') },
      { requirement: 'Dock access for 53\' truck at 6 AM',  category: 'access',  action_owner: 'venue', status: 'requested', confidence: 'high', provenance: prov(msg2, 'loading dock can accept a 53\' at 6 AM', 'Mark Rivera', 'mark@novafalls.tour') },
      { requirement: 'Pyro/CO2 permit',                     category: 'operations', action_owner: 'venue', status: 'requested', confidence: 'high', provenance: prov(msg1, 'Requires permit and venue approval.') },
      { requirement: 'Overnight bus parking + shore power', category: 'transportation', action_owner: 'venue', status: 'requested', confidence: 'high', provenance: prov(msg1, 'needs overnight parking + shore power') },
      { requirement: 'Barrier-free artist entrance',        category: 'access',  action_owner: 'venue', status: 'requested', confidence: 'high', provenance: prov(msg1, 'need barrier-free artist entrance') },
    ],
    responsibilities: [
      { action: 'Provide RF coordination', party: 'venue', status: 'requested', confidence: 'high', provenance: prov(msg1, 'Please provide venue RF coord contact.') },
      { action: 'Confirm dock availability at 6 AM', party: 'venue', status: 'requested', confidence: 'high', provenance: prov(msg2, 'loading dock can accept a 53\' at 6 AM', 'Mark Rivera', 'mark@novafalls.tour') },
      { action: 'Provide CO2/pyro permit', party: 'venue', status: 'requested', confidence: 'high', provenance: prov(msg1, 'Requires permit and venue approval.') },
    ],
    tasks: [
      { title: 'Confirm 400A 3-phase capacity', priority: 'high',     owner_party: 'venue', status: 'requested', confidence: 'high', provenance: prov(msg1, 'Please confirm venue can accommodate.') },
      { title: 'Provide RF coordinator contact', priority: 'high',     owner_party: 'venue', status: 'requested', confidence: 'high', provenance: prov(msg1, 'Please provide venue RF coord contact.') },
      { title: 'Get pyro/CO2 permit approved',   priority: 'critical', owner_party: 'venue', status: 'requested', confidence: 'high', provenance: prov(msg1, '4 CO2 jets during song 6. Requires permit and venue approval.') },
      { title: 'Confirm dock access at 6 AM',    priority: 'high',     owner_party: 'venue', status: 'requested', confidence: 'high', provenance: prov(msg2, 'loading dock can accept a 53\' at 6 AM', 'Mark Rivera', 'mark@novafalls.tour') },
      { title: 'Order breakfast for 22 @ 6:30 AM', priority: 'medium', owner_party: 'catering', status: 'requested', confidence: 'high', provenance: prov(msg1, 'Breakfast for 22 at 6:30 AM') },
    ],
    dependencies: [
      { from: 'rigging load',   to: 'rigger call 07:30', status: 'inferred', confidence: 'medium', provenance: prov(msg1, 'Rigger call: 7:30 AM') },
      { from: 'CO2 jets fired', to: 'permit approval',   status: 'inferred', confidence: 'high',   provenance: prov(msg1, 'Requires permit and venue approval.') },
    ],
    changes: [
      { path: 'transport.truck_count', previous: '2', next: '3', reason: 'backline vendor adding a third truck', status: 'confirmed', confidence: 'high', provenance: prov(msg2, 'adding a third truck', 'Mark Rivera', 'mark@novafalls.tour') },
      { path: 'video.led_wall',        previous: 'P3.9', next: 'P2.9', reason: 'correction from tour', status: 'confirmed', confidence: 'high', provenance: prov(msg2, 'scratch the note about the P3.9 wall', 'Mark Rivera', 'mark@novafalls.tour') },
    ],
    conflicts: [
      { path: 'schedule.loadIn', a: 'email says 8:00 AM', b: 'existing show record says 9:00', reason: 'thread vs existing show state', status: 'conflicting', confidence: 'high', provenance: prov(msg1, 'Load-in: 8:00 AM') },
    ],
    missing_information: [
      { field: 'RF frequency plan',      why: 'tour listed channel counts but no frequency plan yet', status: 'unknown', confidence: 'high', provenance: prov(msg1, '24 channels wireless mic + 12 IEM') },
      { field: 'Rigging engineer deadline', why: 'tour asked for deadline; venue has not answered', status: 'unknown', confidence: 'high', provenance: prov(msg1, 'venue rigging engineer sign-off deadline') },
    ],
    risks: [
      { description: 'Tight curfew if load-in slips',       severity: 'high',    category: 'schedule',   status: 'inferred', confidence: 'medium', provenance: prov(msg1, 'Curfew: 11:15 PM (HARD)') },
      { description: 'RF congestion at 24 wireless + 12 IEM', severity: 'medium', category: 'rf',         status: 'inferred', confidence: 'medium', provenance: prov(msg1, '24 channels wireless mic + 12 IEM') },
      { description: 'CO2 jets require permit',              severity: 'high',   category: 'operations', status: 'requested', confidence: 'high', provenance: prov(msg1, 'Requires permit and venue approval.') },
    ],
    small_details: [
      { text: 'One artist uses a wheelchair',                    category: 'accessibility', status: 'confirmed', confidence: 'high', provenance: prov(msg1, 'One artist uses a wheelchair') },
      { text: 'Photographer needs stage access at soundcheck',   category: 'credentials',   status: 'requested', confidence: 'high', provenance: prov(msg1, '1 photographer needs stage access during soundcheck only') },
      { text: 'Guest videographer credentialed as press',        category: 'credentials',   status: 'confirmed', confidence: 'high', provenance: prov(msg1, 'additional guest videographer credentialed as press') },
      { text: 'Do NOT park buses in main guest lot',             category: 'operations',    status: 'confirmed', confidence: 'high', provenance: prov(msg1, 'Please do NOT park buses in the main guest lot.') },
      { text: 'Coffee available at 6 AM for production',         category: 'hospitality',   status: 'requested', confidence: 'high', provenance: prov(msg1, 'Coffee available at 6 AM for production') },
      { text: 'Quiet room for interviews 4-5 PM',                category: 'hospitality',   status: 'requested', confidence: 'high', provenance: prov(msg1, 'Quiet room for artist interviews from 4–5 PM') },
      { text: 'Secure merchandise storage',                      category: 'operations',    status: 'requested', confidence: 'high', provenance: prov(msg1, 'Secure merchandise storage') },
      { text: 'Laundry access for artist',                       category: 'hospitality',   status: 'requested', confidence: 'high', provenance: prov(msg1, 'Laundry access for artist') },
    ],
    documents: [
      { ref: 'rigging_plot_v2.pdf', kind: 'rigging_plot', status: 'confirmed', confidence: 'high', provenance: prov(msg1, 'Full rigging plot attached (rigging_plot_v2.pdf)') },
    ],
    tech_pack_additions: [
      { stage: 'inside', section: 'power',   proposed_text: 'Tours have requested 400A 3-phase at stage — verify service and note if not currently on tech pack.', gap_reason: 'Not on file', status: 'proposed', confidence: 'medium', provenance: prov(msg1, '400A 3-phase at stage') },
      { stage: 'inside', section: 'loadIn',  proposed_text: 'Dock accepts 53\' tractor-trailers; confirm minimum arrival time.', gap_reason: 'Dock timing rule not documented', status: 'proposed', confidence: 'medium', provenance: prov(msg2, 'loading dock can accept a 53\' at 6 AM', 'Mark Rivera', 'mark@novafalls.tour') },
      { stage: 'inside', section: 'hospitality', proposed_text: 'Barrier-free artist entrance requested for wheelchair access.', gap_reason: 'Accessibility path not currently in tech pack', status: 'proposed', confidence: 'medium', provenance: prov(msg1, 'need barrier-free artist entrance') },
    ],
    field_facts: [
      { field: 'loadin_time',      value: '08:00', kind: 'confirmation', confidence: 0.95, source_message_id: msg1, source_excerpt: 'Load-in: 8:00 AM' },
      { field: 'soundcheck_time',  value: '15:30', kind: 'assertion',    confidence: 0.95, source_message_id: msg1, source_excerpt: 'Soundcheck: 3:30 PM' },
      { field: 'doors_time',       value: '18:30', kind: 'assertion',    confidence: 0.95, source_message_id: msg1, source_excerpt: 'Doors: 6:30 PM' },
      { field: 'show_time',        value: '20:45', kind: 'assertion',    confidence: 0.95, source_message_id: msg1, source_excerpt: 'Show: 8:45 PM' },
      { field: 'curfew_time',      value: '23:15', kind: 'confirmation', confidence: 0.98, source_message_id: msg2, source_excerpt: 'Curfew is still 11:15 PM hard.' },
      { field: 'truck_count',      value: 3,       kind: 'correction',   confidence: 0.95, source_message_id: msg2, source_excerpt: 'adding a third truck', previous_value: 2 },
      { field: 'bus_count',        value: 1,       kind: 'assertion',    confidence: 0.9,  source_message_id: msg1, source_excerpt: '1 tour bus arriving 5 AM' },
      { field: 'stagehand_count',  value: 12,      kind: 'request',      confidence: 0.9,  source_message_id: msg1, source_excerpt: '12 stagehands @ 8:00 AM' },
      { field: 'rigger_count',     value: 8,       kind: 'request',      confidence: 0.9,  source_message_id: msg1, source_excerpt: '4 up-riggers, 4 ground-riggers' },
      { field: 'electrician_count',value: 2,       kind: 'request',      confidence: 0.9,  source_message_id: msg1, source_excerpt: '2 electricians @ 8:00 AM' },
      { field: 'forklift_count',   value: 1,       kind: 'request',      confidence: 0.9,  source_message_id: msg1, source_excerpt: '1 forklift + operator @ 6:00 AM' },
      { field: 'dressing_room_count', value: 4,    kind: 'request',      confidence: 0.9,  source_message_id: msg1, source_excerpt: '4 dressing rooms' },
      { field: 'shower_count',     value: 8,       kind: 'request',      confidence: 0.9,  source_message_id: msg1, source_excerpt: 'Showers for 8' },
      { field: 'breakfast_count',  value: 22,      kind: 'request',      confidence: 0.9,  source_message_id: msg1, source_excerpt: 'Breakfast for 22 at 6:30 AM' },
      { field: 'lunch_count',      value: 40,      kind: 'request',      confidence: 0.9,  source_message_id: msg1, source_excerpt: 'Lunch for 40 at 12:30 PM' },
      { field: 'dinner_count',     value: 40,      kind: 'request',      confidence: 0.9,  source_message_id: msg1, source_excerpt: 'Dinner for 40 at 5:30 PM' },
      { field: 'credential_count', value: 30,      kind: 'request',      confidence: 0.9,  source_message_id: msg1, source_excerpt: '30 all-access laminates' },
      { field: 'wireless_channels',value: 24,      kind: 'request',      confidence: 0.9,  source_message_id: msg1, source_excerpt: '24 channels of wireless mics' },
      { field: 'moving_light_count', value: 32,    kind: 'request',      confidence: 0.9,  source_message_id: msg1, source_excerpt: '32 moving lights' },
      { field: 'chain_motor_count',  value: 18,    kind: 'request',      confidence: 0.9,  source_message_id: msg1, source_excerpt: '18 chain motors' },
      { field: 'power_amps',         value: 400,   kind: 'request',      confidence: 0.9,  source_message_id: msg1, source_excerpt: '400A 3-phase at stage' },
      { field: 'pyro_requested',     value: true,  kind: 'request',      confidence: 0.9,  source_message_id: msg1, source_excerpt: '4 CO2 jets during song 6' },
      { field: 'line_array_boxes',   value: 12,    kind: 'assertion',    confidence: 0.9,  source_message_id: msg2, source_excerpt: '12 per side (K1 with K2 downfills).' },
    ],
    other: [],
  };
}

test('Advance Intelligence — full pipeline processes synthetic email, covers every category, reconciles vs rules-v1, and persists', async () => {
  resetStore();
  const demo = advance.SYNTHETIC_DEMO_EMAIL;

  const provider = new StubProvider({
    program: ({ schema, toolName, userText, system }) => {
      assert.equal(toolName, 'record_advance_intelligence');
      assert.equal(schema, COMPREHENSIVE_SCHEMA);
      assert.match(system, /UNTRUSTED DATA/i);
      // Both message ids must have made it into the user text (thread was ordered).
      assert.ok(userText.includes('<untrusted_email id="demo-msg-1">'));
      assert.ok(userText.includes('<untrusted_email id="demo-msg-2">'));
      // Venue defaults + both tech-pack stages were passed in as context.
      assert.ok(userText.includes('<venue_defaults>'),        'venue_defaults block sent to LLM');
      assert.ok(userText.includes('<tech_pack stage="inside">'), 'inside tech pack sent to LLM');
      assert.ok(userText.includes('<tech_pack stage="beach">'),  'beach tech pack sent to LLM');
      assert.match(system, /tech_pack_additions/, 'system prompt describes tech_pack_additions');
      assert.match(system, /venue_defaults/,      'system prompt describes venue_defaults');
      return buildStubOutput();
    },
    model: 'stub-advance-1',
  });

  const venueDefaults = {
    stages: {
      inside: { capacity: 500, daySheet: { default: { loadIn: '15:00', soundCheck: '17:00', doors: '19:00' } } },
      beach:  { capacity: 1200, daySheet: { default: { loadIn: '14:00', soundCheck: '16:30', doors: '18:00' } } },
    },
  };
  const techPacks = [
    { stage: 'inside', sections: [
      { key: 'overview', title: 'Venue Overview', content: 'Windjammer Inside Stage. Cap 500.' },
      { key: 'power',    title: 'Power',           content: '200A single-phase at stage. No 3-phase installed.' },
      { key: 'loadIn',   title: 'Load-in',         content: 'Ground-level dock. Tractor-trailer access via alley.' },
    ] },
    { stage: 'beach', sections: [
      { key: 'overview', title: 'Venue Overview', content: 'Windjammer Beach Stage. Cap 1200. Outdoor.' },
    ] },
  ];

  const result = await advance.processThread({
    messages:         demo.messages,
    shows:            demo.shows,
    showId:           demo.showId,
    existingShowData: demo.existingShowData,
    venueContext:     demo.venueContext,
    venueDefaults,
    techPacks,
    provider,
  });

  // 1) LLM path succeeded.
  assert.equal(result.llmOk, true);
  assert.equal(result.threadId, 'demo-thread-1');

  // 2) Every rich category has entries proportional to the fixture — no
  //    category was silently dropped by the pipeline.
  const compr = result.comprehensive;
  assert.ok(compr.people.length         >= 5, 'people extracted');
  assert.ok(compr.organizations.length  >= 2, 'organizations extracted');
  assert.ok(compr.schedule.length       >= 6, 'schedule extracted');
  assert.ok(compr.production.length     >= 6, 'production extracted');
  assert.ok(compr.labor.length          >= 3, 'labor extracted');
  assert.ok(compr.hospitality.length    >= 4, 'hospitality extracted');
  assert.ok(compr.transportation.length >= 2, 'transportation extracted');
  assert.ok(compr.venue_requirements.length >= 3, 'venue requirements extracted');
  assert.ok(compr.responsibilities.length   >= 2, 'responsibilities extracted');
  assert.ok(compr.tasks.length          >= 3, 'tasks extracted');
  assert.ok(compr.dependencies.length   >= 1, 'dependencies extracted');
  assert.ok(compr.changes.length        >= 2, 'changes extracted');
  assert.ok(compr.conflicts.length      >= 1, 'conflicts extracted');
  assert.ok(compr.missing_information.length >= 1, 'missing information extracted');
  assert.ok(compr.risks.length          >= 2, 'risks extracted');
  assert.ok(compr.small_details.length  >= 5, 'small details extracted (photographer, wheelchair, etc.)');
  assert.ok(compr.documents.length      >= 1, 'documents extracted');
  assert.ok(compr.tech_pack_additions.length >= 1, 'tech pack additions extracted (facts not in current tech pack)');
  assert.ok(compr.field_facts.length    >= 15, 'field facts extracted');

  // 3) Provenance intact on every atom.
  for (const cat of CATEGORIES) {
    for (const a of (compr[cat] || [])) {
      assert.ok(a.provenance?.source_message_id, `${cat}: source_message_id present`);
      assert.ok(a.provenance?.quoted_text,       `${cat}: quoted_text present`);
      assert.ok(a.status,     `${cat}: status present`);
      assert.ok(a.confidence, `${cat}: confidence present`);
    }
  }

  // 4) Reconciliation between LLM field_facts and rules-v1 rule facts.
  const rec = result.reconciliation;
  assert.ok(Array.isArray(rec.agreements));
  assert.ok(Array.isArray(rec.conflicts));
  assert.ok(Array.isArray(rec.llmOnly));
  assert.ok(Array.isArray(rec.rulesOnly));
  // Rules-v1 detects the numeric mentions in the body too, so we expect
  // at least one shared field (e.g. truck_count) to show up as agreement
  // OR conflict (since msg2 corrects to 3).
  assert.ok(rec.agreements.length + rec.conflicts.length >= 1, 'at least one shared field reconciled');

  // 5) State diff detects the load-in mismatch (email 8:00 vs existing 9:00).
  const loadInChange = result.stateDiff.changes.find(c => c.field === 'loadin_time');
  assert.ok(loadInChange, 'load-in change detected against existing show state');
  assert.equal(loadInChange.previous, '9:00');
  assert.equal(loadInChange.next, '08:00');

  // 6) PM view is populated.
  const pm = result.pmView;
  assert.ok(pm.what_i_learned.length > 0);
  assert.ok(pm.who_is_involved.length >= 5);
  assert.ok(pm.venue_needs.length >= 3);
  assert.ok(pm.at_risk.length >= 2);
  assert.ok(pm.do_next.length >= 3);
  assert.ok(pm.needs_approval.length >= 10);

  // 7) Persistence wrote atoms into AdvanceFacts.
  const stored = store.get('AdvanceFacts') || [];
  assert.ok(stored.length >= 40, `AdvanceFacts should contain many atoms; got ${stored.length}`);
  const catsSeen = new Set(stored.map(r => r.category));
  for (const need of ['people', 'schedule', 'production', 'labor', 'hospitality', 'transportation', 'venue_requirements', 'tasks', 'small_details', 'tech_pack_additions']) {
    assert.ok(catsSeen.has(need), `AdvanceFacts should include category ${need}`);
  }
  // Every stored row has provenance + confidence + status.
  for (const row of stored) {
    assert.ok(row.quotedText, 'row has quotedText');
    assert.ok(row.sourceEmailId, 'row has sourceEmailId');
    assert.ok(row.status, 'row has status');
    assert.ok(row.confidence, 'row has confidence');
    assert.ok(row.hash, 'row has dedupe hash');
    assert.ok(row.model, 'row records the extractor model');
  }
});

test('Advance Intelligence — re-running the same thread does not duplicate stored atoms', async () => {
  resetStore();
  const demo = advance.SYNTHETIC_DEMO_EMAIL;
  const provider = new StubProvider({ program: buildStubOutput, model: 'stub-advance-1' });

  await advance.processThread({
    messages: demo.messages, shows: demo.shows, showId: demo.showId,
    existingShowData: demo.existingShowData, venueContext: demo.venueContext,
    provider,
  });
  const firstCount = (store.get('AdvanceFacts') || []).length;
  assert.ok(firstCount > 0);

  await advance.processThread({
    messages: demo.messages, shows: demo.shows, showId: demo.showId,
    existingShowData: demo.existingShowData, venueContext: demo.venueContext,
    provider,
  });
  const secondCount = (store.get('AdvanceFacts') || []).length;
  assert.equal(secondCount, firstCount, 'no duplicate atoms on re-run');
});

test('Advance Intelligence — rules-v1 keeps running even when LLM extraction fails', async () => {
  resetStore();
  const demo = advance.SYNTHETIC_DEMO_EMAIL;
  const provider = new StubProvider({
    program: () => { throw new Error('injected_llm_failure'); },
    model: 'stub-advance-1',
  });

  const result = await advance.processThread({
    messages: demo.messages, shows: demo.shows, showId: demo.showId,
    existingShowData: demo.existingShowData, venueContext: demo.venueContext,
    provider,
  });

  assert.equal(result.llmOk, false);
  assert.match(result.llmError || '', /injected_llm_failure/);
  // Rules-v1 still emitted whatever it could find in the email body.
  assert.ok(result.rulesFactsCount >= 1, 'rules-v1 continued to extract facts');
  // No AdvanceFacts persisted when LLM failed (rich atoms are LLM-only).
  assert.equal((store.get('AdvanceFacts') || []).length, 0);
});
