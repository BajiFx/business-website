// ================================================================
//  mpesa-credentials-check.js - CLI Credential Check
//  Run: node scripts/mpesa-credentials-check.js
// ================================================================

const path = require('path');
const dotenv = require('dotenv');

// Load .env from root directory
dotenv.config({ path: path.join(__dirname, '..', '.env') });

console.log('\n========================================');
console.log('  M-PESA CREDENTIALS CHECK');
console.log('========================================\n');

const checks = {
  'MPESA_CONSUMER_KEY': {
    value: process.env.MPESA_CONSUMER_KEY,
    status: '❌',
    message: ''
  },
  'MPESA_CONSUMER_SECRET': {
    value: process.env.MPESA_CONSUMER_SECRET,
    status: '❌',
    message: ''
  },
  'MPESA_PASSKEY': {
    value: process.env.MPESA_PASSKEY,
    status: '❌',
    message: ''
  },
  'MPESA_SHORTCODE': {
    value: process.env.MPESA_SHORTCODE,
    status: '❌',
    message: ''
  },
  'MPESA_CALLBACK_URL': {
    value: process.env.MPESA_CALLBACK_URL,
    status: '❌',
    message: ''
  },
  'MPESA_ENVIRONMENT': {
    value: process.env.MPESA_ENVIRONMENT,
    status: '❌',
    message: ''
  },
  'SMTP_USER': {
    value: process.env.SMTP_USER,
    status: '❌',
    message: ''
  }
};

let allValid = true;

for (const [key, check] of Object.entries(checks)) {
  const value = check.value;
  
  if (!value) {
    check.status = '❌';
    check.message = 'NOT SET';
    allValid = false;
  } else if (value.includes('YOUR_') || value.includes('your_')) {
    check.status = '⚠️';
    check.message = 'PLACEHOLDER - needs real value';
    allValid = false;
  } else if (key === 'MPESA_CONSUMER_KEY' && value.length < 10) {
    check.status = '⚠️';
    check.message = 'Too short - likely invalid';
    allValid = false;
  } else if (key === 'MPESA_CONSUMER_SECRET' && value.length < 10) {
    check.status = '⚠️';
    check.message = 'Too short - likely invalid';
    allValid = false;
  } else if (key === 'MPESA_PASSKEY' && value.length < 10) {
    check.status = '⚠️';
    check.message = 'Too short - likely invalid';
    allValid = false;
  } else if (key === 'MPESA_CALLBACK_URL' && value === 'https://your-ngrok-url.ngrok.io/api/payments/mpesa-callback') {
    check.status = '⚠️';
    check.message = 'Default URL - update with your ngrok URL';
    allValid = false;
  } else if (key === 'MPESA_CALLBACK_URL' && !value.includes('http')) {
    check.status = '⚠️';
    check.message = 'Invalid URL format';
    allValid = false;
  } else {
    check.status = '✅';
    check.message = 'OK';
  }
  
  console.log(`${check.status} ${key}: ${check.message}`);
}

console.log('\n📋 Summary:');
if (allValid) {
  console.log('✅ All credentials are valid!');
  console.log(`   Environment: ${checks['MPESA_ENVIRONMENT'].value}`);
  console.log(`   Shortcode: ${checks['MPESA_SHORTCODE'].value}`);
  console.log(`   Callback URL: ${checks['MPESA_CALLBACK_URL'].value}`);
  console.log(`   Email: ${checks['SMTP_USER'].value}`);
} else {
  console.log('⚠️ Some credentials need attention:');
  for (const [key, check] of Object.entries(checks)) {
    if (check.status !== '✅') {
      console.log(`   ${check.status} ${key}: ${check.message}`);
    }
  }
  
  console.log('\n📝 To fix:');
  console.log('  1. Run: node scripts/mpesa-credentials-helper.js');
  console.log('  2. Or manually update .env with your real credentials');
}

console.log('\n🔗 Resources:');
console.log('  - Developer Portal: https://developer.safaricom.co.ke');
console.log('  - Get Credentials: https://developer.safaricom.co.ke/MyApps');
console.log('  - ngrok: https://ngrok.com\n');