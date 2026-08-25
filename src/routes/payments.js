const express = require('express');
const { body, validationResult } = require('express-validator');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { pool } = require('../config/database');
const { authMiddleware } = require('../middleware/auth');
const { sensitiveLimiter } = require('../middleware/rateLimiter');
const { validateKenyanPhone } = require('../utils/helpers');
const { initiateMpesaStkPush, getMpesaAccessToken } = require('../services/mpesa');
const { initiateAirtelPayment, getAirtelAccessToken } = require('../services/airtel');
const { getPaypalClient } = require('../services/paypal');
const { appendOrderStatus, logAdminActivity } = require('../services/orderService');
const { sendEmail, orderConfirmationEmail } = require('../services/email');
const router = express.Router();

// ============================================================
//  M-PESA CALLBACK
// ============================================================

router.post('/mpesa-callback', async (req, res) => {
  try {
    console.log('📥 M-Pesa Callback received');
    const body = req.body;
    const stkCallback = body?.Body?.stkCallback;

    if (!stkCallback) {
      console.error('❌ Invalid callback structure');
      return res.status(400).json({ ResultCode: 1, ResultDesc: 'Invalid callback' });
    }

    const resultCode = stkCallback.ResultCode;
    const resultDesc = stkCallback.ResultDesc;
    const checkoutRequestId = stkCallback.CheckoutRequestID;

    let transactionId = null;
    let amount = null;
    let phoneNumber = null;

    if (stkCallback.CallbackMetadata) {
      const items = stkCallback.CallbackMetadata.Item || [];
      items.forEach(item => {
        if (item.Name === 'MpesaReceiptNumber') transactionId = item.Value;
        if (item.Name === 'Amount') amount = item.Value;
        if (item.Name === 'PhoneNumber') phoneNumber = item.Value;
      });
    }

    const isSuccess = resultCode === '0';

    const paymentResult = await pool.query(`
      SELECT id, order_id, customer_id 
      FROM payments 
      WHERE transaction_id = $1 OR (payment_details->>'checkoutRequestId' = $1)
      ORDER BY created_at DESC 
      LIMIT 1
    `, [checkoutRequestId]);

    if (paymentResult.rows.length > 0) {
      const payment = paymentResult.rows[0];
      const orderId = payment.order_id;

      await pool.query(`
        UPDATE payments 
        SET status = $1, 
            transaction_id = COALESCE($2, transaction_id),
            payment_details = payment_details || $3
        WHERE id = $4
      `, [
        isSuccess ? 'success' : 'failed',
        transactionId || uuidv4(),
        JSON.stringify({
          callbackResult: {
            resultCode,
            resultDesc,
            checkoutRequestId,
            transactionId,
            amount,
            phoneNumber
          }
        }),
        payment.id
      ]);

      if (isSuccess && orderId) {
        await pool.query(`
          UPDATE orders 
          SET payment_status = 'paid', 
              status = 'pending'
          WHERE id = $1 AND status = 'pending_payment'
        `, [orderId]);

        await appendOrderStatus(orderId, 'pending', 'Payment successful. Order confirmed.');

        const orderResult = await pool.query(`
          SELECT o.*, c.name AS customer_name, c.email AS customer_email
          FROM orders o
          JOIN customers c ON o.customer_id = c.id
          WHERE o.id = $1
        `, [orderId]);

        if (orderResult.rows.length > 0) {
          const order = orderResult.rows[0];
          const itemsResult = await pool.query('SELECT * FROM order_items WHERE order_id = $1', [orderId]);
          order.items = itemsResult.rows;

          try {
            const mailData = orderConfirmationEmail(order, order.customer_name);
            await sendEmail({
              to: order.customer_email,
              ...mailData
            });
          } catch (emailError) {
            console.error('⚠️ Email send failed:', emailError.message);
          }

          const io = req.app.get('io');
          io.emit('new-order', { orderId });
          io.to(`order_${orderId}`).emit('payment-updated', {
            orderId,
            paymentStatus: 'paid',
            transactionId
          });
        }
      }
    }

    res.json({ ResultCode: 0, ResultDesc: 'Success' });

  } catch (error) {
    console.error('❌ M-Pesa callback error:', error);
    res.status(500).json({ ResultCode: 1, ResultDesc: 'Error processing callback' });
  }
});

