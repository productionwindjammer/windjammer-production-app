'use strict';

/**
 * Extraction schema derived from the REAL field vocabulary.
 * The LLM can only emit facts whose `field` is in this enum; no field names
 * are invented client-side. The set is derived at load time from
 * emailIntelligence.FIELD_VOCAB so the schema stays in lockstep with the
 * downstream mapper (factMapping.FIELD_MAP).
 */

const emailIntel = require('../emailIntelligence');

const FIELD_ENUM = Object.keys(emailIntel.FIELD_VOCAB);

const FACT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['field', 'value', 'kind', 'confidence', 'source_message_id', 'source_excerpt'],
  properties: {
    field: { type: 'string', enum: FIELD_ENUM, description: 'Canonical field name. Must be one of the listed values.' },
    value: {
      description: 'Extracted value. count → integer; time → "HH:MM" 24h; bool → true/false; string → string.',
      oneOf: [
        { type: 'string' },
        { type: 'integer', minimum: 0 },
        { type: 'boolean' },
      ],
    },
    unit: { type: 'string', enum: ['count', 'time', 'bool', 'string'] },
    kind: {
      type: 'string',
      enum: ['assertion', 'request', 'confirmation', 'correction', 'change'],
      description: 'assertion=stated as fact; request=asking for it; confirmation=explicitly confirmed; correction=explicit override of an earlier value in the thread; change=restated value that supersedes an earlier one.',
    },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    previous_value: { description: 'For kind=correction/change, the value being superseded (from earlier in the thread).', oneOf: [{ type: 'string' }, { type: 'integer' }, { type: 'boolean' }, { type: 'null' }] },
    source_message_id: { type: 'string', description: 'The id of the specific message this fact was extracted from. Must match one of the message ids provided in the input.' },
    source_excerpt:    { type: 'string', maxLength: 400, description: 'Verbatim quote from the email (single sentence) containing the fact.' },
    reasoning:         { type: 'string', maxLength: 240, description: 'One concise sentence explaining WHY this fact was extracted. No chain-of-thought.' },
  },
};

const ISSUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'excerpt', 'source_message_id'],
  properties: {
    kind:    { type: 'string', enum: ['question', 'deadline', 'conflict_signal', 'dependency', 'risk'] },
    excerpt: { type: 'string', maxLength: 400 },
    source_message_id: { type: 'string' },
    phrase:  { type: 'string', maxLength: 120 },
  },
};

const EXTRACTION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['facts', 'issues', 'missing_information', 'recommended_actions'],
  properties: {
    facts:              { type: 'array', items: FACT_SCHEMA, maxItems: 60 },
    issues:             { type: 'array', items: ISSUE_SCHEMA, maxItems: 30 },
    missing_information:{ type: 'array', items: { type: 'string', maxLength: 200 }, maxItems: 20 },
    recommended_actions:{ type: 'array', items: { type: 'string', maxLength: 200 }, maxItems: 10 },
  },
};

module.exports = { EXTRACTION_SCHEMA, FACT_SCHEMA, ISSUE_SCHEMA, FIELD_ENUM };
