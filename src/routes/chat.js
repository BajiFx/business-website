const express = require('express');
const { pool } = require('../config/database');
const { authMiddleware, customerOnly } = require('../middleware/auth');
const router = express.Router();

// ============================================================
//  GET ALL CHAT MESSAGES
// ============================================================

router.get('/', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT cm.*, c.name AS customer_name
      FROM chat_messages cm
      LEFT JOIN customers c ON cm.customer_id = c.id
      ORDER BY timestamp ASC
    `);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
//  GET CUSTOMER CHAT
// ============================================================

router.get('/customer', authMiddleware, customerOnly, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT cm.*, c.name AS customer_name
       FROM chat_messages cm
       LEFT JOIN customers c ON cm.customer_id = c.id
       WHERE cm.customer_id = $1
       ORDER BY timestamp DESC LIMIT 20`,
      [req.userId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;