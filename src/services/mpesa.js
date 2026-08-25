// ================================================================
//  mpesa.js - M-Pesa Integration with Simulation Mode
//  Location: D:\my-business-website\src\services\mpesa.js
// ================================================================

const { pool, logError } = require('../config/database');
const { getCallbackUrl } = require('../utils/helpers');
const { MAX_RETRY_ATTEMPTS, RETRY_DELAY_MS } = require('../utils/constants');

// ---- Retry Operation Helper ----
async function retryOperation(fn, maxRetries = MAX_RETRY_ATTEMPTS, delay = RETRY_DELAY_MS) {
  let lastError;
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      console.log(`🔄 Retry ${i + 1}/${maxRetries} after error:`, err.message);
      if (i < maxRetries - 1) {
        await new Promise(resolve => setTimeout(resolve, delay * (i + 1)));
      }
    }
  }
  throw lastError;
}

// ---- Get M-Pesa Access Token ----
async function getMpesaAccessToken() {
  const consumerKey = process.env.MPESA_CONSUMER_KEY;
  const consumerSecret = process.env.MPESA_CONSUMER_SECRET;

  // Check if credentials are configured
  if (!consumerKey || !consumerSecret || 
      consumerKey === 'YOUR_CONSUMER_KEY_HERE' || 
      consumerKey === 'your_consumer_key_here') {
    console.warn('⚠️ M-Pesa credentials not configured. Using simulation mode.');
    return null;
  }

  try {
    const auth = Buffer.from(`${consumerKey}:${consumerSecret}`).toString('base64');
    const response = await retryOperation(async () => {
      const res = await fetch('https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials', {
        method: 'GET',
        headers: {
          'Authorization': `Basic ${auth}`,
          'Content-Type': 'application/json'
        }
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Failed to get token: ${res.status} - ${text}`);
      }
      return res;
    });

    const data = await response.json();
    if (!data.access_token) {
      throw new Error('No access token in response');
    }

    return data.access_token;
  } catch (error) {
    console.error('❌ M-Pesa token error:', error);
    logError(error, 'M-Pesa token');
    return null;
  }
}

// ---- Initiate M-Pesa STK Push ----
async function initiateMpesaStkPush(phoneNumber, amount, accountReference, transactionDesc = 'Payment for order') {
  try {
    // Get access token
    const accessToken = await retryOperation(() => getMpesaAccessToken());
    
    // If no token, use simulation mode
    if (!accessToken) {
      console.warn('⚠️ Using M-Pesa simulation mode');
      return {
        success: true,
        checkoutRequestId: `SIM-${Date.now()}`,
        merchantRequestId: `SIM-MERCH-${Date.now()}`,
        message: 'M-Pesa payment simulated successfully (no credentials configured)',
        isSimulation: true
      };
    }

    const shortcode = process.env.MPESA_SHORTCODE || '174379';
    const passkey = process.env.MPESA_PASSKEY;
    const callbackUrl = getCallbackUrl('mpesa');

    // Validate required configs
    if (!passkey || passkey === 'YOUR_PASSKEY_HERE' || passkey === 'your_passkey_here') {
      console.warn('⚠️ M-Pesa passkey not configured. Using simulation mode.');
      return {
        success: true,
        checkoutRequestId: `SIM-${Date.now()}`,
        merchantRequestId: `SIM-MERCH-${Date.now()}`,
        message: 'M-Pesa payment simulated (passkey not configured)',
        isSimulation: true
      };
    }

    if (!callbackUrl || callbackUrl.includes('your-ngrok-url') || callbackUrl.includes('localhost')) {
      console.warn('⚠️ M-Pesa callback URL not properly configured. Using simulation mode.');
      return {
        success: true,
        checkoutRequestId: `SIM-${Date.now()}`,
        merchantRequestId: `SIM-MERCH-${Date.now()}`,
        message: 'M-Pesa payment simulated (callback URL not configured)',
        isSimulation: true
      };
    }

    // Format phone number
    let formattedPhone = phoneNumber.replace(/^0/, '254').replace(/^\+/, '').replace(/[^0-9]/g, '');
    if (!formattedPhone.startsWith('254')) {
      formattedPhone = '254' + formattedPhone;
    }

    // Generate timestamp and password
    const timestamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
    const password = Buffer.from(`${shortcode}${passkey}${timestamp}`).toString('base64');

    // Prepare request body
    const requestBody = {
      BusinessShortCode: shortcode,
      Password: password,
      Timestamp: timestamp,
      TransactionType: 'CustomerPayBillOnline',
      Amount: Math.round(amount),
      PartyA: formattedPhone,
      PartyB: shortcode,
      PhoneNumber: formattedPhone,
      CallBackURL: callbackUrl,
      AccountReference: accountReference || `ORD-${Date.now()}`,
      TransactionDesc: transactionDesc || 'Payment for order'
    };

    console.log('📤 M-Pesa STK Push Request:', {
      ...requestBody,
      Password: '***HIDDEN***'
    });

    // Make the API call
    const response = await retryOperation(async () => {
      const res = await fetch('https://sandbox.safaricom.co.ke/mpesa/stkpush/v1/processrequest', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(requestBody)
      });
      
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`STK Push failed: ${res.status} - ${text}`);
      }
      return res;
    });

    const data = await response.json();

    // Check response
    if (data.ResponseCode === '0') {
      return {
        success: true,
        checkoutRequestId: data.CheckoutRequestID,
        merchantRequestId: data.MerchantRequestID,
        message: 'STK Push sent successfully. Please check your phone and enter PIN.',
        isSimulation: false
      };
    } else {
      console.error('❌ M-Pesa STK Push error response:', data);
      return {
        success: false,
        errorCode: data.ResponseCode || 'UNKNOWN',
        message: data.ResponseDescription || 'STK Push failed. Please try again.',
        isSimulation: false
      };
    }
  } catch (error) {
    console.error('❌ M-Pesa STK Push error:', error);
    logError(error, 'M-Pesa STK Push');
    return {
      success: false,
      message: error.message || 'Payment initiation failed. Please try again.',
      isSimulation: false
    };
  }
}

// ---- Query M-Pesa Transaction Status ----
async function queryMpesaStatus(checkoutRequestId) {
  try {
    const accessToken = await getMpesaAccessToken();
    
    if (!accessToken) {
      return {
        success: false,
        message: 'Unable to query transaction status',
        isSimulation: true
      };
    }

    const shortcode = process.env.MPESA_SHORTCODE || '174379';
    const passkey = process.env.MPESA_PASSKEY;
    
    if (!passkey || passkey === 'YOUR_PASSKEY_HERE') {
      return {
        success: false,
        message: 'Passkey not configured',
        isSimulation: true
      };
    }

    const timestamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
    const password = Buffer.from(`${shortcode}${passkey}${timestamp}`).toString('base64');

    const response = await fetch('https://sandbox.safaricom.co.ke/mpesa/stkpushquery/v1/query', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        BusinessShortCode: shortcode,
        Password: password,
        Timestamp: timestamp,
        CheckoutRequestID: checkoutRequestId
      })
    });

    const data = await response.json();
    
    return {
      success: true,
      data: data
    };
  } catch (error) {
    console.error('❌ M-Pesa status query error:', error);
    return {
      success: false,
      message: error.message,
      data: null
    };
  }
}

// ---- Export ----
module.exports = { 
  getMpesaAccessToken, 
  initiateMpesaStkPush,
  queryMpesaStatus
};