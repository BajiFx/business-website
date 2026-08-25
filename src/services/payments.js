// ================================================================
//  payments.js - Payment Routes with Fixed M-Pesa Callback
// ================================================================

const express = require('express');
const { body, validationResult } = require('express-validator');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { pool } = require('../config/database');
const { authMiddleware } = require('../middleware/auth');
const { sensitiveLimiter } = require('../middleware/rateLimiter');
const { validateKenyanPhone } = require('../utils/helpers');
const { initiateMpesaStkPush, getMpesaAccessToken, queryMpesaStatus } = require('../services/mpesa');
const { initiateAirtelPayment, getAirtelAccessToken } = require('../services/airtel');
const { createPaypalOrder, capturePaypalOrder, getPaypalClient } = require('../services/paypal');
const { appendOrderStatus, logAdminActivity } = require('../services/orderService');
const { sendEmail, orderConfirmationEmail } = require('../services/email');
const router = express.Router();

// ============================================================
//  M-PESA CALLBACK - FIXED WITH BETTER ERROR HANDLING
// ============================================================

router.post('/mpesa-callback', async (req, res) => {
  try {
    console.log('📥 M-Pesa Callback received');
    console.log('📥 Callback body:', JSON.stringify(req.body, null, 2));

    const body = req.body;
    const stkCallback = body?.Body?.stkCallback;

    if (!stkCallback) {
      console.error('❌ Invalid callback structure - missing stkCallback');
      // Still return success to Safaricom
      return res.status(200).json({ ResultCode: 0, ResultDesc: 'Callback received' });
    }

    const resultCode = stkCallback.ResultCode;
    const resultDesc = stkCallback.ResultDesc;
    const checkoutRequestId = stkCallback.CheckoutRequestID;
    const merchantRequestId = stkCallback.MerchantRequestID;

    let transactionId = null;
    let amount = null;
    let phoneNumber = null;

    // Extract metadata
    if (stkCallback.CallbackMetadata) {
      const items = stkCallback.CallbackMetadata.Item || [];
      items.forEach(item => {
        if (item.Name === 'MpesaReceiptNumber') transactionId = item.Value;
        if (item.Name === 'Amount') amount = item.Value;
        if (item.Name === 'PhoneNumber') phoneNumber = item.Value;
      });
    }

    const isSuccess = resultCode === '0';

    console.log(`📊 Payment result: ${isSuccess ? '✅ SUCCESS' : '❌ FAILED'}`);
    console.log(`📊 Checkout Request ID: ${checkoutRequestId}`);
    console.log(`📊 Transaction ID: ${transactionId}`);
    console.log(`📊 Amount: ${amount}`);
    console.log(`📊 Phone: ${phoneNumber}`);

    // Find the payment record
    const paymentResult = await pool.query(`
      SELECT id, order_id, customer_id, payment_details
      FROM payments 
      WHERE transaction_id = $1 
         OR (payment_details->>'checkoutRequestId' = $1)
         OR (payment_details->>'checkoutRequestID' = $1)
      ORDER BY created_at DESC 
      LIMIT 1
    `, [checkoutRequestId]);

    if (paymentResult.rows.length === 0) {
      console.error(`❌ No payment found for checkoutRequestId: ${checkoutRequestId}`);
      // Try to find by merchant request ID
      const altResult = await pool.query(`
        SELECT id, order_id, customer_id
        FROM payments 
        WHERE payment_details->>'merchantRequestId' = $1
        ORDER BY created_at DESC 
        LIMIT 1
      `, [merchantRequestId]);
      
      if (altResult.rows.length === 0) {
        console.error('❌ No payment found in database');
        return res.status(200).json({ ResultCode: 0, ResultDesc: 'Callback received' });
      }
      
      paymentResult.rows = altResult.rows;
    }

    const payment = paymentResult.rows[0];
    const orderId = payment.order_id;

    // Update payment record
    await pool.query(`
      UPDATE payments 
      SET status = $1, 
          transaction_id = COALESCE($2, transaction_id),
          payment_details = payment_details || $3
      WHERE id = $4
    `, [
      isSuccess ? 'success' : 'failed',
      transactionId || null,
      JSON.stringify({
        callbackReceivedAt: new Date().toISOString(),
        callbackResult: {
          resultCode,
          resultDesc,
          checkoutRequestId,
          merchantRequestId,
          transactionId,
          amount,
          phoneNumber
        }
      }),
      payment.id
    ]);

    // If payment successful and we have an order ID
    if (isSuccess && orderId) {
      console.log(`✅ Updating order ${orderId} status to pending`);
      
      await pool.query(`
        UPDATE orders 
        SET payment_status = 'paid', 
            status = 'pending',
            updated_at = NOW()
        WHERE id = $1 AND status = 'pending_payment'
      `, [orderId]);

      // Add status history entry
      await appendOrderStatus(orderId, 'pending', 'Payment successful. Order confirmed.');

      // Get order details for email
      const orderResult = await pool.query(`
        SELECT o.*, c.name AS customer_name, c.email AS customer_email
        FROM orders o
        JOIN customers c ON o.customer_id = c.id
        WHERE o.id = $1
      `, [orderId]);

      if (orderResult.rows.length > 0) {
        const order = orderResult.rows[0];
        const itemsResult = await pool.query(
          'SELECT * FROM order_items WHERE order_id = $1',
          [orderId]
        );
        order.items = itemsResult.rows;

        // Send email confirmation
        try {
          const mailData = orderConfirmationEmail(order, order.customer_name);
          await sendEmail({
            to: order.customer_email,
            ...mailData
          });
          console.log(`📧 Confirmation email sent to ${order.customer_email}`);
        } catch (emailError) {
          console.error('⚠️ Email send failed:', emailError.message);
        }

        // Notify via Socket.IO
        const io = req.app.get('io');
        io.emit('new-order', { orderId });
        io.to(`order_${orderId}`).emit('payment-updated', {
          orderId,
          paymentStatus: 'paid',
          transactionId
        });
        io.to(`customer_${order.customer_id}`).emit('payment-updated', {
          orderId,
          paymentStatus: 'paid',
          transactionId
        });
      }
    }

    // Always return success to Safaricom
    res.json({ ResultCode: 0, ResultDesc: 'Success' });

  } catch (error) {
    console.error('❌ M-Pesa callback error:', error);
    // Always return success to Safaricom so they don't retry
    res.status(200).json({ ResultCode: 0, ResultDesc: 'Callback processed' });
  }
});

