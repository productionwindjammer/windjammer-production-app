'use strict';

/**
 * Comprehensive Advance Intelligence schema.
 *
 * The LLM is asked to extract EVERY operationally meaningful piece of
 * information from a thread and map it into typed structured entities.
 * Every atom carries provenance (source_message_id + quoted_text) and a
 * classification (status + confidence).
 *
 * The schema is intentionally extensible: category buckets exist even if
 * empty; the model is instructed to leave them empty rather than fabricate.
 */

const emailIntel = require('../emailIntelligence');

// The compact field enum still exists so the LLM CAN populate downstream
// form fields where it recognises them, but it is NOT the primary output.
const FIELD_ENUM = Object.keys(emailIntel.FIELD_VOCAB);

const CONFIDENCE_ENUM = ['high', 'medium', 'low'];
const STATUS_ENUM = [
  'confirmed', 'proposed', 'requested', 'unconfirmed',
  'inferred',  'conflicting', 'superseded', 'cancelled', 'unknown',
];
const PARTY_ENUM = ['venue', 'tour', 'promoter', 'vendor', 'artist', 'security', 'catering', 'transportation', 'other'];

// Every atom carries the same provenance block.
const PROVENANCE = {
  type: 'object',
  additionalProperties: false,
  required: ['source_message_id', 'quoted_text'],
  properties: {
    source_message_id: { type: 'string', description: 'MUST match one of the input message ids.' },
    quoted_text:       { type: 'string', maxLength: 400, description: 'Verbatim sentence from that message that supports the atom.' },
    sender:            { type: 'string', maxLength: 200 },
    sender_email:      { type: 'string', maxLength: 200 },
    sender_org:        { type: 'string', maxLength: 200 },
  },
};

const CONFIDENCE  = { type: 'string', enum: CONFIDENCE_ENUM };
const STATUS      = { type: 'string', enum: STATUS_ENUM };

function atom(extraProps = {}, extraRequired = []) {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['status', 'confidence', 'provenance', ...extraRequired],
    properties: {
      status:     STATUS,
      confidence: CONFIDENCE,
      provenance: PROVENANCE,
      notes:      { type: 'string', maxLength: 400 },
      ...extraProps,
    },
  };
}

const PERSON = atom({
  full_name:       { type: 'string', maxLength: 200 },
  preferred_name:  { type: 'string', maxLength: 100 },
  emails:          { type: 'array', items: { type: 'string', maxLength: 200 }, maxItems: 6 },
  phones:          { type: 'array', items: { type: 'string', maxLength: 60 },  maxItems: 6 },
  organization:    { type: 'string', maxLength: 200 },
  role:            { type: 'string', maxLength: 120 },
  role_category:   {
    type: 'string',
    enum: [
      'artist', 'artist_manager', 'tour_manager', 'production_manager', 'assistant_production_manager',
      'stage_manager', 'production_coordinator', 'tour_accountant',
      'foh_engineer', 'monitor_engineer', 'lighting_director', 'lighting_designer', 'lighting_programmer',
      'video_director', 'video_engineer',
      'backline_tech', 'guitar_tech', 'drum_tech', 'rf_tech',
      'rigger', 'head_rigger', 'carpenter', 'stagehand',
      'bus_driver', 'truck_driver',
      'security', 'catering', 'hospitality',
      'promoter', 'promoter_rep', 'booking_agent', 'talent_buyer',
      'venue_manager', 'general_manager', 'venue_production_manager', 'technical_director',
      'audio_dept', 'lighting_dept', 'video_dept', 'operations',
      'security_manager', 'box_office', 'ticketing', 'marketing', 'guest_services',
      'parking', 'transportation', 'vendor', 'other', 'unknown',
    ],
  },
  is_decision_maker: { type: 'boolean' },
  is_action_owner:   { type: 'boolean' },
  info_only:         { type: 'boolean' },
}, ['full_name']);

const ORGANIZATION = atom({
  name: { type: 'string', maxLength: 200 },
  type: {
    type: 'string',
    enum: [
      'artist_org', 'management', 'agency', 'promoter', 'production_co',
      'equipment_vendor', 'labor_vendor', 'catering_co', 'transportation_co',
      'security_co', 'rental_co', 'trucking_co', 'hotel', 'venue_department',
      'other', 'unknown',
    ],
  },
  domain: { type: 'string', maxLength: 200 },
}, ['name']);