// ============================================================
//  M-PESA INITIATE
// ============================================================

router.post('/mpesa/initiate', authMiddleware, sensitiveLimiter, [
  body('phone').notEmpty().withMessage('Phone number required'),
  body('amount').isNumeric().withMessage('Amount must be a number')
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  try {
    const { phone, amount, orderId } = req.body;
    const customerId = req.userId;

    if (amount < 1) {
      return res.status(400).json({ error: 'Amount must be at least Ksh 1' });
    }

    if (!validateKenyanPhone(phone)) {
      return res.status(400).json({ error: 'Invalid phone number. Must be a valid Kenyan number (e.g., 0712345678)' });
    }

    let orderRef = `ORD-${Date.now()}`;
    let actualOrderId = orderId;

    if (!orderId) {
      const orderResult = await pool.query(`
        INSERT INTO orders (customer_id, total, status, order_ref, status_history, payment_status)
        VALUES ($1, $2, 'pending_payment', $3, $4, 'pending')
        RETURNING *
      `, [
        customerId,
        amount,
        orderRef,
        JSON.stringify([{ status: 'pending_payment', timestamp: new Date().toISOString() }])
      ]);
      actualOrderId = orderResult.rows[0].id;
    }

    const stkResult = await initiateMpesaStkPush(phone, amount, orderRef);

    if (stkResult.success) {
      const paymentResult = await pool.query(`
        INSERT INTO payments (customer_id, order_id, amount, method, status, transaction_id, payment_details)
        VALUES ($1, $2, $3, 'mpesa', 'pending', $4, $5)
        RETURNING *
      `, [
        customerId,
        actualOrderId,
        amount,
        stkResult.checkoutRequestId || `SIM-${Date.now()}`,
        JSON.stringify({
          phone: phone,
          checkoutRequestId: stkResult.checkoutRequestId,
          isSimulation: stkResult.isSimulation || false
        })
      ]);

      res.json({
        success: true,
        message: stkResult.message,
        checkoutRequestId: stkResult.checkoutRequestId,
        orderId: actualOrderId,
        paymentId: paymentResult.rows[0].id,
        isSimulation: stkResult.isSimulation || false
      });
    } else {
      res.status(400).json({
        success: false,
        message: stkResult.message,
        errorCode: stkResult.errorCode
      });
    }

  } catch (error) {
    console.error('❌ M-Pesa initiate error:', error);
    res.status(500).json({ error: 'Payment initiation failed' });
  }
});

// ============================================================
//  M-PESA STATUS
// ============================================================

router.get('/mpesa/status/:checkoutRequestId', authMiddleware, async (req, res) => {
  try {
    const { checkoutRequestId } = req.params;

    if (!checkoutRequestId) {
      return res.status(400).json({ error: 'Checkout Request ID required' });
    }

    if (checkoutRequestId.startsWith('SIM-')) {
      const paymentResult = await pool.query(`
        SELECT status FROM payments 
        WHERE transaction_id = $1
      `, [checkoutRequestId]);

      if (paymentResult.rows.length > 0 && paymentResult.rows[0].status === 'success') {
        return res.json({
          success: true,
          data: { ResultCode: '0', ResultDesc: 'Success' }
        });
      }

      return res.json({
        success: true,
        data: { ResultCode: '1', ResultDesc: 'Pending' }
      });
    }

    const accessToken = await getMpesaAccessToken();
    if (!accessToken) {
      return res.status(400).json({ error: 'Unable to query transaction status' });
    }

    const shortcode = process.env.MPESA_SHORTCODE;
    const passkey = process.env.MPESA_PASSKEY;
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
    
    const paymentResult = await pool.query(`
      SELECT id FROM payments 
      WHERE transaction_id = $1 OR (payment_details->>'checkoutRequestId' = $1)
    `, [checkoutRequestId]);

    if (paymentResult.rows.length > 0) {
      await pool.query(`
        UPDATE payments 
        SET payment_details = payment_details || $1
        WHERE id = $2
      `, [
        JSON.stringify({ queryResult: data }),
        paymentResult.rows[0].id
      ]);

      if (data.ResultCode === '0') {
        await pool.query(`
          UPDATE payments SET status = 'success' WHERE id = $1
        `, [paymentResult.rows[0].id]);
      }
    }

    res.json({
      success: true,
      data: data
    });

  } catch (error) {
    console.error('❌ M-Pesa status query error:', error);
    res.status(500).json({
      error: 'Failed to query transaction status'
    });
  }
});

