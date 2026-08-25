// ================================================================
//  airtel.js - Airtel Money Integration with Simulation Mode
//  Location: D:\my-business-website\src\services\airtel.js
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

// ---- Get Airtel Access Token ----
async function getAirtelAccessToken() {
  const clientId = process.env.AIRTEL_CLIENT_ID;
  const clientSecret = process.env.AIRTEL_CLIENT_SECRET;

  // Check if credentials are configured
  if (!clientId || !clientSecret || 
      clientId === 'your_airtel_client_id_here' || 
      clientSecret === 'your_airtel_client_secret_here') {
    console.warn('⚠️ Airtel credentials not configured. Using simulation mode.');
    return null;
  }

  try {
    const response = await retryOperation(async () => {
      const res = await fetch('https://openapi.airtel.africa/auth/oauth/v2/token', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          client_id: clientId,
          client_secret: clientSecret,
          grant_type: 'client_credentials'
        })
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Failed to get Airtel token: ${res.status} - ${text}`);
      }
      return res;
    });

    const data = await response.json();
    if (!data.access_token) {
      throw new Error('No access token in response');
    }
    return data.access_token;
  } catch (error) {
    console.error('❌ Airtel token error:', error);
    logError(error, 'Airtel token');
    return null;
  }
}

// ---- Initiate Airtel Payment ----
async function initiateAirtelPayment(phoneNumber, amount, accountReference, transactionDesc = 'Payment for order') {
  try {
    const accessToken = await retryOperation(() => getAirtelAccessToken());
    
    if (!accessToken) {
      console.warn('⚠️ Using Airtel simulation mode');
      return {
        success: true,
        transactionId: `SIM-AIRTEL-${Date.now()}`,
        message: 'Airtel Money payment simulated successfully (no credentials configured)',
        isSimulation: true
      };
    }

    const callbackUrl = getCallbackUrl('airtel');

    if (!callbackUrl || callbackUrl.includes('your-ngrok-url') || callbackUrl.includes('localhost')) {
      console.warn('⚠️ Airtel callback URL not properly configured. Using simulation mode.');
      return {
        success: true,
        transactionId: `SIM-AIRTEL-${Date.now()}`,
        message: 'Airtel Money payment simulated (callback URL not configured)',
        isSimulation: true
      };
    }

    // Format phone number
    let formattedPhone = phoneNumber.replace(/^0/, '254').replace(/^\+/, '').replace(/[^0-9]/g, '');
    if (!formattedPhone.startsWith('254')) {
      formattedPhone = '254' + formattedPhone;
    }

    // Prepare request body
    const requestBody = {
      amount: Math.round(amount),
      currency: 'KES',
      country: 'KE',
      msisdn: formattedPhone,
      transaction_type: 'PAYMENT',
      reference: accountReference || `ORD-${Date.now()}`,
      callback_url: callbackUrl,
      description: transactionDesc || 'Payment for order'
    };

    console.log('📤 Airtel Payment Request:', {
      ...requestBody,
      client_id: process.env.AIRTEL_CLIENT_ID ? '***HIDDEN***' : 'NOT SET'
    });

    // Make the API call
    const response = await retryOperation(async () => {
      const res = await fetch('https://openapi.airtel.africa/merchant/v1/payments', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: JSON.stringify(requestBody)
      });
      
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Airtel payment failed: ${res.status} - ${text}`);
      }
      return res;
    });

    const data = await response.json();

    console.log('📥 Airtel Payment Response:', data);

    // Check response
    if (data.status === 'success' || data.status === 'pending' || data.transaction_id) {
      return {
        success: true,
        transactionId: data.transaction_id || data.reference || `AIRTEL-${Date.now()}`,
        message: 'Airtel Money payment initiated. Please check your phone.',
        isSimulation: false,
        rawResponse: data
      };
    } else {
      console.error('❌ Airtel payment error response:', data);
      return {
        success: false,
        message: data.message || data.error || 'Airtel payment failed. Please try again.',
        errorCode: data.code || 'UNKNOWN',
        isSimulation: false
      };
    }
  } catch (error) {
    console.error('❌ Airtel payment error:', error);
    logError(error, 'Airtel payment');
    return {
      success: false,
      message: error.message || 'Payment initiation failed. Please try again.',
      isSimulation: false
    };
  }
}

// ---- Query Airtel Transaction Status ----
async function queryAirtelStatus(transactionId) {
  try {
    const accessToken = await getAirtelAccessToken();
    
    if (!accessToken) {
      return {
        success: false,
        message: 'Unable to query transaction status',
        isSimulation: true
      };
    }

    const response = await fetch(`https://openapi.airtel.africa/merchant/v1/payments/${transactionId}`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      }
    });

    const data = await response.json();
    
    return {
      success: true,
      data: data
    };
  } catch (error) {
    console.error('❌ Airtel status query error:', error);
    return {
      success: false,
      message: error.message,
      data: null
    };
  }
}

// ---- Export ----
module.exports = { 
  getAirtelAccessToken, 
  initiateAirtelPayment,
  queryAirtelStatus
};