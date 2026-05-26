module.exports = {
  port: process.env.PORT || 3001,
  jwtSecret: process.env.JWT_SECRET || 'windjammer-dev-secret-change-in-production',

  stages: {
    inside: { id: 'inside', name: 'Inside Stage', color: '#1a4a7a' },
    beach:  { id: 'beach',  name: 'Beach Stage',  color: '#1a6b4a' },
  },

  googleSheets: {
    spreadsheetId: process.env.SPREADSHEET_ID || '',
    sheets: {
      users:          'Users',
      shows:          'Shows',
      advancing:      'Advancing',
      schedule:       'Schedule',
      labor:          'Labor',
      vendors:        'Vendors',
      vendorBookings: 'VendorBookings',
      settlement:     'Settlement',
      staff:          'Staff',
      techpack:       'TechPack',
      emails:         'Emails',
    }
  }
};