// ============================================================
//  SAVE M-PESA CREDENTIALS (Admin)
// ============================================================

router.post('/mpesa/save-credentials', authMiddleware, async (req, res) => {
  if (req.role !== 'admin') {
    return res.status(403).json({ error: 'Admin only' });
  }

  try {
    const { consumerKey, consumerSecret, passkey, shortcode, callbackUrl, environment } = req.body;

    if (!consumerKey || !consumerSecret || !passkey) {
      return res.status(400).json({ error: 'All M-Pesa credentials are required' });
    }

    const envPath = path.join(process.cwd(), '.env');
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

    for (const line of lines) {
      let isKey = false;
      for (const [key, value] of Object.entries(mpesaKeys)) {
        if (line.trim().startsWith(`${key}=`)) {
          newLines.push(`${key}=${value}`);
          isKey = true;
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
      }
    }

    fs.writeFileSync(envPath, newLines.join('\n'));

    await logAdminActivity(req.userId, 'UPDATE_MPESA_CREDENTIALS', {
      environment: environment || 'sandbox',
      shortcode: shortcode || '174379'
    });

    res.json({
      success: true,
      message: 'M-Pesa credentials saved successfully'
    });

  } catch (error) {
    console.error('❌ Error saving M-Pesa credentials:', error);
    res.status(500).json({
      error: 'Failed to save credentials: ' + error.message
    });
  }
});

// ============================================================
//  TEST M-PESA CONNECTION (Admin)
// ============================================================

router.get('/mpesa/test-connection', authMiddleware, async (req, res) => {
  if (req.role !== 'admin') {
    return res.status(403).json({ error: 'Admin only' });
  }

  try {
    const consumerKey = process.env.MPESA_CONSUMER_KEY;
    const consumerSecret = process.env.MPESA_CONSUMER_SECRET;

    if (!consumerKey || !consumerSecret || consumerKey === 'YOUR_CONSUMER_KEY_HERE') {
      return res.status(400).json({
        success: false,
        error: 'M-Pesa credentials are not configured'
      });
    }

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
      res.json({
        success: true,
        message: 'Successfully connected to Safaricom API',
        environment: process.env.MPESA_ENVIRONMENT || 'sandbox'
      });
    } else {
      const text = await response.text();
      res.status(400).json({
        success: false,
        error: `Failed to connect: ${response.status} - ${text}`
      });
    }

  } catch (error) {
    console.error('❌ M-Pesa connection test error:', error);
    res.status(500).json({
      success: false,
      error: 'Connection test failed: ' + error.message
    });
  }
});

// ============================================================
//  AIRTEL MONEY INITIATE
// ============================================================

router.post('/airtel/initiate', authMiddleware, sensitiveLimiter, [
  body('phone').notEmpty().withMessage('Phone number required'),
  body('amount').isNumeric().withMessage('Amount must be a number')
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  try {
    const { phone, amount, orderId } = req.body;
    const customerId = req.userId;

    if (amount < 1) {
      return res.status(400).json({ error: 'Amount must be at least Ksh 1' });
    }

    if (!validateKenyanPhone(phone)) {
      return res.status(400).json({ error: 'Invalid phone number. Must be a valid Kenyan number (e.g., 0712345678)' });
    }

    let orderRef = `ORD-${Date.now()}`;
    let actualOrderId = orderId;

    if (!orderId) {
      const orderResult = await pool.query(`
        INSERT INTO orders (customer_id, total, status, order_ref, status_history, payment_status)
        VALUES ($1, $2, 'pending_payment', $3, $4, 'pending')
        RETURNING *
      `, [
        customerId,
        amount,
        orderRef,
        JSON.stringify([{ status: 'pending_payment', timestamp: new Date().toISOString() }])
      ]);
      actualOrderId = orderResult.rows[0].id;
    }

    const airtelResult = await initiateAirtelPayment(phone, amount, orderRef);

    if (airtelResult.success) {
      const paymentResult = await pool.query(`
        INSERT INTO payments (customer_id, order_id, amount, method, status, transaction_id, payment_details)
        VALUES ($1, $2, $3, 'airtel', 'pending', $4, $5)
        RETURNING *
      `, [
        customerId,
        actualOrderId,
        amount,
        airtelResult.transactionId || `AIRTEL-${Date.now()}`,
        JSON.stringify({
          phone: phone,
          transactionId: airtelResult.transactionId,
          isSimulation: airtelResult.isSimulation || false,
          rawResponse: airtelResult.rawResponse || null
        })
      ]);

      res.json({
        success: true,
        message: airtelResult.message || 'Airtel Money payment initiated. Please check your phone.',
        transactionId: airtelResult.transactionId,
        orderId: actualOrderId,
        paymentId: paymentResult.rows[0].id,
        isSimulation: airtelResult.isSimulation || false
      });
    } else {
      res.status(400).json({
        success: false,
        message: airtelResult.message || 'Airtel payment failed. Please try again.',
        errorCode: airtelResult.errorCode
      });
    }

  } catch (error) {
    console.error('❌ Airtel initiate error:', error);
    res.status(500).json({ error: 'Airtel payment initiation failed. Please try again.' });
  }
});

