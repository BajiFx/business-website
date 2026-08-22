// ================================================================
//  airtel-credentials-helper.js - Interactive Airtel Setup
//  Run: node airtel-credentials-helper.js
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

async function setupAirtelCredentials() {
  console.log('\n========================================');
  console.log('  AIRTEL MONEY CREDENTIALS SETUP');
  console.log('========================================\n');
  
  console.log('📝 Before you start:');
  console.log('  1. Go to https://developers.airtel.africa/');
  console.log('  2. Create an account if you don\'t have one');
  console.log('  3. Go to "My Apps" and create a new app');
  console.log('  4. Copy your Client ID and Client Secret');
  console.log(`\n🔗 Your callback URL: ${BASE_URL}/api/payments/airtel-callback\n`);
  
  const envPath = path.join(process.cwd(), '.env');
  let envContent = '';
  
  if (fs.existsSync(envPath)) {
    envContent = fs.readFileSync(envPath, 'utf8');
    console.log('✅ Found existing .env file\n');
  }
  
  console.log('Please enter your Airtel credentials:\n');
  
  const clientId = await question('1. Client ID: ');
  const clientSecret = await question('2. Client Secret: ');
  const environment = await question('3. Environment (sandbox/production): ') || 'sandbox';
  
  console.log('\n📝 Updating .env file...');
  
  const lines = envContent.split('\n');
  const newLines = [];
  
  const airtelKeys = {
    'AIRTEL_CLIENT_ID': clientId,
    'AIRTEL_CLIENT_SECRET': clientSecret,
    'AIRTEL_ENVIRONMENT': environment,
    'AIRTEL_CALLBACK_URL': `${BASE_URL}/api/payments/airtel-callback`
  };
  
  let foundKeys = {};
  
  for (const line of lines) {
    let isKey = false;
    for (const [key, value] of Object.entries(airtelKeys)) {
      if (line.trim().startsWith(`${key}=`)) {
        newLines.push(`${key}=${value}`);
        isKey = true;
        foundKeys[key] = true;
        break;
      }
    }
    if (!isKey) {
      newLines.push(line);
    }
  }
  
  for (const [key, value] of Object.entries(airtelKeys)) {
    if (value && value.trim() && !foundKeys[key]) {
      newLines.push(`${key}=${value}`);
    }
  }
  
  fs.writeFileSync(envPath, newLines.join('\n'));
  
  console.log('✅ .env file updated!\n');
  console.log('📋 Your Airtel configuration:');
  console.log(`   Client ID: ${clientId ? clientId.substring(0, 8) + '...' : 'NOT SET'}`);
  console.log(`   Environment: ${environment}`);
  console.log(`   Callback URL: ${BASE_URL}/api/payments/airtel-callback\n`);
  
  console.log('📝 Next steps:');
  console.log('  1. Start your server: npm start');
  console.log('  2. Test Airtel Money from your frontend\n');
  
  rl.close();
}

console.log('\n📊 Current Airtel Status:\n');

const clientId = process.env.AIRTEL_CLIENT_ID;
const clientSecret = process.env.AIRTEL_CLIENT_SECRET;
const environment = process.env.AIRTEL_ENVIRONMENT || 'sandbox';
const callbackUrl = process.env.AIRTEL_CALLBACK_URL;

console.log('   Client ID:', clientId ? clientId.substring(0, 8) + '...' : 'NOT SET');
console.log('   Client Secret:', clientSecret ? '****' : 'NOT SET');
console.log('   Environment:', environment);
console.log('   Callback URL:', callbackUrl || 'NOT SET');
console.log('');

if (clientId && clientSecret && clientId !== 'your_airtel_client_id_here') {
  console.log('✅ Airtel credentials appear to be set!\n');
  const answer = await question('Update credentials? (y/n): ');
  if (answer.toLowerCase() === 'y') {
    await setupAirtelCredentials();
  } else {
    console.log('\n🔧 To test Airtel Money:');
    console.log('  1. Make sure ngrok is running: ngrok http 3000');
    console.log('  2. Start server: npm start');
    console.log('  3. Test from frontend\n');
    rl.close();
  }
} else {
  console.log('⚠️ Some Airtel credentials are missing or invalid.\n');
  await setupAirtelCredentials();
}