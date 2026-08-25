const express = require('express');
const { pool } = require('../config/database');
const { authMiddleware } = require('../middleware/auth');
const router = express.Router();

// ============================================================
//  GET CART
// ============================================================

router.get('/', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query('SELECT items, reserved_until FROM carts WHERE customer_id = $1', [req.userId]);
    if (result.rows.length === 0) return res.json({ items: [] });
    const row = result.rows[0];
    if (row.reserved_until && new Date() > new Date(row.reserved_until)) {
      await pool.query('UPDATE carts SET items = $1, reserved_until = NULL WHERE customer_id = $2', ['[]', req.userId]);
      return res.json({ items: [] });
    }
    res.json({ items: row.items });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
//  UPDATE CART
// ============================================================

router.put('/', authMiddleware, async (req, res) => {
  try {
    const { items } = req.body;
    const reservedUntil = new Date(Date.now() + 15 * 60 * 1000);
    await pool.query(
      'INSERT INTO carts (customer_id, items, reserved_until) VALUES ($1, $2, $3) ON CONFLICT (customer_id) DO UPDATE SET items = $2, reserved_until = $3, updated_at = NOW()',
      [req.userId, JSON.stringify(items), reservedUntil]
    );
    res.json({ success: true, reserved_until: reservedUntil });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;