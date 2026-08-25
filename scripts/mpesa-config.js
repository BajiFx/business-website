// ================================================================
//  mpesa-config.js - M-Pesa Credentials Management
// ================================================================

const path = require('path');
const dotenv = require('dotenv');

// Load .env from root directory
dotenv.config({ path: path.join(__dirname, '..', '.env') });

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';

const MPESA_CONFIG = {
  environment: process.env.MPESA_ENVIRONMENT || 'sandbox',
  
  consumerKey: process.env.MPESA_CONSUMER_KEY,
  consumerSecret: process.env.MPESA_CONSUMER_SECRET,
  passkey: process.env.MPESA_PASSKEY,
  shortcode: process.env.MPESA_SHORTCODE || '174379',
  email: process.env.SMTP_USER || 'georgebabji1220@gmail.com',
  
  get callbackUrl() {
    return process.env.MPESA_CALLBACK_URL || `${BASE_URL}/api/payments/mpesa-callback`;
  },
  
  get apiUrls() {
    const baseUrl = this.environment === 'production' 
      ? 'https://api.safaricom.co.ke'
      : 'https://sandbox.safaricom.co.ke';
    
    return {
      auth: `${baseUrl}/oauth/v1/generate?grant_type=client_credentials`,
      stkPush: `${baseUrl}/mpesa/stkpush/v1/processrequest`,
      stkQuery: `${baseUrl}/mpesa/stkpushquery/v1/query`,
    };
  },
  
  validate() {
    const errors = [];
    const warnings = [];
    
    if (!this.consumerKey || this.consumerKey === 'YOUR_CONSUMER_KEY_HERE') {
      errors.push('❌ MPESA_CONSUMER_KEY is not set');
    }
    
    if (!this.consumerSecret || this.consumerSecret === 'YOUR_CONSUMER_SECRET_HERE') {
      errors.push('❌ MPESA_CONSUMER_SECRET is not set');
    }
    
    if (!this.passkey || this.passkey === 'YOUR_PASSKEY_HERE') {
      errors.push('❌ MPESA_PASSKEY is not set');
    }
    
    if (!this.callbackUrl || this.callbackUrl.includes('your-ngrok-url')) {
      warnings.push('⚠️ Callback URL needs to be updated');
    }
    
    return {
      valid: errors.length === 0,
      errors: errors,
      warnings: warnings
    };
  },
  
  getMasked() {
    return {
      environment: this.environment,
      consumerKey: this.consumerKey ? this.consumerKey.substring(0, 8) + '...' : 'NOT SET',
      consumerSecret: this.consumerSecret ? '****' : 'NOT SET',
      passkey: this.passkey ? '****' : 'NOT SET',
      shortcode: this.shortcode,
      callbackUrl: this.callbackUrl || 'NOT SET',
      email: this.email
    };
  }
};

const validationResult = MPESA_CONFIG.validate();
if (!validationResult.valid) {
  console.log('\n⚠️ M-Pesa Configuration Issues Found:');
  validationResult.errors.forEach(err => console.log(`  ${err}`));
  console.log('\n📝 To fix:');
  console.log('  1. Run: npm run mpesa:setup');
  console.log('  2. Or manually update .env with your credentials\n');
} else {
  console.log('✅ M-Pesa credentials validated successfully!');
  console.log(`   Environment: ${MPESA_CONFIG.environment}`);
  console.log(`   Shortcode: ${MPESA_CONFIG.shortcode}`);
  console.log(`   Callback URL: ${MPESA_CONFIG.callbackUrl}`);
  console.log(`   Email: ${MPESA_CONFIG.email}\n`);
}

module.exports = MPESA_CONFIG;