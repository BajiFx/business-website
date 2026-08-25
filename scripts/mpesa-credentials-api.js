// ================================================================
//  M-PESA CREDENTIALS MANAGEMENT API
//  This file is meant to be used with server.js
//  The route is now in src/routes/payments.js
// ================================================================

const path = require('path');
const fs = require('fs');
const dotenv = require('dotenv');

// Load .env from root directory
dotenv.config({ path: path.join(__dirname, '..', '.env') });

/**
 * Save M-Pesa Credentials to .env
 * This is a helper function used by the routes
 */
async function saveMpesaCredentials(consumerKey, consumerSecret, passkey, shortcode, callbackUrl, environment) {
  const envPath = path.join(__dirname, '..', '.env');
  let envContent = '';
  
  if (fs.existsSync(envPath)) {
    envContent = fs.readFileSync(envPath, 'utf8');
  }

  const lines = envContent.split('\n');
  const newLines = [];
  const mpesaKeys = {
    'MPESA_CONSUMER_KEY': consumerKey,
    'MPESA_CONSUMER_SECRET': consumerSecret,
    'MPESA_PASSKEY': passkey,
    'MPESA_SHORTCODE': shortcode || '174379',
    'MPESA_CALLBACK_URL': callbackUrl || `${process.env.BASE_URL}/api/payments/mpesa-callback`,
    'MPESA_ENVIRONMENT': environment || 'sandbox'
  };

  let updated = false;
  for (const line of lines) {
    let isKey = false;
    for (const [key, value] of Object.entries(mpesaKeys)) {
      if (line.trim().startsWith(`${key}=`)) {
        newLines.push(`${key}=${value}`);
        isKey = true;
        updated = true;
        delete mpesaKeys[key];
        break;
      }
    }
    if (!isKey) {
      newLines.push(line);
    }
  }

  for (const [key, value] of Object.entries(mpesaKeys)) {
    if (value && value.trim()) {
      newLines.push(`${key}=${value}`);
      updated = true;
    }
  }

  fs.writeFileSync(envPath, newLines.join('\n'));
  return updated;
}

/**
 * Test M-Pesa Connection
 */
async function testMpesaConnection() {
  const consumerKey = process.env.MPESA_CONSUMER_KEY;
  const consumerSecret = process.env.MPESA_CONSUMER_SECRET;

  if (!consumerKey || !consumerSecret || consumerKey === 'YOUR_CONSUMER_KEY_HERE') {
    return {
      success: false,
      error: 'M-Pesa credentials are not configured'
    };
  }

  try {
    const auth = Buffer.from(`${consumerKey}:${consumerSecret}`).toString('base64');
    const response = await fetch('https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials', {
      method: 'GET',
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/json'
      }
    });

    if (response.ok) {
      const data = await response.json();
      return {
        success: true,
        message: 'Successfully connected to Safaricom API',
        environment: process.env.MPESA_ENVIRONMENT || 'sandbox'
      };
    } else {
      const text = await response.text();
      return {
        success: false,
        error: `Failed to connect: ${response.status} - ${text}`
      };
    }
  } catch (error) {
    return {
      success: false,
      error: 'Connection test failed: ' + error.message
    };
  }
}

module.exports = {
  saveMpesaCredentials,
  testMpesaConnection
};