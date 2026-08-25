// ============================================================
//  RETURNS ROUTES
//  Location: D:\my-business-website\src\routes\returns.js
// ============================================================

const express = require('express');
const { pool } = require('../config/database');
const { authMiddleware } = require('../middleware/auth');
const router = express.Router();

// ============================================================
//  GET CUSTOMER RETURNS
// ============================================================

router.get('/customer', authMiddleware, async (req, res) => {
  try {
    const customerId = req.userId;
    const result = await pool.query(
      `SELECT * FROM returns WHERE customer_id = $1 ORDER BY requested_at DESC`,
      [customerId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Customer returns error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
//  GET ALL RETURNS (Admin)
// ============================================================

router.get('/admin', authMiddleware, async (req, res) => {
  if (req.role !== 'admin') {
    return res.status(403).json({ error: 'Admin only' });
  }

  try {
    const result = await pool.query(`
      SELECT r.*, o.order_ref, c.name AS customer_name
      FROM returns r
      JOIN orders o ON r.order_id = o.id
      JOIN customers c ON r.customer_id = c.id
      ORDER BY r.requested_at DESC
    `);
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Admin returns error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
//  UPDATE RETURN STATUS (Admin)
// ============================================================

router.put('/admin/:id', authMiddleware, async (req, res) => {
  if (req.role !== 'admin') {
    return res.status(403).json({ error: 'Admin only' });
  }

  const id = parseInt(req.params.id);
  const { action } = req.body;

  if (!['approve', 'reject'].includes(action)) {
    return res.status(400).json({ error: 'Invalid action' });
  }

  try {
    const newStatus = action === 'approve' ? 'approved' : 'rejected';
    const approvedAt = action === 'approve' ? new Date() : null;

    await pool.query(
      `UPDATE returns SET status = $1, approved_at = $2 WHERE id = $3`,
      [newStatus, approvedAt, id]
    );

    // Log admin activity
    const { logAdminActivity } = require('../services/orderService');
    await logAdminActivity(req.userId, action === 'approve' ? 'APPROVE_RETURN' : 'REJECT_RETURN', { returnId: id });

    res.json({ success: true });
  } catch (err) {
    console.error('❌ Update return error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;