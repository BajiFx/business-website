// ================================================================
//  mpesa-credentials-helper.js - Interactive Credential Setup
//  Run: node mpesa-credentials-helper.js
// ================================================================

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const dotenv = require('dotenv');

dotenv.config();

const BASE_URL = process.env.BASE_URL || 'https://donator-eldercare-cacti.ngrok-free.dev';
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

function question(query) {
  return new Promise(resolve => {
    rl.question(query, resolve);
  });
}

async function setupCredentials() {
  console.log('\n========================================');
  console.log('  M-PESA CREDENTIALS SETUP HELPER');
  console.log('========================================\n');
  
  console.log('📝 Before you start:');
  console.log('  1. Go to https://developer.safaricom.co.ke');
  console.log('  2. Create an account if you don\'t have one');
  console.log('  3. Go to "My Apps" and create a new app');
  console.log('  4. Copy your Consumer Key and Consumer Secret');
  console.log('  5. Go to "Sandbox" → "Credentials"');
  console.log('  6. Copy your Passkey');
  console.log(`\n🔗 Your callback URL will be: ${BASE_URL}/api/payments/mpesa-callback\n`);
  
  const envPath = path.join(process.cwd(), '.env');
  let envContent = '';
  
  if (fs.existsSync(envPath)) {
    envContent = fs.readFileSync(envPath, 'utf8');
    console.log('✅ Found existing .env file\n');
  }
  
  console.log('Please enter your M-Pesa credentials:\n');
  
  const consumerKey = await question('1. Consumer Key: ');
  const consumerSecret = await question('2. Consumer Secret: ');
  const passkey = await question('3. Passkey: ');
  const shortcode = await question('4. Shortcode (default: 174379): ') || '174379';
  const environment = await question('5. Environment (sandbox/production): ') || 'sandbox';
  
  console.log('\n📝 Updating .env file...');
  
  const lines = envContent.split('\n');
  const newLines = [];
  
  const mpesaKeys = {
    'MPESA_CONSUMER_KEY': consumerKey,
    'MPESA_CONSUMER_SECRET': consumerSecret,
    'MPESA_PASSKEY': passkey,
    'MPESA_SHORTCODE': shortcode,
    'MPESA_CALLBACK_URL': `${BASE_URL}/api/payments/mpesa-callback`,
    'MPESA_ENVIRONMENT': environment
  };
  
  const emailKeys = {
    'SMTP_USER': 'georgebabji1220@gmail.com',
    'SMTP_PASS': 'ybkyeccgxkjwprqu',
    'SMTP_FROM': '"Doreen Bedsheet & Towels <georgebabji1220@gmail.com>"'
  };
  
  let foundKeys = {};
  
  for (const line of lines) {
    let isKey = false;
    for (const [key, value] of Object.entries(mpesaKeys)) {
      if (line.trim().startsWith(`${key}=`)) {
        newLines.push(`${key}=${value}`);
        isKey = true;
        foundKeys[key] = true;
        break;
      }
    }
    if (!isKey) {
      for (const [key, value] of Object.entries(emailKeys)) {
        if (line.trim().startsWith(`${key}=`)) {
          newLines.push(`${key}=${value}`);
          isKey = true;
          foundKeys[key] = true;
          break;
        }
      }
    }
    if (!isKey) {
      newLines.push(line);
    }
  }
  
  for (const [key, value] of Object.entries(mpesaKeys)) {
    if (value && value.trim() && !foundKeys[key]) {
      newLines.push(`${key}=${value}`);
    }
  }
  for (const [key, value] of Object.entries(emailKeys)) {
    if (value && value.trim() && !foundKeys[key]) {
      newLines.push(`${key}=${value}`);
    }
  }
  
  fs.writeFileSync(envPath, newLines.join('\n'));
  
  console.log('✅ .env file updated!\n');
  console.log('📋 Your configuration:');
  console.log(`   Environment: ${environment}`);
  console.log(`   Shortcode: ${shortcode}`);
  console.log(`   Callback URL: ${BASE_URL}/api/payments/mpesa-callback`);
  console.log(`   Email: georgebabji1220@gmail.com\n`);
  
  console.log('🧪 Testing connection to Safaricom...\n');
  try {
    const auth = Buffer.from(`${consumerKey}:${consumerSecret}`).toString('base64');
    const url = 'https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials';
    
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/json'
      }
    });
    
    if (response.ok) {
      const data = await response.json();
      console.log('✅ Successfully connected to Safaricom API!');
      console.log(`   Access token: ${data.access_token.substring(0, 20)}...\n`);
    } else {
      console.log('❌ Failed to connect to Safaricom API:');
      console.log(`   Status: ${response.status}`);
      const text = await response.text();
      console.log(`   Response: ${text}\n`);
    }
  } catch (error) {
    console.log('❌ Connection error:');
    console.log(`   ${error.message}\n`);
  }
  
  console.log('📝 Next steps:');
  console.log('  1. Make sure ngrok is running: ngrok http 3000');
  console.log(`  2. Start your server: npm start`);
  console.log('  3. Test M-Pesa from your frontend\n');
  
  rl.close();
}

console.log('\n📊 Current M-Pesa Status:\n');

const consumerKey = process.env.MPESA_CONSUMER_KEY;
const consumerSecret = process.env.MPESA_CONSUMER_SECRET;
const passkey = process.env.MPESA_PASSKEY;
const shortcode = process.env.MPESA_SHORTCODE || '174379';
const callbackUrl = process.env.MPESA_CALLBACK_URL;

console.log('   Consumer Key:', consumerKey ? consumerKey.substring(0, 8) + '...' : 'NOT SET');
console.log('   Consumer Secret:', consumerSecret ? '****' : 'NOT SET');
console.log('   Passkey:', passkey ? '****' : 'NOT SET');
console.log('   Shortcode:', shortcode);
console.log('   Callback URL:', callbackUrl || 'NOT SET');
console.log('   Email:', process.env.SMTP_USER || 'georgebabji1220@gmail.com');
console.log('');

const hasAllCredentials = consumerKey && consumerSecret && passkey && 
                         consumerKey !== 'YOUR_CONSUMER_KEY_HERE' &&
                         consumerSecret !== 'YOUR_CONSUMER_SECRET_HERE' &&
                         passkey !== 'YOUR_PASSKEY_HERE';

if (hasAllCredentials) {
  console.log('✅ All credentials appear to be set!\n');
  const answer = await question('Update credentials? (y/n): ');
  if (answer.toLowerCase() === 'y') {
    await setupCredentials();
  } else {
    console.log('\n🔧 To test M-Pesa:');
    console.log('  1. Make sure ngrok is running: ngrok http 3000');
    console.log('  2. Start server: npm start');
    console.log('  3. Test from frontend\n');
    rl.close();
  }
} else {
  console.log('⚠️ Some credentials are missing or invalid.\n');
  await setupCredentials();
}