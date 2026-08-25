// ================================================================
//  paypal.js - PayPal Integration with Simulation Mode
//  Location: D:\my-business-website\src\services\paypal.js
// ================================================================

const paypal = require('@paypal/checkout-server-sdk');
const { v4: uuidv4 } = require('uuid');

let paypalClient = null;

/**
 * Initialize PayPal Client
 */
function initPaypalClient() {
  const clientId = process.env.PAYPAL_CLIENT_ID;
  const clientSecret = process.env.PAYPAL_CLIENT_SECRET;

  // Check if PayPal credentials are configured
  if (clientId && clientSecret && 
      clientId !== 'your_paypal_client_id_here' &&
      clientId !== 'YOUR_PAYPAL_CLIENT_ID_HERE') {
    
    try {
      const environment = process.env.PAYPAL_MODE === 'production' 
        ? new paypal.core.LiveEnvironment(clientId, clientSecret)
        : new paypal.core.SandboxEnvironment(clientId, clientSecret);
      
      paypalClient = new paypal.core.PayPalHttpClient(environment);
      console.log('✅ PayPal configured successfully');
      return true;
    } catch (error) {
      console.error('❌ PayPal initialization error:', error.message);
      paypalClient = null;
      return false;
    }
  } else {
    console.log('⚠️ PayPal credentials not configured. Using simulation mode.');
    console.log('📌 To enable PayPal, set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET in .env');
    return false;
  }
}

/**
 * Get PayPal Client
 */
function getPaypalClient() {
  return paypalClient;
}

/**
 * Create PayPal Order
 */
async function createPaypalOrder(amount, orderId, currency = 'KES') {
  const client = getPaypalClient();
  
  // If PayPal not configured, use simulation mode
  if (!client) {
    console.log('⚠️ Using PayPal simulation mode');
    const transactionId = `SIM-PAYPAL-${uuidv4().substring(0, 8)}`;
    return {
      success: true,
      transactionId: transactionId,
      approvalUrl: '#',
      isSimulation: true,
      message: 'PayPal payment simulated successfully (not configured)'
    };
  }

  try {
    const request = new paypal.orders.OrdersCreateRequest();
    request.prefer('return=representation');
    request.requestBody({
      intent: 'CAPTURE',
      purchase_units: [{
        amount: {
          currency_code: currency,
          value: amount.toString()
        },
        reference_id: `order-${orderId || Date.now()}`,
        description: `Order payment for ${orderId || 'shop order'}`
      }],
      application_context: {
        brand_name: process.env.SHOP_NAME || 'Our Shop',
        landing_page: 'BILLING',
        user_action: 'PAY_NOW',
        return_url: `${process.env.CLIENT_URL || 'http://localhost:3000'}/payment-success.html`,
        cancel_url: `${process.env.CLIENT_URL || 'http://localhost:3000'}/payment-cancel.html`
      }
    });

    const response = await client.execute(request);
    const approvalUrl = response.result.links.find(link => link.rel === 'approve').href;

    return {
      success: true,
      transactionId: response.result.id,
      approvalUrl: approvalUrl,
      isSimulation: false,
      order: response.result
    };
  } catch (error) {
    console.error('❌ PayPal order creation error:', error);
    return {
      success: false,
      message: error.message || 'Failed to create PayPal order',
      isSimulation: false
    };
  }
}

/**
 * Capture PayPal Order
 */
async function capturePaypalOrder(paypalOrderId) {
  const client = getPaypalClient();
  
  // If PayPal not configured, use simulation mode
  if (!client) {
    console.log('⚠️ Using PayPal simulation mode for capture');
    return {
      success: true,
      isSimulation: true,
      message: 'PayPal payment captured in simulation mode'
    };
  }

  try {
    const request = new paypal.orders.OrdersCaptureRequest(paypalOrderId);
    request.requestBody({});

    const response = await client.execute(request);
    
    if (response.result.status === 'COMPLETED') {
      return {
        success: true,
        isSimulation: false,
        data: response.result
      };
    } else {
      return {
        success: false,
        message: `Payment not completed. Status: ${response.result.status}`,
        isSimulation: false,
        data: response.result
      };
    }
  } catch (error) {
    console.error('❌ PayPal capture error:', error);
    return {
      success: false,
      message: error.message || 'Failed to capture payment',
      isSimulation: false
    };
  }
}

module.exports = { 
  initPaypalClient, 
  getPaypalClient,
  createPaypalOrder,
  capturePaypalOrder
};