// ============================================================
//  AIRTEL CALLBACK
// ============================================================

router.post('/airtel-callback', async (req, res) => {
  try {
    console.log('📥 Airtel Callback received:', JSON.stringify(req.body, null, 2));

    const body = req.body;
    const transactionId = body.transaction_id || body.transactionId || body.reference || body.id;
    const status = body.status || body.transaction_status || body.state || body.resultCode;
    const orderRef = body.reference || body.accountReference || body.external_id;

    const isSuccess = 
      status === 'success' || 
      status === 'completed' || 
      status === 'SUCCESS' || 
      status === 'approved' ||
      status === 'APPROVED' ||
      status === '00';

    if (!orderRef) {
      console.error('❌ No order reference in callback');
      return res.json({ status: 'success', message: 'Callback received' });
    }

    const orderResult = await pool.query(
      'SELECT id, customer_id FROM orders WHERE order_ref = $1',
      [orderRef]
    );

    if (orderResult.rows.length === 0) {
      console.error('❌ Order not found for reference:', orderRef);
      return res.json({ status: 'success', message: 'Callback received' });
    }

    const orderId = orderResult.rows[0].id;

    await pool.query(`
      UPDATE payments 
      SET status = $1, 
          transaction_id = COALESCE($2, transaction_id),
          payment_details = payment_details || $3
      WHERE order_id = $4 AND method = 'airtel'
    `, [
      isSuccess ? 'success' : 'failed',
      transactionId || uuidv4(),
      JSON.stringify({ 
        callback: body,
        callbackReceivedAt: new Date().toISOString()
      }),
      orderId
    ]);

    if (isSuccess) {
      await pool.query(`
        UPDATE orders 
        SET payment_status = 'paid', 
            status = 'pending'
        WHERE id = $1 AND status = 'pending_payment'
      `, [orderId]);

      await appendOrderStatus(orderId, 'pending', 'Airtel Money payment successful. Order confirmed.');

      try {
        const orderWithCustomer = await pool.query(`
          SELECT o.*, c.name AS customer_name, c.email AS customer_email
          FROM orders o
          JOIN customers c ON o.customer_id = c.id
          WHERE o.id = $1
        `, [orderId]);

        if (orderWithCustomer.rows.length > 0) {
          const order = orderWithCustomer.rows[0];
          const itemsResult = await pool.query('SELECT * FROM order_items WHERE order_id = $1', [orderId]);
          order.items = itemsResult.rows;

          const mailData = orderConfirmationEmail(order, order.customer_name);
          await sendEmail({
            to: order.customer_email,
            ...mailData
          });
        }
      } catch (emailError) {
        console.error('⚠️ Email send failed:', emailError.message);
      }

      const io = req.app.get('io');
      io.emit('new-order', { orderId });
      io.to(`order_${orderId}`).emit('payment-updated', {
        orderId,
        paymentStatus: 'paid',
        transactionId
      });
    }

    res.json({ status: 'success', message: 'Callback processed successfully' });

  } catch (error) {
    console.error('❌ Airtel callback error:', error);
    res.status(500).json({ status: 'error', message: 'Failed to process callback' });
  }
});

// ============================================================
//  AIRTEL STATUS
// ============================================================

