const express = require('express');
const fs = require('fs');
const { body, validationResult } = require('express-validator');
const { pool } = require('../config/database');
const { authMiddleware } = require('../middleware/auth');
const { upload } = require('../middleware/upload');
const { uploadToCloudinary } = require('../config/cloudinary');
const { cacheMiddleware } = require('../../redis');
const { logAdminActivity } = require('../services/orderService');
const router = express.Router();

// ============================================================
//  GET ALL PRODUCTS
// ============================================================

router.get('/', cacheMiddleware(60), async (req, res) => {
  try {
    const { search, limit, category } = req.query;
    let query = 'SELECT * FROM products';
    let params = [];
    let conditions = [];
    if (search) {
      conditions.push('name ILIKE $' + (params.length + 1));
      params.push(`%${search}%`);
    }
    if (category && category !== 'all') {
      conditions.push('category = $' + (params.length + 1));
      params.push(category);
    }
    if (conditions.length > 0) {
      query += ' WHERE ' + conditions.join(' AND ');
    }
    query += ' ORDER BY created_at DESC';
    if (limit) {
      query += ' LIMIT $' + (params.length + 1);
      params.push(parseInt(limit));
    }
    const result = await pool.query(query, params);
    const products = await Promise.all(result.rows.map(async (product) => {
      const variantsResult = await pool.query(
        'SELECT * FROM product_variants WHERE product_id = $1 ORDER BY id',
        [product.id]
      );
      const variants = variantsResult.rows;
      let firstImage = null;
      if (variants.length > 0 && variants[0].image) {
        firstImage = variants[0].image;
      } else if (product.image) {
        firstImage = product.image;
      }
      let totalStock = 0;
      variants.forEach(v => { totalStock += v.stock || 0; });
      return { ...product, variants, image: firstImage, stock: totalStock || product.stock || 0 };
    }));
    res.json(products);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
//  BATCH VARIANTS
// ============================================================

router.get('/variants/batch', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM product_variants ORDER BY product_id, id');
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
//  PRODUCT DETAIL
// ============================================================

router.get('/:id/detail', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const productResult = await pool.query('SELECT * FROM products WHERE id = $1', [id]);
    if (productResult.rows.length === 0) return res.status(404).json({ error: 'Product not found' });
    const product = productResult.rows[0];

    const variantsResult = await pool.query(
      'SELECT * FROM product_variants WHERE product_id = $1 ORDER BY id',
      [id]
    );
    const variants = variantsResult.rows;

    const reviewsResult = await pool.query('SELECT * FROM product_reviews WHERE product_id = $1 ORDER BY created_at DESC', [id]);

    const relatedResult = await pool.query('SELECT * FROM products WHERE id != $1 ORDER BY created_at DESC LIMIT 6', [id]);
    const related = await Promise.all(relatedResult.rows.map(async (rel) => {
      const vRes = await pool.query(
        'SELECT * FROM product_variants WHERE product_id = $1 LIMIT 1',
        [rel.id]
      );
      const variant = vRes.rows[0] || null;
      return { ...rel, image: variant ? variant.image : rel.image };
    }));

    res.json({ product, variants, reviews: reviewsResult.rows, related });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
//  CREATE PRODUCT
// ============================================================

router.post('/', authMiddleware, upload.fields([{ name: 'image' }, { name: 'variantImages' }]), [
  body('name').trim().escape().isLength({ min: 2 }).withMessage('Product name must be at least 2 characters'),
  body('price').trim().escape().isNumeric().withMessage('Price must be a number'),
  body('description').optional().trim().escape(),
  body('category').optional().trim().escape(),
  body('shipping').optional().trim().escape(),
  body('badge1').optional().trim().escape(),
  body('badge2').optional().trim().escape(),
  body('contact').optional().trim().escape(),
  body('rating').optional().trim().escape()
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  try {
    const { name, price, category, contact, rating, badge1, badge2, shipping, isFlashSale, isNewArrival, description,
            shipping_fee, free_shipping_eligible, return_enabled, return_window_days, restocking_fee_percent,
            return_shipping_paid_by, return_condition, variants, old_price, discount_percent, stock } = req.body;

    let mainImage = null;
    if (req.files['image']) {
      const file = req.files['image'][0];
      mainImage = await uploadToCloudinary(file.path);
      fs.unlink(file.path, (err) => { if (err) console.error('Failed to delete local file:', err); });
    }

    const result = await pool.query(`
      INSERT INTO products (name, price, old_price, discount_percent, category, contact, rating, badge1, badge2, shipping, isFlashSale, isNewArrival,
        image, description, shipping_fee, free_shipping_eligible, return_enabled, return_window_days,
        restocking_fee_percent, return_shipping_paid_by, return_condition, stock, is_featured)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23) RETURNING *
    `, [name, price, old_price || null, discount_percent || null, category, contact, rating, badge1, badge2,
        shipping, isFlashSale === 'true', isNewArrival === 'true', mainImage, description,
        shipping_fee, free_shipping_eligible === 'true', return_enabled !== 'false',
        return_window_days || 14, restocking_fee_percent || 0, return_shipping_paid_by || 'buyer',
        return_condition || 'unopened', stock || 0, false]);

    const product = result.rows[0];

    if (variants && typeof variants === 'string') {
      const variantData = JSON.parse(variants);
      const variantImages = req.files['variantImages'] || [];
      for (let i = 0; i < variantData.length; i++) {
        const v = variantData[i];
        let variantImage = null;
        if (variantImages[i]) {
          variantImage = await uploadToCloudinary(variantImages[i].path);
          fs.unlink(variantImages[i].path, (err) => { if (err) console.error('Failed to delete local file:', err); });
        }
        await pool.query(
          `INSERT INTO product_variants (product_id, name, price, stock, image, color_code)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [product.id, v.name, v.price || price, v.stock || 0, variantImage, v.color_code || null]
        );
      }
    }

    res.json({ success: true, product });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
//  UPDATE PRODUCT
// ============================================================

router.put('/:id', authMiddleware, upload.fields([{ name: 'image' }, { name: 'variantImages' }]), [
  body('name').trim().escape().isLength({ min: 2 }).withMessage('Product name must be at least 2 characters'),
  body('price').trim().escape().isNumeric().withMessage('Price must be a number'),
  body('description').optional().trim().escape(),
  body('category').optional().trim().escape(),
  body('shipping').optional().trim().escape()
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  try {
    const id = parseInt(req.params.id);
    const { name, price, category, contact, rating, badge1, badge2, shipping, isFlashSale, isNewArrival, description,
            shipping_fee, free_shipping_eligible, return_enabled, return_window_days, restocking_fee_percent,
            return_shipping_paid_by, return_condition, variants, old_price, discount_percent, stock, is_featured } = req.body;

    const existing = await pool.query('SELECT * FROM products WHERE id = $1', [id]);
    if (existing.rows.length === 0) return res.status(404).json({ error: 'Product not found' });
    const oldProduct = existing.rows[0];

    let image = oldProduct.image;
    if (req.files['image']) {
      const file = req.files['image'][0];
      image = await uploadToCloudinary(file.path);
      fs.unlink(file.path, (err) => { if (err) console.error('Failed to delete local file:', err); });
    }

    const result = await pool.query(`
      UPDATE products
      SET name = $1, price = $2, old_price = $3, discount_percent = $4, category = $5,
          contact = $6, rating = $7, badge1 = $8, badge2 = $9, shipping = $10,
          isFlashSale = $11, isNewArrival = $12, image = $13, description = $14,
          shipping_fee = $15, free_shipping_eligible = $16,
          return_enabled = $17, return_window_days = $18, restocking_fee_percent = $19,
          return_shipping_paid_by = $20, return_condition = $21, stock = $22,
          is_featured = COALESCE($23, is_featured)
      WHERE id = $24 RETURNING *
    `, [name, price, old_price || null, discount_percent || null, category,
        contact, rating, badge1, badge2, shipping,
        isFlashSale === 'true', isNewArrival === 'true', image, description,
        shipping_fee, free_shipping_eligible === 'true',
        return_enabled !== 'false', return_window_days || 14, restocking_fee_percent || 0,
        return_shipping_paid_by || 'buyer', return_condition || 'unopened', stock || 0,
        is_featured === 'true', id]);

    const product = result.rows[0];

    if (variants && typeof variants === 'string') {
      await pool.query('DELETE FROM product_variants WHERE product_id = $1', [id]);
      const variantData = JSON.parse(variants);
      const variantImages = req.files['variantImages'] || [];
      for (let i = 0; i < variantData.length; i++) {
        const v = variantData[i];
        let variantImage = null;
        if (variantImages[i]) {
          variantImage = await uploadToCloudinary(variantImages[i].path);
          fs.unlink(variantImages[i].path, (err) => { if (err) console.error('Failed to delete local file:', err); });
        }
        await pool.query(
          `INSERT INTO product_variants (product_id, name, price, stock, image, color_code)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [product.id, v.name, v.price || price, v.stock || 0, variantImage, v.color_code || null]
        );
      }
    }

    res.json({ success: true, product });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
//  DELETE PRODUCT
// ============================================================

router.delete('/:id', authMiddleware, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    await pool.query('DELETE FROM product_variants WHERE product_id = $1', [id]);
    await pool.query('DELETE FROM products WHERE id = $1', [id]);
    await logAdminActivity(req.userId, 'DELETE_PRODUCT', { productId: id });
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
//  PRODUCT REVIEWS
// ============================================================

router.post('/:id/review', authMiddleware, [
  body('rating').isInt({ min: 1, max: 5 }).withMessage('Rating must be 1-5'),
  body('review_text').trim().escape().isLength({ min: 3 }).withMessage('Review must be at least 3 characters')
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  if (req.role !== 'customer') {
    return res.status(403).json({ error: 'Only customers can write reviews.' });
  }
  const productId = parseInt(req.params.id);
  const { rating, review_text } = req.body;
  try {
    const existing = await pool.query(
      'SELECT id FROM product_reviews WHERE product_id = $1 AND customer_id = $2',
      [productId, req.userId]
    );
    if (existing.rows.length > 0) {
      return res.status(400).json({ error: 'You have already reviewed this product.' });
    }
    await pool.query(
      'INSERT INTO product_reviews (product_id, customer_id, rating, review_text) VALUES ($1, $2, $3, $4)',
      [productId, req.userId, rating, review_text]
    );
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
//  WISHLIST
// ============================================================

router.post('/wishlist', authMiddleware, async (req, res) => {
  const { product_id } = req.body;
  if (!product_id) return res.status(400).json({ error: 'Product ID required' });
  try {
    const existing = await pool.query(
      'SELECT id FROM wishlist WHERE customer_id = $1 AND product_id = $2',
      [req.userId, product_id]
    );
    if (existing.rows.length > 0) {
      await pool.query('DELETE FROM wishlist WHERE id = $1', [existing.rows[0].id]);
      return res.json({ success: true, action: 'removed' });
    }
    await pool.query(
      'INSERT INTO wishlist (customer_id, product_id) VALUES ($1, $2)',
      [req.userId, product_id]
    );
    res.json({ success: true, action: 'added' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/wishlist', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT w.*, p.name, p.price, p.image
      FROM wishlist w
      JOIN products p ON w.product_id = p.id
      WHERE w.customer_id = $1
      ORDER BY w.created_at DESC
    `, [req.userId]);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;