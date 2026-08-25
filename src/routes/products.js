// ============================================================
//  PRODUCTS ROUTES - Complete Fixed Version
//  Location: D:\my-business-website\src\routes\products.js
// ============================================================

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
//  GET ALL PRODUCTS - FIXED
// ============================================================

router.get('/', cacheMiddleware(60), async (req, res) => {
  try {
    const { search, limit, category } = req.query;
    let query = 'SELECT * FROM products';
    let params = [];
    let conditions = [];
    let paramIndex = 1;
    
    if (search) {
      conditions.push('name ILIKE $' + paramIndex);
      params.push(`%${search}%`);
      paramIndex++;
    }
    if (category && category !== 'all') {
      conditions.push('category = $' + paramIndex);
      params.push(category);
      paramIndex++;
    }
    if (conditions.length > 0) {
      query += ' WHERE ' + conditions.join(' AND ');
    }
    query += ' ORDER BY created_at DESC';
    if (limit) {
      query += ' LIMIT $' + paramIndex;
      params.push(parseInt(limit));
      paramIndex++;
    }
    
    const result = await pool.query(query, params);
    
    // Get variants for each product
    const products = [];
    for (const product of result.rows) {
      try {
        const variantsResult = await pool.query(
          'SELECT * FROM product_variants WHERE product_id = $1 ORDER BY id',
          [product.id]
        );
        const variants = variantsResult.rows || [];
        
        // Get first image from variants or use product image
        let firstImage = null;
        if (variants.length > 0 && variants[0].image) {
          firstImage = variants[0].image;
        } else if (product.image) {
          firstImage = product.image;
        }
        
        // Calculate total stock
        let totalStock = 0;
        variants.forEach(v => { totalStock += parseInt(v.stock) || 0; });
        
        products.push({
          ...product,
          variants: variants,
          image: firstImage || product.image || null,
          stock: totalStock || parseInt(product.stock) || 0
        });
      } catch (variantErr) {
        console.error('Error fetching variants for product:', product.id, variantErr);
        // Still return the product without variants
        products.push({
          ...product,
          variants: [],
          image: product.image || null,
          stock: parseInt(product.stock) || 0
        });
      }
    }
    
    res.json(products);
  } catch (err) {
    console.error('❌ Products error:', err);
    res.status(500).json({ 
      error: err.message,
      details: process.env.NODE_ENV === 'development' ? err.stack : undefined
    });
  }
});

// ============================================================
//  GET ALL VARIANTS (Batch)
// ============================================================