router.get('/airtel/status/:transactionId', authMiddleware, async (req, res) => {
  try {
    const { transactionId } = req.params;

    if (!transactionId) {
      return res.status(400).json({ error: 'Transaction ID required' });
    }

    if (transactionId.startsWith('SIM-AIRTEL-')) {
      const paymentResult = await pool.query(`
        SELECT status FROM payments 
        WHERE transaction_id = $1
      `, [transactionId]);

      if (paymentResult.rows.length > 0 && paymentResult.rows[0].status === 'success') {
        return res.json({
          success: true,
          data: { status: 'success', message: 'Simulation payment successful' }
        });
      }

      return res.json({
        success: true,
        data: { status: 'pending', message: 'Simulation payment pending' }
      });
    }

    const accessToken = await getAirtelAccessToken();

    if (!accessToken) {
      return res.status(400).json({
        success: false,
        message: 'Unable to query transaction status'
      });
    }

    const response = await fetch(`https://openapi.airtel.africa/merchant/v1/payments/${transactionId}`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      }
    });

    const data = await response.json();

    const paymentResult = await pool.query(`
      SELECT id FROM payments 
      WHERE transaction_id = $1
    `, [transactionId]);

    if (paymentResult.rows.length > 0 && (data.status === 'success' || data.status === 'completed')) {
      await pool.query(`
        UPDATE payments SET status = 'success' WHERE id = $1
      `, [paymentResult.rows[0].id]);
    }

    res.json({
      success: true,
      data: data
    });

  } catch (error) {
    console.error('❌ Airtel status query error:', error);
    res.status(500).json({
      error: 'Failed to query transaction status'
    });
  }
});

// ============================================================
//  PAYPAL CREATE ORDER
// ============================================================

router.post('/paypal/create-order', authMiddleware, async (req, res) => {
  try {
    const { amount, orderId, currency = 'KES' } = req.body;
    const paypalClient = getPaypalClient();
    const paypal = require('@paypal/checkout-server-sdk');
    
    if (!amount || amount <= 0) {
      return res.status(400).json({ error: 'Invalid amount' });
    }
    
    if (!paypalClient) {
      const transactionId = `SIM-PAYPAL-${uuidv4().substring(0, 8)}`;
      
      const paymentResult = await pool.query(
        `INSERT INTO payments (customer_id, order_id, amount, method, status, transaction_id, payment_details)
         VALUES ($1, $2, $3, 'paypal', 'pending', $4, $5)
         RETURNING *`,
        [req.userId, orderId || null, amount, transactionId, JSON.stringify({ isSimulation: true })]
      );
      
      return res.json({
        success: true,
        orderId: paymentResult.rows[0].id,
        transactionId: transactionId,
        isSimulation: true,
        approvalUrl: '#',
        message: 'PayPal payment simulated successfully'
      });
    }
    
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
    
    const response = await paypalClient.execute(request);
    const approvalUrl = response.result.links.find(link => link.rel === 'approve').href;
    
    const paymentResult = await pool.query(
      `INSERT INTO payments (customer_id, order_id, amount, method, status, transaction_id, payment_details)
       VALUES ($1, $2, $3, 'paypal', 'pending', $4, $5)
       RETURNING *`,
      [req.userId, orderId || null, amount, response.result.id, JSON.stringify({ paypalOrder: response.result })]
    );
    
    res.json({
      success: true,
      orderId: paymentResult.rows[0].id,
      transactionId: response.result.id,
      approvalUrl: approvalUrl,
      isSimulation: false
    });
    
  } catch (error) {
    console.error('❌ PayPal order creation error:', error);
    res.status(500).json({ error: 'Failed to create PayPal order: ' + error.message });
  }
});

// ============================================================
//  PAYPAL CAPTURE
// ============================================================

