const express = require('express');
const { body, validationResult } = require('express-validator');
const { pool } = require('../config/database');
const { authMiddleware } = require('../middleware/auth');
const router = express.Router();

// ============================================================
//  GET ALL ADDRESSES
// ============================================================

router.get('/', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM customer_addresses WHERE customer_id = $1 ORDER BY is_default DESC, created_at ASC', [req.userId]);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
//  ADD ADDRESS
// ============================================================

router.post('/', authMiddleware, [
  body('label').trim().escape().notEmpty().withMessage('Label required'),
  body('address').trim().escape().notEmpty().withMessage('Address required'),
  body('building_name').optional().trim().escape(),
  body('estate').optional().trim().escape(),
  body('nearest_landmark').optional().trim().escape(),
  body('delivery_instructions').optional().trim().escape()
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  const { label, address, lat, lng, location_name, address_type, recipient_name, recipient_phone,
          building_name, floor_room, road, estate, nearest_landmark, delivery_instructions,
          county_id, sub_county_id, ward_id, pickup_station_id } = req.body;

  try {
    const countResult = await pool.query('SELECT COUNT(*) FROM customer_addresses WHERE customer_id = $1', [req.userId]);
    const isDefault = parseInt(countResult.rows[0].count) === 0;

    let fullAddress = address;
    if (building_name) fullAddress = `${building_name}, ${fullAddress}`;
    if (estate) fullAddress = `${fullAddress}, ${estate}`;

    await pool.query(
      `INSERT INTO customer_addresses (
        customer_id, label, address, lat, lng, location_name, is_default,
        address_type, recipient_name, recipient_phone, building_name, floor_room,
        road, estate, nearest_landmark, delivery_instructions,
        county_id, sub_county_id, ward_id, pickup_station_id
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)`,
      [req.userId, label, fullAddress, lat || null, lng || null, location_name || null, isDefault,
       address_type || 'doorstep', recipient_name || null, recipient_phone || null,
       building_name || null, floor_room || null, road || null, estate || null,
       nearest_landmark || null, delivery_instructions || null,
       county_id || null, sub_county_id || null, ward_id || null, pickup_station_id || null]
    );
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
//  SET DEFAULT ADDRESS
// ============================================================

router.put('/:id/default', authMiddleware, async (req, res) => {
  const id = parseInt(req.params.id);
  try {
    await pool.query('UPDATE customer_addresses SET is_default = false WHERE customer_id = $1', [req.userId]);
    await pool.query('UPDATE customer_addresses SET is_default = true WHERE id = $1 AND customer_id = $2', [id, req.userId]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
//  DELETE ADDRESS
// ============================================================

router.delete('/:id', authMiddleware, async (req, res) => {
  const id = parseInt(req.params.id);
  try {
    await pool.query('DELETE FROM customer_addresses WHERE id = $1 AND customer_id = $2', [id, req.userId]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;