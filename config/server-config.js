module.exports = {
  port: process.env.PORT || 3001,
  jwtSecret: process.env.JWT_SECRET || 'windjammer-dev-secret-change-in-production',

  llm: {
    provider:     process.env.LLM_PROVIDER   || 'anthropic',
    model:        process.env.LLM_MODEL      || 'claude-sonnet-4-20250514',
    // Read from the ONE canonical env var. Never expose this outside server code.
    anthropicKey: process.env.ANTHROPIC_API_KEY || '',
    // Node/Railway env vars are case-sensitive on Linux. If the user set a
    // legacy lower/mixed-case variant, note it so the startup check can warn
    // clearly (without ever printing the value).
    miscasedKey:  detectMiscasedAnthropicKey(process.env),
  },

  stages: {
    inside: { id: 'inside', name: 'Inside Stage', color: '#1a4a7a', capacity: 500  },
    beach:  { id: 'beach',  name: 'Beach Stage',  color: '#1a6b4a', capacity: 1200 },
  },

  googleSheets: {
    spreadsheetId: process.env.SPREADSHEET_ID || '',
    sheets: {
      users:          'Users',
      shows:          'Shows',
      events:         'Events',
      advancing:      'Advancing',
      schedule:       'Schedule',
      labor:          'Labor',
      vendors:        'Vendors',
      vendorBookings: 'VendorBookings',
      settlement:     'Settlement',
      staff:          'Staff',
      techpack:       'TechPack',
      emails:           'Emails',
      unavailability:   'Unavailability',
      artists:          'Artists',
      artistDocuments:  'ArtistDocuments',
      gmailLabelMappings: 'GmailLabelMappings',
      gmailSyncedLabels:  'GmailSyncedLabels',
      appSettings:        'AppSettings',
      patchLists:         'PatchLists',
      showRequests:       'ShowRequests',
      emailTemplates:     'EmailTemplates',
      maintenance:        'Maintenance',
      budgets:            'Budgets',
      venueKnowledge:        'VenueKnowledge',
      venueKnowledgeHistory: 'VenueKnowledgeHistory',
      emailFacts:            'EmailFacts',
      emailThreads:          'EmailThreads',
      emailIssues:           'EmailIssues',
      aiChangeLog:           'AiChangeLog',
      userOntologyRules:     'UserOntologyRules',
      aiCorrections:         'AiCorrections',
      knowledgeCandidates:   'KnowledgeCandidates',
      showContacts:          'ShowContacts',
      showAsks:              'ShowAsks',
    }
  }
};

// Look for the correct env var under a wrong casing (Linux is case-sensitive).
// Returns the offending name (e.g. 'anthropic_API_KEY') or null. Never
// returns the value.
function detectMiscasedAnthropicKey(env) {
  if (env.ANTHROPIC_API_KEY) return null;
  for (const k of Object.keys(env)) {
    if (k !== 'ANTHROPIC_API_KEY' && k.toUpperCase() === 'ANTHROPIC_API_KEY' && env[k]) return k;
  }
  return null;
}