// ============================================================
//  M-PESA INITIATE - FIXED
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

    // If no order ID provided, create a new order
    let actualOrderId = orderId;
    let orderRef = `ORD-${Date.now()}`;

    if (!orderId) {
      const orderResult = await pool.query(`
        INSERT INTO orders (
          customer_id, total, status, order_ref, status_history, payment_status
        )
        VALUES ($1, $2, 'pending_payment', $3, $4, 'pending')
        RETURNING *
      `, [
        customerId,
        amount,
        orderRef,
        JSON.stringify([{ status: 'pending_payment', timestamp: new Date().toISOString() }])
      ]);
      actualOrderId = orderResult.rows[0].id;
      orderRef = orderResult.rows[0].order_ref;
    } else {
      // Get order ref for the payment
      const orderResult = await pool.query(
        'SELECT order_ref FROM orders WHERE id = $1',
        [orderId]
      );
      if (orderResult.rows.length > 0) {
        orderRef = orderResult.rows[0].order_ref;
      }
    }

    // Initiate M-Pesa STK Push
    const stkResult = await initiateMpesaStkPush(phone, amount, orderRef);

    if (stkResult.success) {
      // Create payment record
      const paymentResult = await pool.query(`
        INSERT INTO payments (
          customer_id, order_id, amount, method, status, transaction_id, payment_details
        )
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
          merchantRequestId: stkResult.merchantRequestId || null,
          isSimulation: stkResult.isSimulation || false,
          initiatedAt: new Date().toISOString()
        })
      ]);

      res.json({
        success: true,
        message: stkResult.message || 'STK Push sent. Please check your phone.',
        checkoutRequestId: stkResult.checkoutRequestId,
        orderId: actualOrderId,
        paymentId: paymentResult.rows[0].id,
        isSimulation: stkResult.isSimulation || false
      });
    } else {
      res.status(400).json({
        success: false,
        message: stkResult.message || 'M-Pesa payment failed. Please try again.',
        errorCode: stkResult.errorCode
      });
    }

  } catch (error) {
    console.error('❌ M-Pesa initiate error:', error);
    res.status(500).json({ error: 'Payment initiation failed. Please try again.' });
  }
});

// ============================================================
//  M-PESA STATUS QUERY - FIXED
// ============================================================

router.get('/mpesa/status/:checkoutRequestId', authMiddleware, async (req, res) => {
  try {
    const { checkoutRequestId } = req.params;

    if (!checkoutRequestId) {
      return res.status(400).json({ error: 'Checkout Request ID required' });
    }

    // Check if it's a simulation
    if (checkoutRequestId.startsWith('SIM-')) {
      const paymentResult = await pool.query(`
        SELECT status FROM payments 
        WHERE transaction_id = $1 OR (payment_details->>'checkoutRequestId' = $1)
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

    // Query actual status
    const statusResult = await queryMpesaStatus(checkoutRequestId);

    if (statusResult.success) {
      // Update payment record if status is resolved
      const data = statusResult.data;
      if (data.ResultCode === '0') {
        const paymentResult = await pool.query(`
          SELECT id FROM payments 
          WHERE transaction_id = $1 OR (payment_details->>'checkoutRequestId' = $1)
        `, [checkoutRequestId]);
        
        if (paymentResult.rows.length > 0) {
          await pool.query(`
            UPDATE payments 
            SET status = 'success',
                payment_details = payment_details || $1
            WHERE id = $2
          `, [
            JSON.stringify({ queryResult: data }),
            paymentResult.rows[0].id
          ]);
        }
      }
      
      res.json({
        success: true,
        data: statusResult.data
      });
    } else {
      res.json({
        success: false,
        message: statusResult.message
      });
    }

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
      'MPESA_CALLBACK_URL': callbackUrl || `${process.env.BASE_URL || 'http://localhost:3000'}/api/payments/mpesa-callback`,
      'MPESA_ENVIRONMENT': environment || 'sandbox'
    };

    // Process existing lines
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

    // Add any missing keys
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

    if (!consumerKey || !consumerSecret || 
        consumerKey === 'YOUR_CONSUMER_KEY_HERE' || 
        consumerKey === 'your_consumer_key_here') {
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
//  PAYPAL CREATE ORDER
// ============================================================

router.post('/paypal/create-order', authMiddleware, async (req, res) => {
  try {
    const { amount, orderId, currency = 'KES' } = req.body;
    const customerId = req.userId;
    
    if (!amount || amount <= 0) {
      return res.status(400).json({ error: 'Invalid amount' });
    }
    
    // Create PayPal order
    const result = await createPaypalOrder(amount, orderId, currency);
    
    if (result.success) {
      // Create payment record
      const paymentResult = await pool.query(`
        INSERT INTO payments (
          customer_id, order_id, amount, method, status, transaction_id, payment_details
        )
        VALUES ($1, $2, $3, 'paypal', 'pending', $4, $5)
        RETURNING *
      `, [
        customerId,
        orderId || null,
        amount,
        result.transactionId,
        JSON.stringify({
          isSimulation: result.isSimulation || false,
          paypalOrderId: result.transactionId,
          created_at: new Date().toISOString()
        })
      ]);

      res.json({
        success: true,
        orderId: paymentResult.rows[0].id,
        transactionId: result.transactionId,
        approvalUrl: result.approvalUrl,
        isSimulation: result.isSimulation || false,
        message: result.message || 'PayPal order created'
      });
    } else {
      res.status(400).json({
        success: false,
        message: result.message || 'Failed to create PayPal order'
      });
    }
    
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
    
    if (!orderId || !paypalOrderId) {
      return res.status(400).json({ error: 'Order ID and PayPal Order ID required' });
    }
    
    // Check if it's a simulation
    const paymentCheck = await pool.query(`
      SELECT * FROM payments 
      WHERE transaction_id = $1 AND customer_id = $2
    `, [paypalOrderId, req.userId]);
    
    if (paymentCheck.rows.length > 0 && paymentCheck.rows[0].payment_details?.isSimulation) {
      await pool.query(
        `UPDATE payments SET status = 'success' WHERE id = $1`,
        [paymentCheck.rows[0].id]
      );
      return res.json({ success: true, message: 'Simulation payment captured' });
    }
    
    // Capture actual PayPal order
    const result = await capturePaypalOrder(paypalOrderId);
    
    if (result.success) {
      // Update payment record
      await pool.query(`
        UPDATE payments 
        SET status = 'success',
            payment_details = payment_details || $1
        WHERE transaction_id = $2
      `, [
        JSON.stringify({ captureResult: result.data }),
        paypalOrderId
      ]);
      
      // Update order status
      const orderResult = await pool.query(
        `SELECT id FROM orders WHERE id = $1`,
        [orderId]
      );
      
      if (orderResult.rows.length > 0) {
        await pool.query(`
          UPDATE orders 
          SET payment_status = 'paid', 
              status = 'pending',
              updated_at = NOW()
          WHERE id = $1 AND status = 'pending_payment'
        `, [orderId]);
        
        await appendOrderStatus(orderId, 'pending', 'PayPal payment successful. Order confirmed.');
        
        try {
          const orderWithCustomer = await pool.query(`
            SELECT o.*, c.name AS customer_name, c.email AS customer_email
            FROM orders o
            JOIN customers c ON o.customer_id = c.id
            WHERE o.id = $1
          `, [orderId]);
          
          if (orderWithCustomer.rows.length > 0) {
            const order = orderWithCustomer.rows[0];
            const itemsResult = await pool.query(
              'SELECT * FROM order_items WHERE order_id = $1',
              [orderId]
            );
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
        message: result.message || 'Payment capture failed'
      });
    }
    
  } catch (error) {
    console.error('❌ PayPal capture error:', error);
    res.status(500).json({ error: 'Failed to capture payment: ' + error.message });
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

    // If no order ID provided, create a new order
    let actualOrderId = orderId;
    let orderRef = `ORD-${Date.now()}`;

    if (!orderId) {
      const orderResult = await pool.query(`
        INSERT INTO orders (
          customer_id, total, status, order_ref, status_history, payment_status
        )
        VALUES ($1, $2, 'pending_payment', $3, $4, 'pending')
        RETURNING *
      `, [
        customerId,
        amount,
        orderRef,
        JSON.stringify([{ status: 'pending_payment', timestamp: new Date().toISOString() }])
      ]);
      actualOrderId = orderResult.rows[0].id;
      orderRef = orderResult.rows[0].order_ref;
    } else {
      const orderResult = await pool.query(
        'SELECT order_ref FROM orders WHERE id = $1',
        [orderId]
      );
      if (orderResult.rows.length > 0) {
        orderRef = orderResult.rows[0].order_ref;
      }
    }

    // Initiate Airtel payment
    const airtelResult = await initiateAirtelPayment(phone, amount, orderRef);

    if (airtelResult.success) {
      const paymentResult = await pool.query(`
        INSERT INTO payments (
          customer_id, order_id, amount, method, status, transaction_id, payment_details
        )
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
          initiatedAt: new Date().toISOString()
        })
      ]);

      res.json({
        success: true,
        message: airtelResult.message || 'Airtel Money payment initiated.',
        transactionId: airtelResult.transactionId,
        orderId: actualOrderId,
        paymentId: paymentResult.rows[0].id,
        isSimulation: airtelResult.isSimulation || false
      });
    } else {
      res.status(400).json({
        success: false,
        message: airtelResult.message || 'Airtel Money payment failed. Please try again.',
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
    const orderRef = body.reference || body.accountReference || body.external_id || body.order_ref;

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

    // Find order by reference
    const orderResult = await pool.query(
      'SELECT id, customer_id FROM orders WHERE order_ref = $1',
      [orderRef]
    );

    if (orderResult.rows.length === 0) {
      console.error('❌ Order not found for reference:', orderRef);
      return res.json({ status: 'success', message: 'Callback received' });
    }

    const orderId = orderResult.rows[0].id;

    // Update payment record
    await pool.query(`
      UPDATE payments 
      SET status = $1, 
          transaction_id = COALESCE($2, transaction_id),
          payment_details = payment_details || $3
      WHERE order_id = $4 AND method = 'airtel'
    `, [
      isSuccess ? 'success' : 'failed',
      transactionId || null,
      JSON.stringify({ 
        callbackReceivedAt: new Date().toISOString(),
        callback: body
      }),
      orderId
    ]);

    if (isSuccess) {
      console.log(`✅ Updating order ${orderId} status to pending (Airtel)`);
      
      await pool.query(`
        UPDATE orders 
        SET payment_status = 'paid', 
            status = 'pending',
            updated_at = NOW()
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
          const itemsResult = await pool.query(
            'SELECT * FROM order_items WHERE order_id = $1',
            [orderId]
          );
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
        transactionId
      });
    }

    res.json({ status: 'success', message: 'Callback processed successfully' });

  } catch (error) {
    console.error('❌ Airtel callback error:', error);
    res.status(200).json({ status: 'success', message: 'Callback received' });
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
    const result = await pool.query(`
      SELECT p.*, o.order_ref
      FROM payments p
      LEFT JOIN orders o ON p.order_id = o.id
      WHERE p.customer_id = $1
      ORDER BY p.created_at DESC
    `, [req.userId]);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;