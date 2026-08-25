// src/services/paypal.js
const paypal = require('@paypal/checkout-server-sdk');
const { v4: uuidv4 } = require('uuid');
const { pool, logError } = require('../config/database');
const { appendOrderStatus } = require('./orderService');
const { sendEmail, orderConfirmationEmail } = require('./email'); // Fixed: './email' is correct since email.js is in the same services folder

let paypalClient = null;

function initPaypalClient() {
  if (process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_CLIENT_SECRET && 
      process.env.PAYPAL_CLIENT_ID !== 'your_paypal_client_id_here') {
    const environment = process.env.PAYPAL_MODE === 'production' 
      ? new paypal.core.LiveEnvironment(process.env.PAYPAL_CLIENT_ID, process.env.PAYPAL_CLIENT_SECRET)
      : new paypal.core.SandboxEnvironment(process.env.PAYPAL_CLIENT_ID, process.env.PAYPAL_CLIENT_SECRET);
    paypalClient = new paypal.core.PayPalHttpClient(environment);
    console.log('✅ PayPal configured');
    return true;
  } else {
    console.log('⚠️ PayPal credentials not configured. Using simulation mode.');
    return false;
  }
}

function getPaypalClient() {
  return paypalClient;
}

module.exports = { initPaypalClient, getPaypalClient };