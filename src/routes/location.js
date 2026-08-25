// ============================================================
//  LOCATION ROUTES - Complete Fixed Version
//  Location: D:\my-business-website\src\routes\location.js
// ============================================================

const express = require('express');
const { pool } = require('../config/database');
const { authMiddleware, adminOnly, customerOnly } = require('../middleware/auth');
const router = express.Router();

// ============================================================
//  ADMIN - GET LOCATION REQUESTS
// ============================================================

router.get('/admin/requests', authMiddleware, adminOnly, async (req, res) => {
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
//  ADMIN - APPROVE LOCATION
// ============================================================

router.post('/admin/requests/:id/approve', authMiddleware, adminOnly, async (req, res) => {
  const id = parseInt(req.params.id);
  try {
    await pool.query('UPDATE location_requests SET status = $1, updated_at = NOW() WHERE id = $2', ['approved', id]);
    const result = await pool.query('SELECT customer_id FROM location_requests WHERE id = $1', [id]);
    const customerId = result.rows[0]?.customer_id;
    if (customerId) {
      const io = req.app.get('io');
      io.to(`customer_${customerId}`).emit('location_request_approved');
    }
    res.json({ success: true });
  } catch (err) {
    console.error('❌ Approve location error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
//  ADMIN - REJECT LOCATION
// ============================================================

router.post('/admin/requests/:id/reject', authMiddleware, adminOnly, async (req, res) => {
  const id = parseInt(req.params.id);
  try {
    await pool.query('UPDATE location_requests SET status = $1, updated_at = NOW() WHERE id = $2', ['rejected', id]);
    res.json({ success: true });
  } catch (err) {
    console.error('❌ Reject location error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
//  CUSTOMER - REQUEST LOCATION
// ============================================================

router.post('/customer/request', authMiddleware, customerOnly, async (req, res) => {
  const customerId = req.userId;
  try {
    const existing = await pool.query(
      'SELECT * FROM location_requests WHERE customer_id = $1 AND status = $2',
      [customerId, 'pending']
    );
    if (existing.rows.length > 0) {
      return res.status(400).json({ error: 'You already have a pending request.' });
    }
    
    const approved = await pool.query(
      'SELECT * FROM location_requests WHERE customer_id = $1 AND status = $2',
      [customerId, 'approved']
    );
    if (approved.rows.length > 0) {
      return res.json({ success: true, alreadyApproved: true });
    }
    
    await pool.query('INSERT INTO location_requests (customer_id, status) VALUES ($1, $2)', [customerId, 'pending']);
    res.json({ success: true, message: 'Request sent. Awaiting admin approval.' });
  } catch (err) {
    console.error('❌ Request location error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
//  CUSTOMER - GET LOCATION STATUS - FIXED
// ============================================================

router.get('/customer/status', authMiddleware, customerOnly, async (req, res) => {
  const customerId = req.userId;
  try {
    // First check if location_requests table exists
    const tableCheck = await pool.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_name = 'location_requests'
      )
    `);
    
    if (!tableCheck.rows[0].exists) {
      // Table doesn't exist - return 'none' status
      return res.json({ status: 'none' });
    }
    
    const result = await pool.query(
      'SELECT status FROM location_requests WHERE customer_id = $1 ORDER BY updated_at DESC LIMIT 1',
      [customerId]
    );
    const status = result.rows[0]?.status || 'none';
    res.json({ status });
  } catch (err) {
    console.error('❌ Location status error:', err);
    // Return 'none' instead of error to prevent frontend breaking
    res.json({ status: 'none' });
  }
});

// ============================================================
//  ADMIN - TOGGLE LOCATION SHARING
// ============================================================

router.post('/admin/toggle', authMiddleware, adminOnly, async (req, res) => {
  const { lat, lng, enabled } = req.body;
  try {
    await pool.query(
      'UPDATE shop SET location_sharing_enabled = $1, admin_lat = $2, admin_lng = $3',
      [enabled, lat || null, lng || null]
    );
    if (enabled && lat && lng) {
      const customers = await pool.query('SELECT customer_id FROM location_requests WHERE status = $1', ['approved']);
      const io = req.app.get('io');
      customers.rows.forEach(row => io.to(`customer_${row.customer_id}`).emit('admin_location', { lat, lng }));
    }
    res.json({ success: true });
  } catch (err) {
    console.error('❌ Toggle location error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
//  ADMIN - UPDATE LOCATION
// ============================================================

router.post('/admin/update', authMiddleware, adminOnly, async (req, res) => {
  const { lat, lng } = req.body;
  if (!lat || !lng) {
    return res.status(400).json({ error: 'Missing coordinates' });
  }
  try {
    await pool.query('UPDATE shop SET admin_lat = $1, admin_lng = $2', [lat, lng]);
    const customers = await pool.query('SELECT customer_id FROM location_requests WHERE status = $1', ['approved']);
    const io = req.app.get('io');
    customers.rows.forEach(row => io.to(`customer_${row.customer_id}`).emit('admin_location', { lat, lng }));
    res.json({ success: true });
  } catch (err) {
    console.error('❌ Update location error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;