const express = require('express');
const { pool, logError } = require('../config/database');
const { authMiddleware, adminOnly } = require('../middleware/auth');
const router = express.Router();

// Admin analytics
router.get('/admin', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { period = 'week' } = req.query;
    const interval = period === 'week' ? '7 days' : period === 'month' ? '30 days' : '1 day';
    
    const revenueResult = await pool.query(
      `SELECT DATE(created_at) as date, SUM(total) as revenue, COUNT(*) as orders
       FROM orders 
       WHERE status IN ('confirmed', 'shipped', 'delivered', 'received', 'completed')
       AND created_at > NOW() - INTERVAL '${interval}'
       GROUP BY DATE(created_at)
       ORDER BY date ASC`
    );
    
    const topProducts = await pool.query(
      `SELECT oi.product_name, SUM(oi.quantity) as total_sold, SUM(oi.quantity * CAST(REPLACE(oi.price, 'Ksh ', '') AS DECIMAL)) as revenue
       FROM order_items oi
       JOIN orders o ON oi.order_id = o.id
       WHERE o.status IN ('confirmed', 'shipped', 'delivered', 'received', 'completed')
       AND o.created_at > NOW() - INTERVAL '${interval}'
       GROUP BY oi.product_name
       ORDER BY total_sold DESC
       LIMIT 10`
    );
    
    const customerStats = await pool.query(
      `SELECT COUNT(*) as total_customers,
       COUNT(CASE WHEN created_at > NOW() - INTERVAL '${interval}' THEN 1 END) as new_customers
       FROM customers`
    );
    
    const orderStats = await pool.query(
      `SELECT status, COUNT(*) as count
       FROM orders
       GROUP BY status`
    );
    
    const refundStats = await pool.query(
      `SELECT refund_status, COUNT(*) as count
       FROM orders
       WHERE refund_status IS NOT NULL AND refund_status != 'none'
       GROUP BY refund_status`
    );
    
    const lowStock = await pool.query(
      `SELECT id, name, stock FROM products WHERE stock < 10 ORDER BY stock ASC LIMIT 20`
    );
    
    res.json({
      period,
      revenue: revenueResult.rows,
      topProducts: topProducts.rows,
      customers: customerStats.rows[0],
      orderStatuses: orderStats.rows,
      refundStatuses: refundStats.rows,
      totalRevenue: revenueResult.rows.reduce((sum, row) => sum + parseFloat(row.revenue || 0), 0),
      totalOrders: revenueResult.rows.reduce((sum, row) => sum + parseInt(row.orders || 0), 0),
      lowStock: lowStock.rows
    });
    
  } catch (err) {
    console.error('❌ Analytics error:', err);
    logError(err, 'Analytics');
    res.status(500).json({ error: err.message });
  }
});

// Promo codes (admin)
router.get('/promo-codes', authMiddleware, adminOnly, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM promo_codes ORDER BY created_at DESC');
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    logError(err, 'Get promo codes');
    res.status(500).json({ error: err.message });
  }
});

router.post('/promo-codes', authMiddleware, adminOnly, [
  require('express-validator').body('code').notEmpty().withMessage('Code required'),
  require('express-validator').body('discount_type').isIn(['percentage', 'fixed']).withMessage('Invalid type'),
  require('express-validator').body('discount_value').isNumeric().withMessage('Discount value must be a number'),
], async (req, res) => {
  const errors = require('express-validator').validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  const { code, discount_type, discount_value, min_order_value, expires_at, usage_limit } = req.body;
  try {
    await pool.query(
      `INSERT INTO promo_codes (code, discount_type, discount_value, min_order_value, expires_at, usage_limit)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [code.toUpperCase(), discount_type, discount_value, min_order_value || 0, expires_at || null, usage_limit || null]
    );
    const { logAdminActivity } = require('../services/orderService');
    await logAdminActivity(req.userId, 'CREATE_PROMO', { code });
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    logError(err, 'Create promo');
    res.status(500).json({ error: err.message });
  }
});

router.delete('/promo-codes/:id', authMiddleware, adminOnly, async (req, res) => {
  const id = parseInt(req.params.id);
  try {
    await pool.query('DELETE FROM promo_codes WHERE id = $1', [id]);
    const { logAdminActivity } = require('../services/orderService');
    await logAdminActivity(req.userId, 'DELETE_PROMO', { id });
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    logError(err, 'Delete promo');
    res.status(500).json({ error: err.message });
  }
});

// Validate promo code (public)
router.post('/validate', async (req, res) => {
  const { code, subtotal } = req.body;
  if (!code) return res.json({ valid: false, message: 'No code provided.' });
  try {
    const result = await pool.query('SELECT * FROM promo_codes WHERE code = $1 AND active = true AND (expires_at IS NULL OR expires_at > NOW()) AND (usage_limit IS NULL OR used_count < usage_limit)', [code.toUpperCase()]);
    if (result.rows.length === 0) return res.json({ valid: false, message: 'Invalid or expired promo code.' });
    const promo = result.rows[0];
    if (subtotal < promo.min_order_value) {
      return res.json({ valid: false, message: `Minimum order value is Ksh ${promo.min_order_value}.` });
    }
    let discount = 0;
    if (promo.discount_type === 'percentage') {
      discount = subtotal * promo.discount_value / 100;
    } else {
      discount = promo.discount_value;
    }
    discount = Math.min(discount, subtotal);
    res.json({ valid: true, discount, message: '🎉 Promo applied!' });
  } catch (err) {
    console.error(err);
    logError(err, 'Promo validate');
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;