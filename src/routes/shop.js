// ============================================================
//  SHOP ROUTES - Complete Fixed Version
//  Location: D:\my-business-website\src\routes\shop.js
// ============================================================

const express = require('express');
const fs = require('fs');
const { pool } = require('../config/database');
const { authMiddleware } = require('../middleware/auth');
const { upload } = require('../middleware/upload');
const { uploadToCloudinary, getHeroImage } = require('../config/cloudinary');
const { cacheMiddleware } = require('../../redis');
const { logAdminActivity } = require('../services/orderService');
const router = express.Router();

// ============================================================
//  SHOP PROFILE - GET
// ============================================================

router.get('/', cacheMiddleware(300), async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM shop LIMIT 1');
    if (result.rows.length === 0) {
      // Return default shop data instead of error
      return res.json({
        id: 1,
        name: 'My Shop',
        location: 'Nairobi, Kenya',
        address: '',
        latitude: '',
        longitude: '',
        description: '',
        mission: '',
        vision: '',
        logo: '',
        heroImage: '',
        whatsapp: '',
        tiktok: '',
        instagram: '',
        facebook: '',
        phone: '',
        location_sharing_enabled: false,
        admin_lat: '',
        admin_lng: '',
        mpesa_enabled: false,
        mpesa_number: '',
        airtel_enabled: false,
        airtel_number: '',
        bank_enabled: false,
        bank_name: '',
        bank_account: '',
        bank_account_name: '',
        paypal_enabled: false,
        paypal_email: '',
        shipping_policy: '',
        return_policy: '',
        terms_policy: '',
        privacy_policy: '',
        delivery_enabled: true,
        online_orders_enabled: true,
        base_url: process.env.BASE_URL || ''
      });
    }
    const row = result.rows[0];
    const heroImage = getHeroImage(row);
    res.json({ ...row, heroImage });
  } catch (err) {
    console.error('❌ Shop GET error:', err);
    // Return default shop data on error
    res.json({
      id: 1,
      name: 'My Shop',
      location: 'Nairobi, Kenya',
      address: '',
      latitude: '',
      longitude: '',
      description: '',
      mission: '',
      vision: '',
      logo: '',
      heroImage: '',
      whatsapp: '',
      tiktok: '',
      instagram: '',
      facebook: '',
      phone: '',
      location_sharing_enabled: false,
      admin_lat: '',
      admin_lng: '',
      mpesa_enabled: false,
      mpesa_number: '',
      airtel_enabled: false,
      airtel_number: '',
      bank_enabled: false,
      bank_name: '',
      bank_account: '',
      bank_account_name: '',
      paypal_enabled: false,
      paypal_email: '',
      shipping_policy: '',
      return_policy: '',
      terms_policy: '',
      privacy_policy: '',
      delivery_enabled: true,
      online_orders_enabled: true,
      base_url: process.env.BASE_URL || ''
    });
  }
});

// ============================================================
//  SHOP PROFILE - UPDATE
// ============================================================

