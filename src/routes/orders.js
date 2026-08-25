const express = require('express');
const { body, validationResult } = require('express-validator');
const { pool } = require('../config/database');
const { authMiddleware } = require('../middleware/auth');
const { sensitiveLimiter } = require('../middleware/rateLimiter');
const { generateOrderRef, calculateShippingCost } = require('../utils/helpers');
const { sendEmail, orderConfirmationEmail, statusUpdateEmail, receivedEmail } = require('../services/email');
const { 
  appendOrderStatus, 
  decrementStockAtomic, 
  restockOrder, 
  getSystemSetting, 
  logAdminActivity 
} = require('../services/orderService');
const router = express.Router();

// ============================================================
//  CREATE ORDER
// ============================================================

router.post('/', authMiddleware, sensitiveLimiter, [
  body('items').isArray().withMessage('Items must be array'),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  if (req.role !== 'customer') {
    return res.status(403).json({ error: 'Only customers can place orders.' });
  }

  const customerId = req.userId;
  const {
    items, shipping_tier, order_notes,
    promo_code,
    delivery_address, recipient_name, recipient_phone,
    delivery_instructions, customer_lat, customer_lng, location_accuracy
  } = req.body;

  try {
    console.log('📦 ORDER CREATION STARTED');
    console.log('📦 User:', customerId);
    console.log('📦 Items:', items.length);

    let subtotal = 0;
    
    for (const item of items) {
      const priceNum = parseFloat(item.price.replace(/[^0-9.]/g,'')) || 0;
      subtotal += priceNum * item.quantity;
      
      if (item.variant_id) {
        const stockResult = await pool.query(
          'SELECT stock FROM product_variants WHERE id = $1',
          [item.variant_id]
        );
        if (stockResult.rows.length === 0) {
          return res.status(400).json({ error: `Product variant not found: ${item.name}` });
        }
        if (stockResult.rows[0].stock < item.quantity) {
          return res.status(400).json({ 
            error: `Insufficient stock for ${item.name} (${item.variant_name || 'Default'}). Available: ${stockResult.rows[0].stock}`
          });
        }
      } else {
        const stockResult = await pool.query(
          'SELECT stock FROM products WHERE id = $1',
          [item.productId]
        );
        if (stockResult.rows.length === 0) {
          return res.status(400).json({ error: `Product not found: ${item.name}` });
        }
        if (stockResult.rows[0].stock < item.quantity) {
          return res.status(400).json({ 
            error: `Insufficient stock for ${item.name}. Available: ${stockResult.rows[0].stock}`
          });
        }
      }
    }

    const tier = shipping_tier || 'standard';
    const shippingCost = calculateShippingCost(subtotal, tier);

    let discount = 0;
    if (promo_code) {
      const promoResult = await pool.query(
        'SELECT * FROM promo_codes WHERE code = $1 AND active = true AND (expires_at IS NULL OR expires_at > NOW()) AND (usage_limit IS NULL OR used_count < usage_limit)',
        [promo_code.toUpperCase()]
      );
      if (promoResult.rows.length > 0) {
        const promo = promoResult.rows[0];
        if (subtotal >= promo.min_order_value) {
          if (promo.discount_type === 'percentage') {
            discount = subtotal * promo.discount_value / 100;
          } else {
            discount = promo.discount_value;
          }
          discount = Math.min(discount, subtotal);
          await pool.query('UPDATE promo_codes SET used_count = used_count + 1 WHERE id = $1', [promo.id]);
        }
      }
    }

    const total = subtotal + shippingCost - discount;

    let orderRef;
    let unique = false;
    while (!unique) {
      orderRef = generateOrderRef();
      const check = await pool.query('SELECT id FROM orders WHERE order_ref = $1', [orderRef]);
      if (check.rows.length === 0) unique = true;
    }

    const urgent = tier === 'overnight';

    await pool.query('BEGIN');
    
    const orderResult = await pool.query(`
      INSERT INTO orders (
        customer_id, total, status, order_ref, status_history,
        shipping_tier, shipping_cost, order_notes, promo_code, discount_applied,
        delivery_address, recipient_name, recipient_phone, delivery_instructions,
        customer_lat, customer_lng, location_accuracy, location_detected_at,
        urgent_delivery, payment_status
      )
      VALUES ($1, $2, 'pending_payment', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, NOW(), $17, 'pending')
      RETURNING *
    `, [
      customerId, total, orderRef,
      JSON.stringify([{ status: 'pending_payment', timestamp: new Date().toISOString() }]),
      tier, shippingCost,
      order_notes || null, promo_code || null, discount,
      delivery_address || null, recipient_name || null, recipient_phone || null,
      delivery_instructions || null, customer_lat || null, customer_lng || null,
      location_accuracy || null, urgent
    ]);

    const order = orderResult.rows[0];
    console.log('📦 Order created:', order.id);

    for (const item of items) {
      const uniqueId = generateOrderRef();
      await pool.query(`
        INSERT INTO order_items (order_id, product_id, product_name, price, quantity, image, unique_id, variant_name, variant_id)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      `, [order.id, item.productId || 0, item.name, item.price, item.quantity, item.image || '',
          uniqueId, item.variant_name || 'Default', item.variant_id || null]);

      if (item.variant_id) {
        await decrementStockAtomic(item.productId, item.quantity, item.variant_id);
      } else {
        await decrementStockAtomic(item.productId, item.quantity);
      }
    }

    await pool.query('UPDATE carts SET items = $1, reserved_until = NULL WHERE customer_id = $2', ['[]', customerId]);

    await pool.query('COMMIT');

    const io = req.app.get('io');
    io.emit('new-order', { orderId: order.id });

    try {
      const customerResult = await pool.query('SELECT name, email FROM customers WHERE id = $1', [customerId]);
      if (customerResult.rows.length > 0) {
        const orderWithItems = { ...order, items };
        const mailData = orderConfirmationEmail(orderWithItems, customerResult.rows[0].name);
        await sendEmail({
          to: customerResult.rows[0].email,
          ...mailData
        });
        console.log('📧 Order confirmation email sent to:', customerResult.rows[0].email);
      }
    } catch (emailErr) {
      console.error('⚠️ Email send failed:', emailErr.message);
    }

    res.status(201).json({ success: true, order, requiresPayment: true });

  } catch (err) {
    await pool.query('ROLLBACK');
    console.error('❌ Order creation error:', err);
    res.status(500).json({ 
      error: err.message || 'Order creation failed',
      details: process.env.NODE_ENV === 'development' ? err.stack : undefined
    });
  }
});