router.post('/paypal/capture', authMiddleware, async (req, res) => {
  try {
    const { orderId, paypalOrderId } = req.body;
    const paypalClient = getPaypalClient();
    const paypal = require('@paypal/checkout-server-sdk');
    
    if (!orderId || !paypalOrderId) {
      return res.status(400).json({ error: 'Order ID and PayPal Order ID required' });
    }
    
    const paymentCheck = await pool.query(
      `SELECT * FROM payments WHERE transaction_id = $1 AND customer_id = $2`,
      [paypalOrderId, req.userId]
    );
    
    if (paymentCheck.rows.length > 0 && paymentCheck.rows[0].payment_details?.isSimulation) {
      await pool.query(
        `UPDATE payments SET status = 'success' WHERE id = $1`,
        [paymentCheck.rows[0].id]
      );
      return res.json({ success: true, message: 'Simulation payment captured' });
    }
    
    if (!paypalClient) {
      return res.status(400).json({ error: 'PayPal not configured' });
    }
    
    const request = new paypal.orders.OrdersCaptureRequest(paypalOrderId);
    request.requestBody({});
    
    const response = await paypalClient.execute(request);
    
    if (response.result.status === 'COMPLETED') {
      await pool.query(
        `UPDATE payments SET status = 'success', payment_details = payment_details || $1 
         WHERE transaction_id = $2`,
        [JSON.stringify({ captureResult: response.result }), paypalOrderId]
      );
      
      const orderResult = await pool.query(
        `SELECT id FROM orders WHERE id = $1`,
        [orderId]
      );
      
      if (orderResult.rows.length > 0) {
        await pool.query(
          `UPDATE orders SET payment_status = 'paid', status = 'pending' 
           WHERE id = $1 AND status = 'pending_payment'`,
          [orderId]
        );
        await appendOrderStatus(orderId, 'pending', 'PayPal payment successful. Order confirmed.');
        
        try {
          const orderWithCustomer = await pool.query(
            `SELECT o.*, c.name AS customer_name, c.email AS customer_email
             FROM orders o
             JOIN customers c ON o.customer_id = c.id
             WHERE o.id = $1`,
            [orderId]
          );
          
          if (orderWithCustomer.rows.length > 0) {
            const order = orderWithCustomer.rows[0];
            const itemsResult = await pool.query('SELECT * FROM order_items WHERE order_id = $1', [orderId]);
            order.items = itemsResult.rows;
            const mailData = orderConfirmationEmail(order, order.customer_name);
            await sendEmail({ to: order.customer_email, ...mailData });
          }
        } catch (emailError) {
          console.error('⚠️ Email send failed:', emailError.message);
        }
        
        const io = req.app.get('io');
        io.emit('new-order', { orderId });
        io.to(`order_${orderId}`).emit('payment-updated', {
          orderId,
          paymentStatus: 'paid',
          transactionId: paypalOrderId
        });
      }
      
      res.json({
        success: true,
        message: 'Payment captured successfully',
        transactionId: paypalOrderId
      });
    } else {
      res.status(400).json({
        success: false,
        message: 'Payment not completed',
        status: response.result.status
      });
    }
    
  } catch (error) {
    console.error('❌ PayPal capture error:', error);
    res.status(500).json({ error: 'Failed to capture payment: ' + error.message });
  }
});

// ============================================================
//  GET PAYMENTS FOR ORDER
// ============================================================