const SCHEDULE_ITEM = atom({
  kind: {
    type: 'string',
    enum: [
      'arrival', 'truck_arrival', 'truck_check_in', 'dock_access',
      'load_in', 'load_in_start', 'load_in_complete',
      'labor_call', 'rigger_call', 'audio_call', 'lighting_call', 'video_call', 'production_call',
      'rehearsal', 'soundcheck', 'line_check', 'artist_arrival',
      'doors', 'opener', 'support', 'changeover', 'show', 'encore', 'curfew',
      'load_out', 'bus_departure', 'truck_departure',
      'catering', 'meal', 'break',
      'settlement', 'credential_pickup', 'production_meeting', 'safety_meeting',
      'other', 'unknown',
    ],
  },
  time_iso:       { type: 'string', maxLength: 40, description: 'Absolute ISO-8601 if determinable, else omit.' },
  time_text:      { type: 'string', maxLength: 120, description: 'Original text as written (e.g. "two hours before doors", "tomorrow at 8").' },
  time_local_hhmm:{ type: 'string', maxLength: 10, description: 'Local wall-clock 24h HH:MM if a specific clock time was given.' },
  relative_to:    { type: 'string', maxLength: 60, description: 'e.g. "doors", "soundcheck" — filled when the time is relative.' },
  duration_minutes:{ type: 'integer', minimum: 0, maximum: 24 * 60 },
}, ['kind']);

// Generic production requirement atom. category is one of the departments,
// path is a human-readable dot path (e.g. "audio.consoles"), value is a
// short free-text or numeric spec. The LLM is told NOT to invent structure.
const PRODUCTION_ITEM = atom({
  category: {
    type: 'string',
    enum: ['audio', 'lighting', 'video', 'stage', 'rigging', 'power', 'backline', 'rf', 'fx', 'other'],
  },
  path:  { type: 'string', maxLength: 120 },
  value: { type: 'string', maxLength: 400 },
  count: { type: 'integer', minimum: 0 },
  unit:  { type: 'string', maxLength: 40 },
  needs_venue_approval:  { type: 'boolean' },
  needs_permit:          { type: 'boolean' },
  needs_specialist:      { type: 'boolean' },
  needs_additional_labor:{ type: 'boolean' },
}, ['category', 'path']);

const LABOR_ITEM = atom({
  department:   { type: 'string', maxLength: 80 },
  headcount:    { type: 'integer', minimum: 0 },
  call_time:    { type: 'string', maxLength: 20 },
  duration_minutes: { type: 'integer', minimum: 0 },
  responsibilities:{ type: 'string', maxLength: 400 },
  vendor:       { type: 'string', maxLength: 200 },
}, ['department']);

const HOSPITALITY_ITEM = atom({
  category: {
    type: 'string',
    enum: [
      'dressing_room', 'production_office', 'shower', 'towel', 'laundry',
      'catering', 'meal', 'beverage', 'snack',
      'runner', 'transportation', 'hotel', 'parking', 'other',
    ],
  },
  description: { type: 'string', maxLength: 400 },
  count:       { type: 'integer', minimum: 0 },
  dietary:     { type: 'string', maxLength: 200 },
  time_hhmm:   { type: 'string', maxLength: 10 },
}, ['category']);

const TRANSPORT_ITEM = atom({
  kind: {
    type: 'string',
    enum: ['tour_bus', 'artist_bus', 'truck', 'trailer', 'sprinter', 'van', 'car', 'air', 'other'],
  },
  count:            { type: 'integer', minimum: 0 },
  arrival_time:     { type: 'string', maxLength: 60 },
  departure_time:   { type: 'string', maxLength: 60 },
  parking_required: { type: 'boolean' },
  overnight_parking:{ type: 'boolean' },
  driver_name:      { type: 'string', maxLength: 120 },
  driver_phone:     { type: 'string', maxLength: 60 },
}, ['kind']);

const VENUE_REQUIREMENT = atom({
  requirement: { type: 'string', maxLength: 400 },
  category:    {
    type: 'string',
    enum: ['audio', 'lighting', 'video', 'stage', 'rigging', 'power', 'rf', 'labor',
           'hospitality', 'transportation', 'security', 'operations', 'access', 'other'],
  },
  deadline:    { type: 'string', maxLength: 60 },
  action_owner:{ type: 'string', enum: PARTY_ENUM },
}, ['requirement']);

const RESPONSIBILITY = atom({
  action:       { type: 'string', maxLength: 400 },
  party:        { type: 'string', enum: PARTY_ENUM },
  person:       { type: 'string', maxLength: 200 },
  deadline:     { type: 'string', maxLength: 60 },
}, ['action', 'party']);

const TASK = atom({
  title:    { type: 'string', maxLength: 240 },
  detail:   { type: 'string', maxLength: 600 },
  owner_party: { type: 'string', enum: PARTY_ENUM },
  owner_person:{ type: 'string', maxLength: 200 },
  deadline: { type: 'string', maxLength: 60 },
  priority: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
}, ['title']);

const DEPENDENCY = atom({
  from: { type: 'string', maxLength: 240 },
  to:   { type: 'string', maxLength: 240 },
  note: { type: 'string', maxLength: 240 },
}, ['from', 'to']);