// ============================================================
//  GET ORDERS
// ============================================================

router.get('/', authMiddleware, async (req, res) => {
  try {
    const { status, search, startDate, endDate, limit = 50, page = 1 } = req.query;
    const offset = (page - 1) * limit;
    
    let query = `
      SELECT o.*, c.name AS customer_name, c.email AS customer_email,
      (SELECT json_agg(oi.*) FROM order_items oi WHERE oi.order_id = o.id) as items
      FROM orders o
      JOIN customers c ON o.customer_id = c.id
    `;
    const params = [];
    const conditions = [];
    
    if (req.role === 'customer') {
      conditions.push('o.customer_id = $' + (params.length + 1));
      params.push(req.userId);
    }
    
    if (req.role === 'admin') {
      if (status && status !== 'all') {
        conditions.push('o.status = $' + (params.length + 1));
        params.push(status);
      }
      if (search) {
        conditions.push('(c.name ILIKE $' + (params.length + 1) + ' OR c.email ILIKE $' + (params.length + 1) + ' OR o.order_ref ILIKE $' + (params.length + 1) + ')');
        params.push(`%${search}%`);
      }
      if (startDate) {
        conditions.push('o.created_at >= $' + (params.length + 1));
        params.push(startDate);
      }
      if (endDate) {
        conditions.push('o.created_at <= $' + (params.length + 1));
        params.push(endDate + ' 23:59:59');
      }
    }
    
    if (conditions.length > 0) {
      query += ' WHERE ' + conditions.join(' AND ');
    }
    
    query += ' ORDER BY o.created_at DESC';
    query += ' LIMIT $' + (params.length + 1) + ' OFFSET $' + (params.length + 2);
    params.push(parseInt(limit), parseInt(offset));
    
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
//  GET ORDER BY ID
// ============================================================

router.get('/:id', authMiddleware, async (req, res) => {
  const orderId = parseInt(req.params.id);
  try {
    const result = await pool.query(`
      SELECT o.*, c.name AS customer_name, c.email AS customer_email
      FROM orders o
      JOIN customers c ON o.customer_id = c.id
      WHERE o.id = $1
    `, [orderId]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Order not found' });
    const order = result.rows[0];
    if (req.role !== 'admin' && order.customer_id !== req.userId) return res.status(403).json({ error: 'Forbidden' });
    const itemsResult = await pool.query('SELECT * FROM order_items WHERE order_id = $1', [orderId]);
    res.json({ ...order, items: itemsResult.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
//  GET ORDER TRACKING
// ============================================================

router.get('/:id/tracking', authMiddleware, async (req, res) => {
  const orderId = parseInt(req.params.id);
  try {
    const orderResult = await pool.query(`
      SELECT o.*, c.name AS customer_name, c.email AS customer_email
      FROM orders o
      JOIN customers c ON o.customer_id = c.id
      WHERE o.id = $1
    `, [orderId]);
    if (orderResult.rows.length === 0) return res.status(404).json({ error: 'Order not found' });
    const order = orderResult.rows[0];
    if (req.role !== 'admin' && order.customer_id !== req.userId) return res.status(403).json({ error: 'Forbidden' });
    const itemsResult = await pool.query('SELECT * FROM order_items WHERE order_id = $1', [orderId]);
    order.items = itemsResult.rows;
    let statusMessage = '';
    switch (order.status) {
      case 'pending_payment': statusMessage = '⏳ Awaiting payment confirmation.'; break;
      case 'pending': statusMessage = '📋 Your order is being reviewed.'; break;
      case 'confirmed': statusMessage = '✅ Your order is confirmed and being prepared.'; break;
      case 'shipped': statusMessage = '🚚 Your order is on the way.'; break;
      case 'delivered': statusMessage = '📦 Please collect within 7 working days.'; break;
      case 'received': statusMessage = '✔️ You have confirmed receipt. Thank you!'; break;
      case 'cancelled': statusMessage = '❌ This order has been cancelled.'; break;
      case 'completed': statusMessage = '✅ Order completed. Thank you for shopping!'; break;
      default: statusMessage = 'Status unknown.';
    }
    res.json({ ...order, statusMessage });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
//  CANCEL ORDER
// ============================================================

router.put('/:id/cancel', authMiddleware, [
  body('reason').notEmpty().withMessage('Cancellation reason required')
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  const orderId = parseInt(req.params.id);
  const { reason } = req.body;
  try {
    const orderResult = await pool.query('SELECT customer_id, status, order_ref, created_at FROM orders WHERE id = $1', [orderId]);
    if (orderResult.rows.length === 0) return res.status(404).json({ error: 'Order not found' });
    const order = orderResult.rows[0];
    if (req.role !== 'admin' && order.customer_id !== req.userId) return res.status(403).json({ error: 'Forbidden' });
    if (req.role !== 'admin') {
      const hoursSinceOrder = (Date.now() - new Date(order.created_at).getTime()) / (1000 * 60 * 60);
      const maxHours = parseInt(await getSystemSetting('replacement_hours', '6'));
      if (hoursSinceOrder > maxHours) {
        return res.status(400).json({ error: `Cancellation only allowed within ${maxHours} hours of order placement.` });
      }
    }
    if (!['pending', 'confirmed', 'pending_payment'].includes(order.status)) {
      return res.status(400).json({ error: 'This order cannot be cancelled.' });
    }
    
    await restockOrder(orderId);
    
    await pool.query(
      `UPDATE orders SET status = 'cancelled', cancelled_at = NOW(), cancelled_by = $1, updated_at = NOW() WHERE id = $2`,
      [req.role === 'admin' ? 'admin' : 'customer', orderId]
    );
    await appendOrderStatus(orderId, 'cancelled', `Cancelled by ${req.role === 'admin' ? 'admin' : 'customer'}. Reason: ${reason}`);
    const ref = order.order_ref || `#${orderId}`;
    const msg = `❌ Order ${ref} has been cancelled. Reason: ${reason}`;
    await pool.query('INSERT INTO order_chat_messages (order_id, from_user, message) VALUES ($1, $2, $3)', [orderId, 'System', msg]);
    
    const io = req.app.get('io');
    io.to(`order_${orderId}`).emit('new-order-chat-message', { order_id: orderId, from_user: 'System', message: msg, timestamp: new Date() });
    res.json({ success: true, message: 'Order cancelled.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
//  REFUND ORDER
// ============================================================

router.put('/:id/refund', authMiddleware, [
  body('reason').notEmpty().withMessage('Refund reason required')
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  if (req.role !== 'customer') return res.status(403).json({ error: 'Customer only.' });
  const orderId = parseInt(req.params.id);
  const { reason } = req.body;
  try {
    const orderCheck = await pool.query('SELECT customer_id, status FROM orders WHERE id = $1', [orderId]);
    if (orderCheck.rows.length === 0) return res.status(404).json({ error: 'Order not found' });
    if (orderCheck.rows[0].customer_id !== req.userId) return res.status(403).json({ error: 'Forbidden' });
    if (orderCheck.rows[0].status === 'cancelled' || orderCheck.rows[0].status === 'received' || orderCheck.rows[0].status === 'completed') {
      return res.status(400).json({ error: 'This order cannot be refunded.' });
    }
    await pool.query(`UPDATE orders SET refund_request = $1, refund_status = 'pending' WHERE id = $2`, [reason, orderId]);
    const msg = `💰 Refund requested for order #${orderId}. Reason: ${reason}`;
    await pool.query('INSERT INTO order_chat_messages (order_id, from_user, message) VALUES ($1, $2, $3)', [orderId, 'System', msg]);
    
    const io = req.app.get('io');
    io.to(`order_${orderId}`).emit('new-order-chat-message', { order_id: orderId, from_user: 'System', message: msg, timestamp: new Date() });
    res.json({ success: true, message: 'Refund request submitted.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
//  RECEIVE ORDER
// ============================================================

router.put('/:id/receive', authMiddleware, async (req, res) => {
  if (req.role !== 'customer') return res.status(403).json({ error: 'Customer only.' });
  const orderId = parseInt(req.params.id);
  try {
    const orderResult = await pool.query('SELECT customer_id, status, order_ref FROM orders WHERE id = $1', [orderId]);
    if (orderResult.rows.length === 0) return res.status(404).json({ error: 'Order not found' });
    const order = orderResult.rows[0];
    if (order.customer_id !== req.userId) return res.status(403).json({ error: 'Not your order.' });
    if (order.status !== 'delivered') {
      return res.status(400).json({ error: 'Order must be delivered before you can mark it as received.' });
    }
    await pool.query(`UPDATE orders SET status = 'received', received_at = NOW(), updated_at = NOW() WHERE id = $1`, [orderId]);
    await appendOrderStatus(orderId, 'received');
    const ref = order.order_ref || `#${orderId}`;
    const msg = `✅ Order ${ref} has been received by the customer.`;
    await pool.query('INSERT INTO order_chat_messages (order_id, from_user, message) VALUES ($1, $2, $3)',
      [orderId, 'Customer', msg]);
    
    const io = req.app.get('io');
    io.to(`order_${orderId}`).emit('new-order-chat-message', { order_id: orderId, from_user: 'Customer', message: msg, timestamp: new Date() });
    
    const customerResult = await pool.query('SELECT name, email FROM customers WHERE id = $1', [req.userId]);
    const customer = customerResult.rows[0];
    if (customer && customer.email) {
      try {
        const mailData = receivedEmail({ ...order, status: 'received' }, customer.name);
        await sendEmail({ to: customer.email, ...mailData });
      } catch (emailErr) {
        console.error('⚠️ Email send failed:', emailErr.message);
      }
    }
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
//  REORDER
// ============================================================

router.post('/:id/reorder', authMiddleware, async (req, res) => {
  const orderId = parseInt(req.params.id);
  try {
    const orderResult = await pool.query('SELECT customer_id FROM orders WHERE id = $1', [orderId]);
    if (orderResult.rows.length === 0) return res.status(404).json({ error: 'Order not found' });
    const order = orderResult.rows[0];
    if (order.customer_id !== req.userId) return res.status(403).json({ error: 'Forbidden' });
    const itemsResult = await pool.query(
      'SELECT product_id, product_name, price, image, variant_name, variant_id FROM order_items WHERE order_id = $1',
      [orderId]
    );
    if (itemsResult.rows.length === 0) return res.status(400).json({ error: 'No items to reorder.' });
    const cartItems = itemsResult.rows.map(item => ({
      id: item.product_id,
      name: item.product_name,
      price: item.price,
      image: item.image || '',
      quantity: 1,
      variant_name: item.variant_name || 'Default',
      variant_id: item.variant_id || null
    }));
    await pool.query('UPDATE carts SET items = $1, updated_at = NOW() WHERE customer_id = $2',
      [JSON.stringify(cartItems), req.userId]);
    res.json({ success: true, items: cartItems });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
//  CONFIRM ORDER (Admin)
// ============================================================

router.put('/:id/confirm', authMiddleware, async (req, res) => {
  if (req.role !== 'admin') return res.status(403).json({ error: 'Admin only.' });
  const orderId = parseInt(req.params.id);
  try {
    const orderResult = await pool.query(`
      SELECT o.*, c.name AS customer_name, c.email AS customer_email
      FROM orders o
      JOIN customers c ON o.customer_id = c.id
      WHERE o.id = $1
    `, [orderId]);
    if (orderResult.rows.length === 0) return res.status(404).json({ error: 'Order not found' });
    const order = orderResult.rows[0];
    if (order.status !== 'pending') {
      return res.status(400).json({ error: `Order already processed (status: ${order.status})` });
    }
    await pool.query(`UPDATE orders SET status = 'confirmed', updated_at = NOW() WHERE id = $1`, [orderId]);
    await appendOrderStatus(orderId, 'confirmed');
    await logAdminActivity(req.userId, 'CONFIRM_ORDER', { orderId });

    const itemsResult = await pool.query('SELECT * FROM order_items WHERE order_id = $1', [orderId]);
    const items = itemsResult.rows;

    const ref = order.order_ref || `#${order.id}`;
    let message = `✅ **Order ${ref} Confirmed!**\n\n`;
    message += `Dear ${order.customer_name},\n\n`;
    message += `Your order has been confirmed. Here are the details:\n\n`;
    message += `📦 **Order Items:**\n`;
    let total = 0;
    items.forEach((item, index) => {
      const priceNum = parseFloat(item.price.replace(/[^0-9.]/g, '')) || 0;
      const subtotal = priceNum * item.quantity;
      total += subtotal;
      const variant = item.variant_name || 'Default';
      const uniqueId = item.unique_id || '—';
      message += `${index+1}. ${item.product_name} (${variant}) x${item.quantity} – Ksh ${subtotal.toFixed(2)} (ID: ${uniqueId})\n`;
    });
    message += `\n💰 **Total:** Ksh ${Number(order.total).toFixed(2)}\n\n`;
    message += `📍 **Delivery Location:**\n`;
    message += `   ${order.delivery_address || 'Not provided'}\n`;
    if (order.recipient_name) message += `   👤 Recipient: ${order.recipient_name} (${order.recipient_phone || 'N/A'})\n`;
    if (order.delivery_instructions) message += `   📝 Instructions: ${order.delivery_instructions}\n`;
    if (order.customer_lat && order.customer_lng) {
      message += `   🗺️ GPS: ${order.customer_lat}, ${order.customer_lng}\n`;
    }
    message += `\n📅 Order Date: ${new Date(order.created_at).toLocaleString()}\n`;
    message += `🆔 Reference: ${ref}\n\n`;
    message += `Thank you for shopping with us! 🙏`;

    await pool.query('INSERT INTO order_chat_messages (order_id, from_user, message) VALUES ($1, $2, $3)',
      [orderId, 'Seller', message]);
    
    const io = req.app.get('io');
    io.to(`order_${orderId}`).emit('new-order-chat-message', { order_id: orderId, from_user: 'Seller', message: message, timestamp: new Date() });

    if (order.customer_email) {
      try {
        const mailData = orderConfirmationEmail(order, order.customer_name);
        await sendEmail({ to: order.customer_email, ...mailData });
      } catch (emailErr) {
        console.error('⚠️ Email send failed:', emailErr.message);
      }
    }
    res.json({ success: true, message: '✅ Order confirmed.' });
  } catch (err) {
    console.error('Confirm error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
//  UPDATE ORDER STATUS (Admin)
// ============================================================

router.put('/:id/status', authMiddleware, async (req, res) => {
  if (req.role !== 'admin') return res.status(403).json({ error: 'Admin only.' });
  const orderId = parseInt(req.params.id);
  const { status, tracking_number } = req.body;
  try {
    const current = await pool.query('SELECT status, customer_id, order_ref FROM orders WHERE id = $1', [orderId]);
    if (current.rows.length === 0) return res.status(404).json({ error: 'Order not found' });
    const currentStatus = current.rows[0].status;
    if (currentStatus === 'pending') return res.status(400).json({ error: 'Order must be confirmed first.' });
    if (currentStatus === 'received' || currentStatus === 'cancelled' || currentStatus === 'completed') {
      return res.status(400).json({ error: 'Order already processed.' });
    }
    const updates = { status };
    if (status === 'shipped') {
      updates.shipped_at = new Date();
      if (tracking_number) updates.tracking_number = tracking_number;
    } else if (status === 'delivered') {
      updates.delivered_at = new Date();
    }
    await pool.query(
      `UPDATE orders SET status = $1, shipped_at = $2, delivered_at = $3, tracking_number = $4, updated_at = NOW() WHERE id = $5`,
      [updates.status, updates.shipped_at || null, updates.delivered_at || null, updates.tracking_number || null, orderId]
    );
    await appendOrderStatus(orderId, status);
    await logAdminActivity(req.userId, `UPDATE_ORDER_TO_${status.toUpperCase()}`, { orderId });

    const orderRef = current.rows[0].order_ref || `#${orderId}`;
    const msg = `📦 Order ${orderRef} status updated to: ${status.toUpperCase()}`;
    await pool.query('INSERT INTO order_chat_messages (order_id, from_user, message) VALUES ($1, $2, $3)',
      [orderId, 'Seller', msg]);
    
    const io = req.app.get('io');
    io.to(`order_${orderId}`).emit('new-order-chat-message', { order_id: orderId, from_user: 'Seller', message: msg, timestamp: new Date() });

    const customerResult = await pool.query('SELECT name, email FROM customers WHERE id = $1', [current.rows[0].customer_id]);
    const customer = customerResult.rows[0];
    if (customer && customer.email) {
      try {
        const mailData = statusUpdateEmail({ ...current.rows[0], status, tracking_number }, status, customer.name);
        await sendEmail({ to: customer.email, ...mailData });
        console.log('📧 Status update email sent to:', customer.email);
      } catch (emailErr) {
        console.error('⚠️ Email send failed:', emailErr.message);
      }
    }
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
//  SEND CONFIRMATION (Admin)
// ============================================================

router.post('/:id/send-confirmation', authMiddleware, async (req, res) => {
  if (req.role !== 'admin') return res.status(403).json({ error: 'Admin only.' });

  const orderId = parseInt(req.params.id);

  try {
    const orderResult = await pool.query(`
      SELECT o.*, c.name AS customer_name, c.email AS customer_email
      FROM orders o
      JOIN customers c ON o.customer_id = c.id
      WHERE o.id = $1
    `, [orderId]);

    if (orderResult.rows.length === 0) {
      return res.status(404).json({ error: 'Order not found' });
    }

    const order = orderResult.rows[0];
    const itemsResult = await pool.query('SELECT * FROM order_items WHERE order_id = $1', [orderId]);
    const items = itemsResult.rows;

    const ref = order.order_ref || `#${order.id}`;
    let message = `✅ **Order ${ref} Confirmed!**\n\n`;
    message += `Dear ${order.customer_name},\n\n`;
    message += `Your order has been confirmed. Here are the details:\n\n`;
    message += `📦 **Order Items:**\n`;
    let total = 0;
    items.forEach((item, index) => {
      const priceNum = parseFloat(item.price.replace(/[^0-9.]/g, '')) || 0;
      const subtotal = priceNum * item.quantity;
      total += subtotal;
      const variant = item.variant_name || 'Default';
      const uniqueId = item.unique_id || '—';
      message += `${index+1}. ${item.product_name} (${variant}) x${item.quantity} – Ksh ${subtotal.toFixed(2)} (ID: ${uniqueId})\n`;
    });
    message += `\n💰 **Total:** Ksh ${Number(order.total).toFixed(2)}\n\n`;
    message += `📍 **Delivery Location:**\n`;
    message += `   ${order.delivery_address || 'Not provided'}\n`;
    if (order.recipient_name) message += `   👤 Recipient: ${order.recipient_name} (${order.recipient_phone || 'N/A'})\n`;
    if (order.delivery_instructions) message += `   📝 Instructions: ${order.delivery_instructions}\n`;
    if (order.customer_lat && order.customer_lng) {
      message += `   🗺️ GPS: ${order.customer_lat}, ${order.customer_lng}\n`;
    }
    message += `\n📅 Order Date: ${new Date(order.created_at).toLocaleString()}\n`;
    message += `🆔 Reference: ${ref}\n\n`;
    message += `Thank you for shopping with us! 🙏`;

    await pool.query(
      'INSERT INTO order_chat_messages (order_id, from_user, message) VALUES ($1, $2, $3)',
      [orderId, 'Seller', message]
    );

    const io = req.app.get('io');
    io.to(`order_${orderId}`).emit('new-order-chat-message', {
      order_id: orderId,
      from_user: 'Seller',
      message: message,
      timestamp: new Date()
    });

    res.json({ success: true, message: '✅ Confirmation sent to customer.' });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
//  ORDER CHAT
// ============================================================

router.get('/:id/chat', authMiddleware, async (req, res) => {
  const orderId = parseInt(req.params.id);
  try {
    const orderResult = await pool.query('SELECT customer_id FROM orders WHERE id = $1', [orderId]);
    if (orderResult.rows.length === 0) return res.status(404).json({ error: 'Order not found' });
    const order = orderResult.rows[0];
    if (req.role !== 'admin' && order.customer_id !== req.userId) return res.status(403).json({ error: 'Forbidden' });
    const result = await pool.query('SELECT * FROM order_chat_messages WHERE order_id = $1 ORDER BY timestamp ASC', [orderId]);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

router.post('/:id/chat', authMiddleware, async (req, res) => {
  const orderId = parseInt(req.params.id);
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: 'Message is required.' });
  try {
    const orderResult = await pool.query('SELECT customer_id FROM orders WHERE id = $1', [orderId]);
    if (orderResult.rows.length === 0) return res.status(404).json({ error: 'Order not found' });
    const order = orderResult.rows[0];
    const from = (req.role === 'admin') ? 'Seller' : 'Customer';
    if (req.role !== 'admin' && order.customer_id !== req.userId) return res.status(403).json({ error: 'Forbidden' });
    const result = await pool.query(
      'INSERT INTO order_chat_messages (order_id, from_user, message) VALUES ($1, $2, $3) RETURNING *',
      [orderId, from, message]
    );
    const io = req.app.get('io');
    io.to(`order_${orderId}`).emit('new-order-chat-message', result.rows[0]);
    res.json({ success: true, msg: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
//  REPLACE SIMPLE
// ============================================================

router.put('/:id/replace-simple', authMiddleware, async (req, res) => {
  if (req.role !== 'customer') {
    return res.status(403).json({ error: 'Customer only.' });
  }
  
  const orderId = parseInt(req.params.id);
  const { oldProductIds, newProductIds } = req.body;
  
  try {
    const orderCheck = await pool.query(
      `SELECT customer_id, status, created_at FROM orders WHERE id = $1`,
      [orderId]
    );
    if (orderCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Order not found' });
    }
    const order = orderCheck.rows[0];
    if (order.customer_id !== req.userId) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    
    const hoursSinceOrder = (Date.now() - new Date(order.created_at).getTime()) / (1000 * 60 * 60);
    const maxHours = parseInt(await getSystemSetting('replacement_hours', '6'));
    if (hoursSinceOrder > maxHours) {
      return res.status(400).json({ error: `Replacement only allowed within ${maxHours} hours of order placement.` });
    }
    
    const oldItemsResult = await pool.query(
      `SELECT product_id, product_name, price, quantity 
       FROM order_items 
       WHERE order_id = $1 AND product_id = ANY($2::int[])`,
      [orderId, oldProductIds]
    );
    
    if (oldItemsResult.rows.length === 0) {
      return res.status(400).json({ error: 'No matching items found in order.' });
    }
    
    let oldTotal = 0;
    oldItemsResult.rows.forEach(item => {
      const priceNum = parseFloat(item.price.replace(/[^0-9.]/g,'')) || 0;
      oldTotal += priceNum * item.quantity;
    });
    
    const newProductsResult = await pool.query(
      `SELECT id, name, price FROM products WHERE id = ANY($1::int[])`,
      [newProductIds]
    );
    
    if (newProductsResult.rows.length === 0) {
      return res.status(400).json({ error: 'No valid replacement products found.' });
    }
    
    let newTotal = 0;
    newProductsResult.rows.forEach(item => {
      const priceNum = parseFloat(item.price.replace(/[^0-9.]/g,'')) || 0;
      newTotal += priceNum;
    });
    
    const diff = newTotal - oldTotal;
    
    let replacementStatus = 'pending';
    let paymentStatus = 'none';
    let refundStatus = 'none';
    
    if (diff === 0) {
      replacementStatus = 'approved';
      paymentStatus = 'approved';
      refundStatus = 'approved';
    } else if (diff > 0) {
      paymentStatus = 'pending';
    } else {
      refundStatus = 'pending';
    }
    
    const replacementData = {
      old_items: oldItemsResult.rows,
      new_items: newProductsResult.rows,
      old_total: oldTotal,
      new_total: newTotal,
      diff: diff,
      status: replacementStatus
    };
    
    await pool.query(
      `UPDATE orders 
       SET replacement_request = $1, 
           replacement_status = $2, 
           replacement_diff = $3,
           replacement_payment_status = $4, 
           replacement_refund_status = $5 
       WHERE id = $6`,
      [JSON.stringify(replacementData), replacementStatus, diff, paymentStatus, refundStatus, orderId]
    );
    
    let msg = `🔄 Replacement request submitted: ${oldItemsResult.rows.map(i => i.product_name).join(', ')} → ${newProductsResult.rows.map(i => i.name).join(', ')}. `;
    
    if (diff === 0) {
      msg += `✅ Prices are equal. Replacement auto-approved!`;
      await pool.query(
        `UPDATE orders SET replacement_status = 'approved' WHERE id = $1`,
        [orderId]
      );
    } else if (diff > 0) {
      msg += `You need to pay Ksh ${diff.toFixed(2)} extra.`;
    } else {
      msg += `You will get a refund of Ksh ${Math.abs(diff).toFixed(2)}.`;
    }
    
    await pool.query(
      `INSERT INTO order_chat_messages (order_id, from_user, message) VALUES ($1, 'System', $2)`,
      [orderId, msg]
    );
    
    const io = req.app.get('io');
    io.to(`order_${orderId}`).emit('new-order-chat-message', {
      order_id: orderId,
      from_user: 'System',
      message: msg,
      timestamp: new Date()
    });
    
    res.json({
      success: true,
      replacement: replacementData,
      diff,
      status: replacementStatus,
      payment_status: paymentStatus,
      refund_status: refundStatus
    });
    
  } catch (err) {
    console.error('❌ Replacement error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
//  REPLACEMENT PAYMENT
// ============================================================

router.post('/:id/replacement-payment', authMiddleware, async (req, res) => {
  if (req.role !== 'customer') return res.status(403).json({ error: 'Customer only.' });
  const orderId = parseInt(req.params.id);
  const { payment_method, payment_details } = req.body;
  try {
    const orderCheck = await pool.query('SELECT replacement_payment_status, replacement_diff FROM orders WHERE id = $1', [orderId]);
    if (orderCheck.rows.length === 0) return res.status(404).json({ error: 'Order not found' });
    const order = orderCheck.rows[0];
    if (order.replacement_payment_status !== 'pending') {
      return res.status(400).json({ error: 'No pending payment.' });
    }
    const amount = order.replacement_diff;
    const method = payment_method;
    const details = payment_details || {};
    const transactionId = require('uuid').v4();

    await pool.query(
      `INSERT INTO payments (customer_id, order_id, amount, method, status, transaction_id, payment_details)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [req.userId, orderId, amount, method, 'success', transactionId, JSON.stringify(details)]
    );

    await pool.query(
      `UPDATE orders SET replacement_payment_status = 'paid', replacement_payment_method = $1, replacement_payment_details = $2, replacement_payment_date = NOW() WHERE id = $3`,
      [method, JSON.stringify(details || {}), orderId]
    );
    await pool.query(`UPDATE orders SET replacement_status = 'approved' WHERE id = $1`, [orderId]);
    const msg = `✅ Replacement payment received via ${method}. Replacement approved.`;
    await pool.query('INSERT INTO order_chat_messages (order_id, from_user, message) VALUES ($1, $2, $3)', [orderId, 'System', msg]);
    
    const io = req.app.get('io');
    io.to(`order_${orderId}`).emit('new-order-chat-message', { order_id: orderId, from_user: 'System', message: msg, timestamp: new Date() });
    res.json({ success: true, message: 'Payment recorded. Replacement approved.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
//  RETURN REQUEST
// ============================================================

router.post('/:id/return', authMiddleware, [
  body('product_id').isInt().withMessage('Product ID required'),
  body('reason').notEmpty().withMessage('Return reason required')
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  if (req.role !== 'customer') return res.status(403).json({ error: 'Customer only.' });
  const orderId = parseInt(req.params.id);
  const { product_id, reason, photos } = req.body;
  try {
    const productCheck = await pool.query('SELECT return_enabled FROM products WHERE id = $1', [product_id]);
    if (productCheck.rows.length === 0) return res.status(404).json({ error: 'Product not found.' });
    if (!productCheck.rows[0].return_enabled) {
      return res.status(400).json({ error: 'This product is non-returnable.' });
    }
    const orderCheck = await pool.query('SELECT customer_id, status FROM orders WHERE id = $1', [orderId]);
    if (orderCheck.rows.length === 0) return res.status(404).json({ error: 'Order not found.' });
    if (orderCheck.rows[0].customer_id !== req.userId) return res.status(403).json({ error: 'Forbidden.' });
    if (!['delivered', 'received', 'completed'].includes(orderCheck.rows[0].status)) {
      return res.status(400).json({ error: 'Return only allowed after delivery.' });
    }
    const existingReturn = await pool.query(
      'SELECT id FROM returns WHERE order_id = $1 AND product_id = $2 AND status IN ($3,$4)',
      [orderId, product_id, 'pending', 'approved']
    );
    if (existingReturn.rows.length > 0) return res.status(400).json({ error: 'Return already requested for this product.' });
    await pool.query(
      'INSERT INTO returns (order_id, customer_id, product_id, reason, photos, status) VALUES ($1, $2, $3, $4, $5, $6)',
      [orderId, req.userId, product_id, reason, photos || null, 'pending']
    );
    const msg = `📦 Return requested for product #${product_id}. Reason: ${reason}`;
    await pool.query('INSERT INTO order_chat_messages (order_id, from_user, message) VALUES ($1, $2, $3)', [orderId, 'System', msg]);
    
    const io = req.app.get('io');
    io.to(`order_${orderId}`).emit('new-order-chat-message', { order_id: orderId, from_user: 'System', message: msg, timestamp: new Date() });
    io.emit('return-requested', { orderId });
    res.json({ success: true, message: 'Return request submitted.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;