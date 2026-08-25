const { pool, logError } = require('../config/database');
const { getCallbackUrl } = require('../utils/helpers');
const { MAX_RETRY_ATTEMPTS, RETRY_DELAY_MS } = require('../utils/constants');

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

async function getMpesaAccessToken() {
  const consumerKey = process.env.MPESA_CONSUMER_KEY;
  const consumerSecret = process.env.MPESA_CONSUMER_SECRET;

  if (!consumerKey || !consumerSecret || consumerKey === 'YOUR_CONSUMER_KEY_HERE') {
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
        throw new Error(`Failed to get token: ${res.status}`);
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

async function initiateMpesaStkPush(phoneNumber, amount, accountReference, transactionDesc = 'Payment for order') {
  try {
    const accessToken = await retryOperation(() => getMpesaAccessToken());
    
    if (!accessToken) {
      console.warn('⚠️ Using M-Pesa simulation mode');
      return {
        success: true,
        checkoutRequestId: `SIM-${Date.now()}`,
        message: 'M-Pesa payment simulated successfully',
        isSimulation: true
      };
    }

    const shortcode = process.env.MPESA_SHORTCODE;
    const passkey = process.env.MPESA_PASSKEY;
    const callbackUrl = getCallbackUrl('mpesa');

    if (!shortcode || !passkey) {
      console.warn('⚠️ M-Pesa configuration incomplete. Using simulation.');
      return {
        success: true,
        checkoutRequestId: `SIM-${Date.now()}`,
        message: 'M-Pesa payment simulated (incomplete config)',
        isSimulation: true
      };
    }

    let formattedPhone = phoneNumber.replace(/^0/, '254').replace(/^\+/, '').replace(/[^0-9]/g, '');
    if (!formattedPhone.startsWith('254')) {
      formattedPhone = '254' + formattedPhone;
    }

    const timestamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
    const password = Buffer.from(`${shortcode}${passkey}${timestamp}`).toString('base64');

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
      TransactionDesc: transactionDesc
    };

    console.log('📤 M-Pesa STK Push Request:', {
      ...requestBody,
      Password: '***HIDDEN***'
    });

    const response = await retryOperation(async () => {
      const res = await fetch('https://sandbox.safaricom.co.ke/mpesa/stkpush/v1/processrequest', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(requestBody)
      });
      return res;
    });

    const data = await response.json();

    if (data.ResponseCode === '0') {
      return {
        success: true,
        checkoutRequestId: data.CheckoutRequestID,
        merchantRequestId: data.MerchantRequestID,
        message: 'STK Push sent successfully. Please check your phone.',
        isSimulation: false
      };
    } else {
      return {
        success: false,
        errorCode: data.ResponseCode,
        message: data.ResponseDescription || 'STK Push failed',
        isSimulation: false
      };
    }
  } catch (error) {
    console.error('❌ M-Pesa STK Push error:', error);
    logError(error, 'M-Pesa STK Push');
    return {
      success: false,
      message: error.message || 'Payment initiation failed',
      isSimulation: false
    };
  }
}

module.exports = { getMpesaAccessToken, initiateMpesaStkPush };