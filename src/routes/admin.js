// ============================================================
//  ADMIN ROUTES - Complete Fixed Version
//  Location: D:\my-business-website\src\routes\admin.js
// ============================================================

const express = require('express');
const fs = require('fs');
const path = require('path');
const { pool } = require('../config/database');
const { authMiddleware, adminOnly } = require('../middleware/auth');
const { appendOrderStatus, restockOrder, logAdminActivity } = require('../services/orderService');
const router = express.Router();

// ============================================================
//  ADMIN DASHBOARD STATS
// ============================================================

router.get('/dashboard', authMiddleware, adminOnly, async (req, res) => {
  try {
    console.log('📊 Fetching dashboard stats...');
    
    const statuses = ['pending', 'confirmed', 'shipped', 'delivered', 'received', 'cancelled', 'pending_payment', 'completed'];
    const stats = {};
    
    for (const status of statuses) {
      const result = await pool.query('SELECT COUNT(*) FROM orders WHERE status = $1', [status]);
      stats[status] = parseInt(result.rows[0].count);
    }
    
    const replacementsPending = await pool.query(
      `SELECT COUNT(*) FROM orders WHERE replacement_status IN ('pending', 'pending_payment', 'pending_refund')`
    );
    stats.replacements_pending = parseInt(replacementsPending.rows[0].count);
    
    const refundsPending = await pool.query(`SELECT COUNT(*) FROM orders WHERE refund_status = 'pending'`);
    stats.refunds_pending = parseInt(refundsPending.rows[0].count);
    
    const urgent = await pool.query(
      `SELECT COUNT(*) FROM orders WHERE urgent_delivery = true AND status NOT IN ('received', 'cancelled', 'completed')`
    );
    stats.urgent = parseInt(urgent.rows[0].count);
    
    const total = await pool.query('SELECT COUNT(*) FROM orders');
    stats.total_orders = parseInt(total.rows[0].count);
    
    const revenue = await pool.query(
      `SELECT COALESCE(SUM(total), 0) FROM orders WHERE status IN ('confirmed', 'shipped', 'delivered', 'received', 'completed')`
    );
    stats.total_revenue = parseFloat(revenue.rows[0].sum) || 0;
    
    const returnsPending = await pool.query(`SELECT COUNT(*) FROM returns WHERE status = 'pending'`);
    stats.returns_pending = parseInt(returnsPending.rows[0].count);
    
    console.log('✅ Dashboard stats fetched successfully');
    res.json(stats);
    
  } catch (err) {
    console.error('❌ Dashboard error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
//  ADMIN - GET RECENT ORDERS
// ============================================================

router.get('/recent-orders', authMiddleware, adminOnly, async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 10;
    
    const result = await pool.query(`
      SELECT o.*, c.name AS customer_name, c.email AS customer_email
      FROM orders o
      JOIN customers c ON o.customer_id = c.id
      ORDER BY o.created_at DESC
      LIMIT $1
    `, [limit]);
    
    console.log(`📦 Found ${result.rows.length} recent orders`);
    res.json(result.rows);
    
  } catch (err) {
    console.error('❌ Recent orders error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
//  ADMIN - GET ALL ORDERS (with filtering)
// ============================================================

router.get('/orders', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { status, search, limit = 50, offset = 0 } = req.query;
    
    let query = `
      SELECT o.*, c.name AS customer_name, c.email AS customer_email
      FROM orders o
      JOIN customers c ON o.customer_id = c.id
    `;
    const params = [];
    const conditions = [];
    let paramIndex = 1;
    
    if (status && status !== 'all') {
      conditions.push(`o.status = $${paramIndex}`);
      params.push(status);
      paramIndex++;
    }
    
    if (search) {
      conditions.push(`(c.name ILIKE $${paramIndex} OR c.email ILIKE $${paramIndex} OR o.order_ref ILIKE $${paramIndex})`);
      params.push(`%${search}%`);
      paramIndex++;
    }
    
    if (conditions.length > 0) {
      query += ' WHERE ' + conditions.join(' AND ');
    }
    
    query += ' ORDER BY o.created_at DESC';
    query += ` LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
    params.push(parseInt(limit), parseInt(offset));
    
    const result = await pool.query(query, params);
    
    console.log(`📦 Found ${result.rows.length} orders`);
    res.json(result.rows);
    
  } catch (err) {
    console.error('❌ Orders error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
//  ADMIN - CONFIRM ORDER
// ============================================================

router.put('/orders/:id/confirm', authMiddleware, adminOnly, async (req, res) => {
  try {
    const orderId = parseInt(req.params.id);
    
    const orderResult = await pool.query(
      `SELECT o.*, c.name AS customer_name, c.email AS customer_email
       FROM orders o
       JOIN customers c ON o.customer_id = c.id
       WHERE o.id = $1`,
      [orderId]
    );
    
    if (orderResult.rows.length === 0) {
      return res.status(404).json({ error: 'Order not found' });
    }
    
    const order = orderResult.rows[0];
    
    if (order.status !== 'pending') {
      return res.status(400).json({ error: `Order already processed (status: ${order.status})` });
    }
    
    await pool.query(`UPDATE orders SET status = 'confirmed', updated_at = NOW() WHERE id = $1`, [orderId]);
    await appendOrderStatus(orderId, 'confirmed', 'Order confirmed by admin');
    await logAdminActivity(req.userId, 'CONFIRM_ORDER', { orderId });
    
    // Send confirmation message
    const ref = order.order_ref || `#${order.id}`;
    const message = `✅ **Order ${ref} Confirmed!**\n\nDear ${order.customer_name},\n\nYour order has been confirmed and is being prepared for shipping.\n\nThank you for shopping with us! 🙏`;
    
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
    io.emit('order-status-updated', { orderId });
    
    res.json({ success: true, message: '✅ Order confirmed.' });
    
  } catch (err) {
    console.error('❌ Confirm order error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
//  ADMIN - UPDATE ORDER STATUS
// ============================================================

router.put('/orders/:id/status', authMiddleware, adminOnly, async (req, res) => {
  try {
    const orderId = parseInt(req.params.id);
    const { status, tracking_number } = req.body;
    
    const current = await pool.query('SELECT status, customer_id, order_ref FROM orders WHERE id = $1', [orderId]);
    
    if (current.rows.length === 0) {
      return res.status(404).json({ error: 'Order not found' });
    }
    
    const currentStatus = current.rows[0].status;
    
    // Validate status transition
    const validTransitions = {
      'pending': ['confirmed', 'cancelled'],
      'confirmed': ['shipped', 'cancelled'],
      'shipped': ['delivered', 'cancelled'],
      'delivered': ['received', 'cancelled'],
      'received': ['completed'],
      'pending_payment': ['pending', 'cancelled']
    };
    
    if (!validTransitions[currentStatus] || !validTransitions[currentStatus].includes(status)) {
      return res.status(400).json({ error: `Cannot transition from ${currentStatus} to ${status}` });
    }
    
    const updates = { status };
    if (status === 'shipped') {
      updates.shipped_at = new Date();
      if (tracking_number) updates.tracking_number = tracking_number;
    } else if (status === 'delivered') {
      updates.delivered_at = new Date();
    } else if (status === 'received') {
      updates.received_at = new Date();
    } else if (status === 'completed') {
      updates.completed_at = new Date();
    }
    
    await pool.query(
      `UPDATE orders SET status = $1, shipped_at = $2, delivered_at = $3, received_at = $4, tracking_number = $5, completed_at = $6, updated_at = NOW() WHERE id = $7`,
      [
        updates.status,
        updates.shipped_at || null,
        updates.delivered_at || null,
        updates.received_at || null,
        updates.tracking_number || null,
        updates.completed_at || null,
        orderId
      ]
    );
    
    await appendOrderStatus(orderId, status, `Status updated by admin`);
    await logAdminActivity(req.userId, `UPDATE_ORDER_TO_${status.toUpperCase()}`, { orderId });
    
    const orderRef = current.rows[0].order_ref || `#${orderId}`;
    const message = `📦 Order ${orderRef} status updated to: ${status.toUpperCase()}`;
    
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
    io.emit('order-status-updated', { orderId });
    
    res.json({ success: true });
    
  } catch (err) {
    console.error('❌ Update status error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
//  ADMIN - CANCEL ORDER
// ============================================================

router.put('/orders/:id/cancel', authMiddleware, adminOnly, async (req, res) => {
  try {
    const orderId = parseInt(req.params.id);
    const { reason } = req.body;
    
    if (!reason) {
      return res.status(400).json({ error: 'Cancellation reason required' });
    }
    
    const orderResult = await pool.query('SELECT status, order_ref FROM orders WHERE id = $1', [orderId]);
    
    if (orderResult.rows.length === 0) {
      return res.status(404).json({ error: 'Order not found' });
    }
    
    const order = orderResult.rows[0];
    
    if (order.status === 'cancelled') {
      return res.status(400).json({ error: 'Order already cancelled' });
    }
    
    if (order.status === 'received' || order.status === 'completed') {
      return res.status(400).json({ error: 'Order cannot be cancelled' });
    }
    
    await pool.query(
      `UPDATE orders SET status = 'cancelled', cancelled_at = NOW(), cancelled_by = 'admin', updated_at = NOW() WHERE id = $1`,
      [orderId]
    );
    
    await appendOrderStatus(orderId, 'cancelled', `Cancelled by admin. Reason: ${reason}`);
    await restockOrder(orderId);
    await logAdminActivity(req.userId, 'CANCEL_ORDER', { orderId, reason });
    
    const ref = order.order_ref || `#${orderId}`;
    const message = `❌ Order ${ref} has been cancelled by admin. Reason: ${reason}`;
    
    await pool.query(
      'INSERT INTO order_chat_messages (order_id, from_user, message) VALUES ($1, $2, $3)',
      [orderId, 'System', message]
    );
    
    const io = req.app.get('io');
    io.to(`order_${orderId}`).emit('new-order-chat-message', {
      order_id: orderId,
      from_user: 'System',
      message: message,
      timestamp: new Date()
    });
    io.emit('order-status-updated', { orderId });
    
    res.json({ success: true, message: 'Order cancelled.' });
    
  } catch (err) {
    console.error('❌ Cancel order error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
//  ADMIN - HANDLE REFUND
// ============================================================

router.put('/orders/:id/refund', authMiddleware, adminOnly, async (req, res) => {
  try {
    const orderId = parseInt(req.params.id);
    const { action } = req.body;
    
    if (!['approve', 'reject'].includes(action)) {
      return res.status(400).json({ error: 'Invalid action.' });
    }
    
    const orderResult = await pool.query('SELECT refund_status FROM orders WHERE id = $1', [orderId]);
    
    if (orderResult.rows.length === 0) {
      return res.status(404).json({ error: 'Order not found' });
    }
    
    if (orderResult.rows[0].refund_status !== 'pending') {
      return res.status(400).json({ error: 'Refund not pending.' });
    }
    
    const newStatus = action === 'approve' ? 'approved' : 'rejected';
    await pool.query(`UPDATE orders SET refund_status = $1 WHERE id = $2`, [newStatus, orderId]);
    
    const msg = action === 'approve' ? '✅ Refund approved.' : '❌ Refund rejected.';
    await pool.query(
      'INSERT INTO order_chat_messages (order_id, from_user, message) VALUES ($1, $2, $3)',
      [orderId, 'System', msg]
    );
    
    const io = req.app.get('io');
    io.to(`order_${orderId}`).emit('new-order-chat-message', {
      order_id: orderId,
      from_user: 'System',
      message: msg,
      timestamp: new Date()
    });
    
    await logAdminActivity(req.userId, action === 'approve' ? 'APPROVE_REFUND' : 'REJECT_REFUND', { orderId });
    res.json({ success: true, message: `Refund ${action}d.` });
    
  } catch (err) {
    console.error('❌ Refund error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
//  ADMIN - SEND REMINDER
// ============================================================

router.post('/orders/:id/remind', authMiddleware, adminOnly, async (req, res) => {
  try {
    const orderId = parseInt(req.params.id);
    
    const orderResult = await pool.query(
      'SELECT customer_id, order_ref FROM orders WHERE id = $1 AND status = $2',
      [orderId, 'delivered']
    );
    
    if (orderResult.rows.length === 0) {
      return res.status(400).json({ error: 'Order not found or not in "delivered" state.' });
    }
    
    const customerId = orderResult.rows[0].customer_id;
    const ref = orderResult.rows[0].order_ref || `#${orderId}`;
    
    const customerResult = await pool.query('SELECT name FROM customers WHERE id = $1', [customerId]);
    const customerName = customerResult.rows[0]?.name || 'Customer';
    
    const message = `📢 Reminder: Dear ${customerName}, your order ${ref} has been delivered and is awaiting pickup. Please collect it within 7 working days. If you have already collected, please mark it as "Received" in your account. Thank you!`;
    
    await pool.query(
      'INSERT INTO order_chat_messages (order_id, from_user, message) VALUES ($1, $2, $3)',
      [orderId, 'System', message]
    );
    
    const io = req.app.get('io');
    io.to(`order_${orderId}`).emit('new-order-chat-message', {
      order_id: orderId,
      from_user: 'System',
      message: message,
      timestamp: new Date()
    });
    
    await logAdminActivity(req.userId, 'SEND_REMINDER', { orderId });
    res.json({ success: true, message: 'Reminder sent.' });
    
  } catch (err) {
    console.error('❌ Reminder error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
//  ADMIN - GET CUSTOMERS
// ============================================================

router.get('/customers', authMiddleware, adminOnly, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        id, name, email, phone, created_at,
        (SELECT COUNT(*) FROM orders WHERE customer_id = customers.id) as order_count,
        (SELECT COALESCE(SUM(total), 0) FROM orders WHERE customer_id = customers.id AND status IN ('confirmed', 'shipped', 'delivered', 'received', 'completed')) as total_spent
      FROM customers
      ORDER BY created_at DESC
    `);
    
    console.log(`👥 Found ${result.rows.length} customers`);
    res.json(result.rows);
    
  } catch (err) {
    console.error('❌ Customers error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
//  ADMIN - GET SINGLE CUSTOMER
// ============================================================

router.get('/customers/:id', authMiddleware, adminOnly, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const result = await pool.query(`
      SELECT id, name, email, phone, created_at
      FROM customers WHERE id = $1
    `, [id]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Customer not found' });
    }
    
    res.json(result.rows[0]);
    
  } catch (err) {
    console.error('❌ Customer detail error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
//  ADMIN - GET PROMO CODES
// ============================================================

router.get('/promo-codes', authMiddleware, adminOnly, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM promo_codes ORDER BY created_at DESC');
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Promo codes error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
//  ADMIN - CREATE PROMO CODE
// ============================================================

router.post('/promo-codes', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { code, discount_type, discount_value, min_order_value, expires_at, usage_limit } = req.body;
    
    if (!code || !discount_type || !discount_value) {
      return res.status(400).json({ error: 'Code, type, and value are required' });
    }
    
    await pool.query(
      `INSERT INTO promo_codes (code, discount_type, discount_value, min_order_value, expires_at, usage_limit)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [code.toUpperCase(), discount_type, discount_value, min_order_value || 0, expires_at || null, usage_limit || null]
    );
    
    await logAdminActivity(req.userId, 'CREATE_PROMO', { code });
    res.json({ success: true });
    
  } catch (err) {
    console.error('❌ Create promo error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
//  ADMIN - DELETE PROMO CODE
// ============================================================

router.delete('/promo-codes/:id', authMiddleware, adminOnly, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    await pool.query('DELETE FROM promo_codes WHERE id = $1', [id]);
    await logAdminActivity(req.userId, 'DELETE_PROMO', { id });
    res.json({ success: true });
  } catch (err) {
    console.error('❌ Delete promo error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
//  ADMIN - GET LOCATION REQUESTS
// ============================================================

router.get('/location-requests', authMiddleware, adminOnly, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT lr.*, c.name, c.email
      FROM location_requests lr
      JOIN customers c ON lr.customer_id = c.id
      WHERE lr.status = 'pending'
      ORDER BY lr.created_at ASC
    `);
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Location requests error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
//  ADMIN - APPROVE LOCATION REQUEST
// ============================================================

router.post('/location-requests/:id/approve', authMiddleware, adminOnly, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    
    await pool.query('UPDATE location_requests SET status = $1, updated_at = NOW() WHERE id = $2', ['approved', id]);
    
    const result = await pool.query('SELECT customer_id FROM location_requests WHERE id = $1', [id]);
    const customerId = result.rows[0]?.customer_id;
    
    if (customerId) {
      const io = req.app.get('io');
      io.to(`customer_${customerId}`).emit('location_request_approved');
    }
    
    await logAdminActivity(req.userId, 'APPROVE_LOCATION', { requestId: id });
    res.json({ success: true });
    
  } catch (err) {
    console.error('❌ Approve location error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
//  ADMIN - REJECT LOCATION REQUEST
// ============================================================

router.post('/location-requests/:id/reject', authMiddleware, adminOnly, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    await pool.query('UPDATE location_requests SET status = $1, updated_at = NOW() WHERE id = $2', ['rejected', id]);
    await logAdminActivity(req.userId, 'REJECT_LOCATION', { requestId: id });
    res.json({ success: true });
  } catch (err) {
    console.error('❌ Reject location error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
//  ADMIN - GET ADMIN LOGS
// ============================================================

router.get('/logs', authMiddleware, adminOnly, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM admin_logs ORDER BY created_at DESC LIMIT 100'
    );
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Logs error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
//  ADMIN - EXPORT ORDERS CSV
// ============================================================

router.get('/orders/export', authMiddleware, adminOnly, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT o.id, o.order_ref, o.created_at, o.status, o.total,
             c.name as customer_name, c.email as customer_email,
             o.delivery_address, o.recipient_name, o.recipient_phone
      FROM orders o
      JOIN customers c ON o.customer_id = c.id
      ORDER BY o.created_at DESC
    `);
    
    const rows = result.rows;
    
    if (rows.length === 0) {
      return res.status(404).json({ error: 'No orders to export.' });
    }

    let csv = 'Order ID,Reference,Date,Status,Total,Customer,Email,Delivery Address,Recipient,Phone\n';
    rows.forEach(row => {
      csv += `${row.id},${row.order_ref || 'N/A'},${new Date(row.created_at).toLocaleDateString()},${row.status},${row.total},${row.customer_name},${row.customer_email},${row.delivery_address || 'N/A'},${row.recipient_name || 'N/A'},${row.recipient_phone || 'N/A'}\n`;
    });

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename=orders-${new Date().toISOString().slice(0,10)}.csv`);
    res.send(csv);
    
  } catch (err) {
    console.error('❌ Export error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
//  ADMIN - BULK ORDER ACTIONS
// ============================================================

router.post('/orders/bulk', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { orderIds, action, status, tracking_number } = req.body;
    
    if (!orderIds || !Array.isArray(orderIds) || orderIds.length === 0) {
      return res.status(400).json({ error: 'No orders selected.' });
    }
    
    const results = [];
    
    for (const id of orderIds) {
      const orderId = parseInt(id);
      
      if (action === 'update_status' && status) {
        await pool.query(
          `UPDATE orders SET status = $1, updated_at = NOW() WHERE id = $2`,
          [status, orderId]
        );
        await appendOrderStatus(orderId, status, 'Bulk status update');
        results.push({ id: orderId, status });
      } else if (action === 'delete') {
        await pool.query('DELETE FROM order_items WHERE order_id = $1', [orderId]);
        await pool.query('DELETE FROM order_chat_messages WHERE order_id = $1', [orderId]);
        await pool.query('DELETE FROM orders WHERE id = $1', [orderId]);
        results.push({ id: orderId, action: 'deleted' });
      }
    }
    
    await logAdminActivity(req.userId, 'BULK_ORDER_ACTION', { action, count: orderIds.length });
    res.json({ success: true, results });
    
  } catch (err) {
    console.error('❌ Bulk action error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
//  ADMIN - UPDATE SHOP SETTINGS
// ============================================================

router.put('/shop', authMiddleware, adminOnly, async (req, res) => {
  try {
    const updates = req.body;
    const fields = [];
    const values = [];
    let paramIndex = 1;
    
    const allowedFields = [
      'name', 'location', 'address', 'latitude', 'longitude', 'description',
      'mission', 'vision', 'whatsapp', 'tiktok', 'instagram', 'facebook', 'phone',
      'mpesa_enabled', 'mpesa_number', 'airtel_enabled', 'airtel_number',
      'bank_enabled', 'bank_name', 'bank_account', 'bank_account_name',
      'paypal_enabled', 'paypal_email', 'shipping_policy', 'return_policy',
      'terms_policy', 'privacy_policy', 'delivery_enabled', 'online_orders_enabled'
    ];
    
    for (const field of allowedFields) {
      if (updates[field] !== undefined) {
        fields.push(`${field} = $${paramIndex}`);
        values.push(updates[field]);
        paramIndex++;
      }
    }
    
    if (fields.length === 0) {
      return res.status(400).json({ error: 'No fields to update' });
    }
    
    values.push(1);
    const query = `UPDATE shop SET ${fields.join(', ')}, updated_at = NOW() WHERE id = $${paramIndex} RETURNING *`;
    
    const result = await pool.query(query, values);
    await logAdminActivity(req.userId, 'UPDATE_SHOP', { fields: Object.keys(updates) });
    res.json({ success: true, shop: result.rows[0] });
    
  } catch (err) {
    console.error('❌ Shop update error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
//  ADMIN - ASSET MINIFICATION
// ============================================================

router.post('/minify', authMiddleware, adminOnly, async (req, res) => {
  try {
    const publicDir = path.join(process.cwd(), 'public');
    const files = fs.readdirSync(publicDir);
    const minified = [];
    let totalReduction = 0;
    
    for (const file of files) {
      if (file.endsWith('.js') || file.endsWith('.css')) {
        const filePath = path.join(publicDir, file);
        const content = fs.readFileSync(filePath, 'utf8');
        const originalSize = content.length;
        
        let minifiedContent = content
          .replace(/\/\/.*$/gm, '')
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/\s+/g, ' ')
          .replace(/;\s*/g, ';')
          .replace(/:\s*/g, ':')
          .replace(/{\s*/g, '{')
          .replace(/}\s*/g, '}')
          .replace(/\(\s*/g, '(')
          .replace(/\s*\)/g, ')')
          .trim();
        
        const minifiedSize = minifiedContent.length;
        const reduction = originalSize - minifiedSize;
        totalReduction += reduction;
        
        const minifiedPath = path.join(publicDir, file.replace(/\.(js|css)$/, '.min.$1'));
        fs.writeFileSync(minifiedPath, minifiedContent);
        minified.push(file);
        
        console.log(`✅ Minified ${file}: ${(reduction / 1024).toFixed(2)}KB saved`);
      }
    }
    
    await logAdminActivity(req.userId, 'MINIFY_ASSETS', { 
      files: minified,
      totalReduction: `${(totalReduction / 1024).toFixed(2)}KB`
    });
    
    res.json({
      success: true,
      message: `Minified ${minified.length} files`,
      files: minified,
      totalReduction: `${(totalReduction / 1024).toFixed(2)}KB`
    });
    
  } catch (err) {
    console.error('❌ Minify error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
//  ADMIN - ASSET STATS
// ============================================================

router.get('/assets/stats', authMiddleware, adminOnly, async (req, res) => {
  try {
    const publicDir = path.join(process.cwd(), 'public');
    const files = fs.readdirSync(publicDir);
    let jsCount = 0, cssCount = 0, totalSize = 0;
    
    for (const file of files) {
      if (file.endsWith('.js')) {
        jsCount++;
        const stats = fs.statSync(path.join(publicDir, file));
        totalSize += stats.size;
      } else if (file.endsWith('.css')) {
        cssCount++;
        const stats = fs.statSync(path.join(publicDir, file));
        totalSize += stats.size;
      }
    }
    
    res.json({
      success: true,
      jsCount,
      cssCount,
      totalSize: (totalSize / 1024).toFixed(1) + ' KB'
    });
  } catch (err) {
    console.error('❌ Stats error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;