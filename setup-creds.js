// Writes Google credentials from env var to a file at startup
const fs = require('fs');
if (process.env.GOOGLE_CREDENTIALS_JSON) {
  fs.writeFileSync('./google-credentials.json', process.env.GOOGLE_CREDENTIALS_JSON);
  console.log('✅ Google credentials written from env');
}