router.post('/', authMiddleware, upload.fields([{ name: 'logo' }, { name: 'heroImage' }]), async (req, res) => {
  try {
    const {
      name, location, address, latitude, longitude, description, mission, vision,
      whatsapp, tiktok, instagram, facebook, phone,
      mpesa_enabled, mpesa_number,
      airtel_enabled, airtel_number,
      bank_enabled, bank_name, bank_account, bank_account_name,
      paypal_enabled, paypal_email,
      shipping_policy, return_policy, terms_policy, privacy_policy,
      delivery_enabled, online_orders_enabled
    } = req.body;

    let logo = null;
    let heroImage = null;

    if (req.files && req.files['logo']) {
      const file = req.files['logo'][0];
      try {
        logo = await uploadToCloudinary(file.path, { folder: 'business_shop/logos' });
        if (logo) fs.unlink(file.path, (err) => { if (err) console.error('Failed to delete local file:', err); });
      } catch (err) {
        console.error('Logo upload failed:', err);
        logo = null;
      }
    }

    if (req.files && req.files['heroImage']) {
      const file = req.files['heroImage'][0];
      try {
        heroImage = await uploadToCloudinary(file.path, { folder: 'business_shop/hero', width: 1920, height: 600 });
        if (heroImage) fs.unlink(file.path, (err) => { if (err) console.error('Failed to delete local file:', err); });
      } catch (err) {
        console.error('Hero image upload failed:', err);
        heroImage = null;
      }
    }

    const existing = await pool.query('SELECT * FROM shop LIMIT 1');
    let updatedRow;

    if (existing.rows.length === 0) {
      const insertResult = await pool.query(`
        INSERT INTO shop (
          name, location, address, latitude, longitude, description, mission, vision,
          logo, heroImage, whatsapp, tiktok, instagram, facebook, phone,
          mpesa_enabled, mpesa_number,
          airtel_enabled, airtel_number,
          bank_enabled, bank_name, bank_account, bank_account_name,
          paypal_enabled, paypal_email,
          shipping_policy, return_policy, terms_policy, privacy_policy,
          delivery_enabled, online_orders_enabled, base_url
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31)
        RETURNING *
      `, [
        name || 'My Shop',
        location || 'Nairobi, Kenya',
        address || '',
        latitude || '',
        longitude || '',
        description || '',
        mission || '',
        vision || '',
        logo,
        heroImage,
        whatsapp || '',
        tiktok || '',
        instagram || '',
        facebook || '',
        phone || '',
        mpesa_enabled === 'true' || false,
        mpesa_number || '',
        airtel_enabled === 'true' || false,
        airtel_number || '',
        bank_enabled === 'true' || false,
        bank_name || '',
        bank_account || '',
        bank_account_name || '',
        paypal_enabled === 'true' || false,
        paypal_email || '',
        shipping_policy || '',
        return_policy || '',
        terms_policy || '',
        privacy_policy || '',
        delivery_enabled === 'true' || true,
        online_orders_enabled === 'true' || true,
        process.env.BASE_URL || ''
      ]);
      updatedRow = insertResult.rows[0];
    } else {
      const fields = [
        'name', 'location', 'address', 'latitude', 'longitude', 'description', 'mission', 'vision',
        'whatsapp', 'tiktok', 'instagram', 'facebook', 'phone',
        'mpesa_enabled', 'mpesa_number',
        'airtel_enabled', 'airtel_number',
        'bank_enabled', 'bank_name', 'bank_account', 'bank_account_name',
        'paypal_enabled', 'paypal_email',
        'shipping_policy', 'return_policy', 'terms_policy', 'privacy_policy',
        'delivery_enabled', 'online_orders_enabled'
      ];

      const values = fields.map(f => {
        if (f.endsWith('_enabled')) return req.body[f] === 'true' || false;
        return req.body[f] || null;
      });

      let setClause = fields.map((f, i) => `${f} = $${i + 1}`).join(', ');
      let params = [...values];
      let paramIdx = fields.length + 1;

      if (logo) {
        setClause += `, logo = $${paramIdx}`;
        params.push(logo);
        paramIdx++;
      }
      if (heroImage) {
        setClause += `, heroImage = $${paramIdx}`;
        params.push(heroImage);
        paramIdx++;
      }
      setClause += `, base_url = $${paramIdx}`;
      params.push(process.env.BASE_URL || '');
      setClause += `, updated_at = NOW()`;

      const updateResult = await pool.query(
        `UPDATE shop SET ${setClause} WHERE id = 1 RETURNING *`,
        params
      );
      updatedRow = updateResult.rows[0];
    }

    const hero = getHeroImage(updatedRow);
    res.json({ success: true, shop: { ...updatedRow, heroImage: hero } });
  } catch (err) {
    console.error('❌ Shop update error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
//  SHOP POLICIES
// ============================================================

router.get('/policies', cacheMiddleware(300), async (req, res) => {
  try {
    const result = await pool.query('SELECT shipping_policy, return_policy, terms_policy, privacy_policy, delivery_enabled, online_orders_enabled FROM shop LIMIT 1');
    if (result.rows.length === 0) {
      return res.json({
        shipping_policy: '🚚 We deliver to all major towns in Kenya. Delivery takes 2-5 working days.',
        return_policy: '🔄 Returns are accepted within 14 days of delivery. Products must be in original condition.',
        terms_policy: '📋 By using our platform, you agree to our terms and conditions.',
        privacy_policy: '🔒 We protect your personal data and never share it with third parties.',
        delivery_enabled: true,
        online_orders_enabled: true
      });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error('❌ Policies error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
//  FEATURED PRODUCTS
// ============================================================

router.put('/featured-products', authMiddleware, async (req, res) => {
  if (req.role !== 'admin') {
    return res.status(403).json({ error: 'Admin only' });
  }

  try {
    const { productIds } = req.body;
    if (!productIds || !Array.isArray(productIds)) {
      return res.status(400).json({ error: 'Product IDs required' });
    }

    await pool.query(`UPDATE products SET is_featured = false`);

    if (productIds.length > 0) {
      await pool.query(
        `UPDATE products SET is_featured = true WHERE id = ANY($1::int[])`,
        [productIds]
      );
    }

    await logAdminActivity(req.userId, 'UPDATE_FEATURED_PRODUCTS', { productIds });
    res.json({ success: true });
  } catch (err) {
    console.error('❌ Featured products error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
//  SHOP STATISTICS
// ============================================================

router.get('/statistics', async (req, res) => {
  try {
    const products = await pool.query('SELECT COUNT(*) FROM products');
    const orders = await pool.query('SELECT COUNT(*) FROM orders WHERE status != $1', ['cancelled']);
    const reviews = await pool.query('SELECT COUNT(*) FROM product_reviews');
    const customers = await pool.query('SELECT COUNT(*) FROM customers');

    const avgRating = await pool.query('SELECT AVG(rating) as avg_rating FROM product_reviews');

    res.json({
      totalProducts: parseInt(products.rows[0].count),
      totalOrders: parseInt(orders.rows[0].count),
      totalReviews: parseInt(reviews.rows[0].count),
      totalCustomers: parseInt(customers.rows[0].count),
      averageRating: parseFloat(avgRating.rows[0].avg_rating || 0)
    });
  } catch (err) {
    console.error('❌ Statistics error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;