/**
 * Generate a bcrypt hash for a password to paste into the Users sheet.
 *
 * Usage:
 *   node scripts/hash-password.js yourpassword
 */

const bcrypt = require('bcryptjs');

const password = process.argv[2];
if (!password) {
  console.error('Usage: node scripts/hash-password.js <password>');
  process.exit(1);
}

bcrypt.hash(password, 12).then(hash => {
  console.log('\nPassword hash (copy this into the Users sheet "password" column):\n');
  console.log(hash);
  console.log();
});