router.get('/order/:id', authMiddleware, async (req, res) => {
  const orderId = parseInt(req.params.id);
  try {
    const result = await pool.query(
      'SELECT * FROM payments WHERE order_id = $1 ORDER BY created_at DESC',
      [orderId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
//  GET CUSTOMER PAYMENTS
// ============================================================

router.get('/customer', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT p.*, o.order_ref
       FROM payments p
       LEFT JOIN orders o ON p.order_id = o.id
       WHERE p.customer_id = $1
       ORDER BY p.created_at DESC`,
      [req.userId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
//  INITIATE PAYMENT (Generic)
// ============================================================

router.post('/initiate', authMiddleware, async (req, res) => {
  try {
    const {
      orderId, method, amount, phone, account, bank, pin,
      delivery_address, recipient_name, recipient_phone,
      delivery_instructions, customer_lat, customer_lng, location_accuracy
    } = req.body;
    const customerId = req.userId;

    if (!method || !amount) {
      return res.status(400).json({ error: 'Payment method and amount required.' });
    }

    if (method === 'mpesa') {
      if (!phone) return res.status(400).json({ error: 'Phone number required for M-Pesa.' });
      if (!validateKenyanPhone(phone)) {
        return res.status(400).json({ error: 'Invalid phone number. Must be a valid Kenyan number.' });
      }
      
      const stkResult = await initiateMpesaStkPush(phone, amount, `ORD-${orderId || Date.now()}`);

      if (stkResult.success) {
        const paymentResult = await pool.query(`
          INSERT INTO payments (customer_id, order_id, amount, method, status, transaction_id, payment_details)
          VALUES ($1, $2, $3, 'mpesa', 'pending', $4, $5)
          RETURNING *
        `, [
          customerId,
          orderId || null,
          amount,
          stkResult.checkoutRequestId || `SIM-${Date.now()}`,
          JSON.stringify({
            phone: phone,
            checkoutRequestId: stkResult.checkoutRequestId,
            isSimulation: stkResult.isSimulation || false
          })
        ]);

        return res.json({
          success: true,
          payment: paymentResult.rows[0],
          message: stkResult.message,
          checkoutRequestId: stkResult.checkoutRequestId,
          isSimulation: stkResult.isSimulation || false
        });
      } else {
        return res.status(400).json({
          success: false,
          message: stkResult.message || 'M-Pesa payment failed'
        });
      }
    }

    if (method === 'airtel') {
      if (!phone) return res.status(400).json({ error: 'Phone number required for Airtel Money.' });
      if (!validateKenyanPhone(phone)) {
        return res.status(400).json({ error: 'Invalid phone number. Must be a valid Kenyan number.' });
      }
      
      const airtelResult = await initiateAirtelPayment(phone, amount, `ORD-${orderId || Date.now()}`);

      if (airtelResult.success) {
        const paymentResult = await pool.query(`
          INSERT INTO payments (customer_id, order_id, amount, method, status, transaction_id, payment_details)
          VALUES ($1, $2, $3, 'airtel', 'pending', $4, $5)
          RETURNING *
        `, [
          customerId,
          orderId || null,
          amount,
          airtelResult.transactionId || `AIRTEL-${Date.now()}`,
          JSON.stringify({
            phone: phone,
            transactionId: airtelResult.transactionId,
            isSimulation: airtelResult.isSimulation || false
          })
        ]);

        return res.json({
          success: true,
          payment: paymentResult.rows[0],
          message: airtelResult.message || 'Airtel Money payment initiated.',
          transactionId: airtelResult.transactionId,
          isSimulation: airtelResult.isSimulation || false
        });
      } else {
        return res.status(400).json({
          success: false,
          message: airtelResult.message || 'Airtel Money payment failed'
        });
      }
    }

    if (method === 'bank') {
      if (!bank || !account) return res.status(400).json({ error: 'Bank and account number required.' });
      if (!pin || pin.length < 4) return res.status(400).json({ error: 'Valid PIN required.' });
    }

    if (orderId) {
      await pool.query(
        `UPDATE orders SET
          delivery_address = $1,
          recipient_name = $2,
          recipient_phone = $3,
          delivery_instructions = $4,
          customer_lat = $5,
          customer_lng = $6,
          location_accuracy = $7,
          location_detected_at = NOW()
        WHERE id = $8`,
        [delivery_address || null, recipient_name || null, recipient_phone || null,
         delivery_instructions || null, customer_lat || null, customer_lng || null,
         location_accuracy || null, orderId]
      );
    }

    const isSuccess = pin && pin.length >= 4;
    const status = isSuccess ? 'success' : 'failed';
    const transactionId = isSuccess ? uuidv4() : null;

    const paymentDetails = { phone, account, bank, pin: pin ? '***' : null };
    const result = await pool.query(
      `INSERT INTO payments (customer_id, order_id, amount, method, status, transaction_id, payment_details)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [customerId, orderId || null, amount, method, status, transactionId, JSON.stringify(paymentDetails)]
    );

    const payment = result.rows[0];

    if (isSuccess && orderId) {
      await pool.query('UPDATE orders SET payment_status = $1 WHERE id = $2', ['paid', orderId]);
      await pool.query(
        `UPDATE orders SET status = 'pending' WHERE id = $1 AND status = 'pending_payment'`,
        [orderId]
      );
      await appendOrderStatus(orderId, 'pending', 'Payment successful. Order confirmed.');
      const io = req.app.get('io');
      io.emit('new-order', { orderId });
      io.to(`order_${orderId}`).emit('payment-updated', { orderId, paymentStatus: 'paid' });
    }

    res.json({
      success: isSuccess,
      payment: payment,
      message: isSuccess ? '✅ Payment successful! Your order has been confirmed.' : '❌ Payment failed. Please try again.',
      transactionId
    });

  } catch (err) {
    console.error('Payment initiation error:', err);
    res.status(500).json({ error: 'Payment processing failed.' });
  }
});

module.exports = router;