const CHANGE = atom({
  path:     { type: 'string', maxLength: 120 },
  previous: { type: 'string', maxLength: 400 },
  next:     { type: 'string', maxLength: 400 },
  reason:   { type: 'string', maxLength: 400 },
}, ['path', 'next']);

const CONFLICT = atom({
  path:  { type: 'string', maxLength: 120 },
  a:     { type: 'string', maxLength: 400 },
  b:     { type: 'string', maxLength: 400 },
  reason:{ type: 'string', maxLength: 400 },
}, ['path', 'a', 'b']);

const MISSING = atom({
  category: { type: 'string', maxLength: 60 },
  field:    { type: 'string', maxLength: 120 },
  why:      { type: 'string', maxLength: 400 },
}, ['field']);

const RISK = atom({
  description: { type: 'string', maxLength: 400 },
  severity:    { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
  category:    { type: 'string', maxLength: 60 },
}, ['description']);

const SMALL_DETAIL = atom({
  text:     { type: 'string', maxLength: 400 },
  category: { type: 'string', maxLength: 60 },
}, ['text']);

const DOCUMENT = atom({
  ref:  { type: 'string', maxLength: 400 },
  kind: {
    type: 'string',
    enum: [
      'technical_rider', 'hospitality_rider', 'stage_plot', 'input_list',
      'production_schedule', 'lighting_plot', 'rigging_plot',
      'advancing_document', 'settlement_document', 'transportation_info', 'catering_info',
      'other', 'unknown',
    ],
  },
}, ['ref']);

// Legacy field-enum fact so downstream approve UI keeps working.
const FIELD_FACT = {
  type: 'object',
  additionalProperties: false,
  required: ['field', 'value', 'kind', 'confidence', 'source_message_id', 'source_excerpt'],
  properties: {
    field: { type: 'string', enum: FIELD_ENUM },
    value: { oneOf: [{ type: 'string' }, { type: 'integer', minimum: 0 }, { type: 'boolean' }] },
    kind:  { type: 'string', enum: ['assertion', 'request', 'confirmation', 'correction', 'change'] },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    previous_value: { oneOf: [{ type: 'string' }, { type: 'integer' }, { type: 'boolean' }, { type: 'null' }] },
    source_message_id: { type: 'string' },
    source_excerpt:    { type: 'string', maxLength: 400 },
    reasoning:         { type: 'string', maxLength: 240 },
  },
};

const COMPREHENSIVE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'people', 'organizations', 'schedule', 'production', 'labor',
    'hospitality', 'transportation', 'venue_requirements', 'responsibilities',
    'tasks', 'dependencies', 'changes', 'conflicts', 'missing_information',
    'risks', 'small_details', 'documents', 'field_facts',
  ],
  properties: {
    people:              { type: 'array', items: PERSON,             maxItems: 40 },
    organizations:       { type: 'array', items: ORGANIZATION,       maxItems: 20 },
    schedule:            { type: 'array', items: SCHEDULE_ITEM,      maxItems: 60 },
    production:          { type: 'array', items: PRODUCTION_ITEM,    maxItems: 80 },
    labor:               { type: 'array', items: LABOR_ITEM,         maxItems: 30 },
    hospitality:         { type: 'array', items: HOSPITALITY_ITEM,   maxItems: 40 },
    transportation:      { type: 'array', items: TRANSPORT_ITEM,     maxItems: 30 },
    venue_requirements:  { type: 'array', items: VENUE_REQUIREMENT,  maxItems: 40 },
    responsibilities:    { type: 'array', items: RESPONSIBILITY,     maxItems: 40 },
    tasks:               { type: 'array', items: TASK,               maxItems: 40 },
    dependencies:        { type: 'array', items: DEPENDENCY,         maxItems: 40 },
    changes:             { type: 'array', items: CHANGE,             maxItems: 40 },
    conflicts:           { type: 'array', items: CONFLICT,           maxItems: 30 },
    missing_information: { type: 'array', items: MISSING,            maxItems: 30 },
    risks:               { type: 'array', items: RISK,               maxItems: 20 },
    small_details:       { type: 'array', items: SMALL_DETAIL,       maxItems: 40 },
    documents:           { type: 'array', items: DOCUMENT,           maxItems: 20 },
    field_facts:         { type: 'array', items: FIELD_FACT,         maxItems: 60 },
    other:               { type: 'array', items: atom({ text: { type: 'string', maxLength: 400 } }, ['text']), maxItems: 30 },
  },
};

const CATEGORIES = [
  'people', 'organizations', 'schedule', 'production', 'labor', 'hospitality',
  'transportation', 'venue_requirements', 'responsibilities', 'tasks',
  'dependencies', 'changes', 'conflicts', 'missing_information', 'risks',
  'small_details', 'documents', 'other',
];

module.exports = { COMPREHENSIVE_SCHEMA, CATEGORIES, CONFIDENCE_ENUM, STATUS_ENUM, PARTY_ENUM };