router.get('/variants/batch', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM product_variants ORDER BY product_id, id');
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Variants batch error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
//  GET PRODUCT DETAIL
// ============================================================

router.get('/:id/detail', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) {
      return res.status(400).json({ error: 'Invalid product ID' });
    }
    
    const productResult = await pool.query('SELECT * FROM products WHERE id = $1', [id]);
    if (productResult.rows.length === 0) {
      return res.status(404).json({ error: 'Product not found' });
    }
    
    const product = productResult.rows[0];
    
    // Get variants
    const variantsResult = await pool.query(
      'SELECT * FROM product_variants WHERE product_id = $1 ORDER BY id',
      [id]
    );
    const variants = variantsResult.rows || [];
    
    // Get reviews
    const reviewsResult = await pool.query(`
      SELECT pr.*, c.name AS customer_name
      FROM product_reviews pr
      LEFT JOIN customers c ON pr.customer_id = c.id
      WHERE pr.product_id = $1
      ORDER BY pr.created_at DESC
      LIMIT 20
    `, [id]);
    const reviews = reviewsResult.rows || [];
    
    // Get related products
    const relatedResult = await pool.query(`
      SELECT * FROM products 
      WHERE id != $1 
      ORDER BY created_at DESC 
      LIMIT 6
    `, [id]);
    
    // Add first variant image to related products
    const related = [];
    for (const rel of relatedResult.rows) {
      const vRes = await pool.query(
        'SELECT image FROM product_variants WHERE product_id = $1 LIMIT 1',
        [rel.id]
      );
      const variant = vRes.rows[0] || null;
      related.push({ 
        ...rel, 
        image: variant ? variant.image : rel.image 
      });
    }
    
    res.json({ 
      product, 
      variants, 
      reviews, 
      related 
    });
  } catch (err) {
    console.error('❌ Product detail error:', err);
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
    const { 
      name, price, category, contact, rating, badge1, badge2, shipping, 
      isFlashSale, isNewArrival, description, shipping_fee, free_shipping_eligible,
      return_enabled, return_window_days, restocking_fee_percent,
      return_shipping_paid_by, return_condition, variants, old_price, 
      discount_percent, stock, is_featured 
    } = req.body;

    let mainImage = null;
    if (req.files && req.files['image'] && req.files['image'][0]) {
      const file = req.files['image'][0];
      mainImage = await uploadToCloudinary(file.path);
      fs.unlink(file.path, (err) => { if (err) console.error('Failed to delete local file:', err); });
    }

    const result = await pool.query(`
      INSERT INTO products (
        name, price, old_price, discount_percent, category, contact, rating, 
        badge1, badge2, shipping, isFlashSale, isNewArrival, image, description,
        shipping_fee, free_shipping_eligible, return_enabled, return_window_days,
        restocking_fee_percent, return_shipping_paid_by, return_condition,
        stock, is_featured
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23)
      RETURNING *
    `, [
      name, price, old_price || null, discount_percent || null, category, contact, rating,
      badge1 || null, badge2 || null, shipping || null, 
      isFlashSale === 'true' || isFlashSale === true, 
      isNewArrival === 'true' || isNewArrival === true,
      mainImage, description || null,
      shipping_fee || null, free_shipping_eligible === 'true' || free_shipping_eligible === true,
      return_enabled !== 'false', return_window_days || 14, restocking_fee_percent || 0,
      return_shipping_paid_by || 'buyer', return_condition || 'unopened',
      stock || 0, is_featured === 'true' || is_featured === true
    ]);

    const product = result.rows[0];

    // Add variants if provided
    if (variants && typeof variants === 'string') {
      try {
        const variantData = JSON.parse(variants);
        const variantImages = (req.files && req.files['variantImages']) || [];
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
      } catch (variantErr) {
        console.error('Error adding variants:', variantErr);
        // Continue - variants are optional
      }
    }

    await logAdminActivity(req.userId, 'CREATE_PRODUCT', { productId: product.id });
    res.json({ success: true, product });
  } catch (err) {
    console.error('❌ Create product error:', err);
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
    if (isNaN(id)) {
      return res.status(400).json({ error: 'Invalid product ID' });
    }

    const existing = await pool.query('SELECT * FROM products WHERE id = $1', [id]);
    if (existing.rows.length === 0) {
      return res.status(404).json({ error: 'Product not found' });
    }
    const oldProduct = existing.rows[0];

    const { 
      name, price, category, contact, rating, badge1, badge2, shipping, 
      isFlashSale, isNewArrival, description, shipping_fee, free_shipping_eligible,
      return_enabled, return_window_days, restocking_fee_percent,
      return_shipping_paid_by, return_condition, variants, old_price, 
      discount_percent, stock, is_featured 
    } = req.body;

    let image = oldProduct.image;
    if (req.files && req.files['image'] && req.files['image'][0]) {
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
    `, [
      name, price, old_price || null, discount_percent || null, category,
      contact, rating, badge1, badge2, shipping,
      isFlashSale === 'true' || isFlashSale === true, 
      isNewArrival === 'true' || isNewArrival === true,
      image, description || null,
      shipping_fee || null, free_shipping_eligible === 'true' || free_shipping_eligible === true,
      return_enabled !== 'false', return_window_days || 14, restocking_fee_percent || 0,
      return_shipping_paid_by || 'buyer', return_condition || 'unopened',
      stock || 0, is_featured === 'true' || is_featured === true, id
    ]);

    const product = result.rows[0];

    // Update variants if provided
    if (variants && typeof variants === 'string') {
      try {
        await pool.query('DELETE FROM product_variants WHERE product_id = $1', [id]);
        const variantData = JSON.parse(variants);
        const variantImages = (req.files && req.files['variantImages']) || [];
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
      } catch (variantErr) {
        console.error('Error updating variants:', variantErr);
      }
    }

    await logAdminActivity(req.userId, 'UPDATE_PRODUCT', { productId: id });
    res.json({ success: true, product });
  } catch (err) {
    console.error('❌ Update product error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
//  DELETE PRODUCT
// ============================================================

router.delete('/:id', authMiddleware, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) {
      return res.status(400).json({ error: 'Invalid product ID' });
    }

    // Delete variants first (cascade will handle it, but do it explicitly)
    await pool.query('DELETE FROM product_variants WHERE product_id = $1', [id]);
    await pool.query('DELETE FROM products WHERE id = $1', [id]);
    
    await logAdminActivity(req.userId, 'DELETE_PRODUCT', { productId: id });
    res.json({ success: true });
  } catch (err) {
    console.error('❌ Delete product error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
//  PRODUCT REVIEWS - ADD REVIEW
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
  if (isNaN(productId)) {
    return res.status(400).json({ error: 'Invalid product ID' });
  }
  
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
    console.error('❌ Review error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
//  WISHLIST
// ============================================================

router.post('/wishlist', authMiddleware, async (req, res) => {
  const { product_id } = req.body;
  if (!product_id) {
    return res.status(400).json({ error: 'Product ID required' });
  }
  
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
    console.error('❌ Wishlist error:', err);
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
    console.error('❌ Wishlist get error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;