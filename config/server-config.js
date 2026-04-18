// Server configuration for Windjammer Production App
module.exports = {
    port: process.env.PORT || 3001,
    jwtSecret: process.env.JWT_SECRET || 'windjammer-dev-secret-change-in-production',
    sessionSecret: process.env.SESSION_SECRET || 'windjammer-session-secret',

    // The two stages treated as separate entities
    stages: {
        inside: {
            id: 'inside',
            name: 'Inside Stage',
            color: '#1a4a7a'
        },
        beach: {
            id: 'beach',
            name: 'Beach Stage',
            color: '#1a6b4a'
        }
    },

    // Google Sheets
    googleSheets: {
        spreadsheetId: process.env.SPREADSHEET_ID || '',
        sheets: {
            productions: 'Productions',
            crew:        'Crew',
            tasks:       'Tasks',
            equipment:   'Equipment',
            users:       'Users'
        }
    }
};
