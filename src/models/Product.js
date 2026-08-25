// ============================================================
//  PRODUCT MODEL
// ============================================================

const { pool } = require('../config/database');

class Product {
  /**
   * Find product by ID
   */
  static async findById(id) {
    const result = await pool.query('SELECT * FROM products WHERE id = $1', [id]);
    return result.rows[0] || null;
  }

  /**
   * Find product with variants and reviews
   */
  static async findDetail(id) {
    const product = await this.findById(id);
    if (!product) return null;

    const variants = await pool.query(
      'SELECT * FROM product_variants WHERE product_id = $1 ORDER BY id',
      [id]
    );

    const reviews = await pool.query(`
      SELECT pr.*, c.name AS customer_name
      FROM product_reviews pr
      JOIN customers c ON pr.customer_id = c.id
      WHERE pr.product_id = $1
      ORDER BY pr.created_at DESC
    `, [id]);

    const related = await pool.query(`
      SELECT * FROM products 
      WHERE id != $1 
      ORDER BY created_at DESC 
      LIMIT 6
    `, [id]);

    return {
      product,
      variants: variants.rows,
      reviews: reviews.rows,
      related: related.rows
    };
  }

  /**
   * Get all products with variants
   */
  static async findAll({ search, category, limit = 50, offset = 0, featured = false }) {
    let query = 'SELECT * FROM products';
    const params = [];
    const conditions = [];
    let paramIndex = 1;

    if (search) {
      conditions.push(`name ILIKE $${paramIndex}`);
      params.push(`%${search}%`);
      paramIndex++;
    }

    if (category && category !== 'all') {
      conditions.push(`category = $${paramIndex}`);
      params.push(category);
      paramIndex++;
    }

    if (featured) {
      conditions.push(`is_featured = true`);
    }

    if (conditions.length > 0) {
      query += ' WHERE ' + conditions.join(' AND ');
    }

    query += ' ORDER BY created_at DESC';
    query += ` LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
    params.push(limit, offset);

    const result = await pool.query(query, params);
    return result.rows;
  }

  /**
   * Get products with variants and stock info
   */
  static async findAllWithVariants({ search, category, limit = 50, offset = 0 }) {
    const products = await this.findAll({ search, category, limit, offset });
    
    const result = [];
    for (const product of products) {
      const variants = await pool.query(
        'SELECT * FROM product_variants WHERE product_id = $1 ORDER BY id',
        [product.id]
      );
      
      let totalStock = 0;
      variants.rows.forEach(v => { totalStock += v.stock || 0; });
      
      result.push({
        ...product,
        variants: variants.rows,
        stock: totalStock || product.stock || 0
      });
    }
    
    return result;
  }

  /**
   * Create product
   */
  static async create(data) {
    const {
      name, price, old_price, discount_percent, category, contact, rating,
      badge1, badge2, shipping, isFlashSale, isNewArrival, image, description,
      shipping_fee, free_shipping_eligible, return_enabled, return_window_days,
      restocking_fee_percent, return_shipping_paid_by, return_condition,
      stock = 0, is_featured = false
    } = data;

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
      badge1 || null, badge2 || null, shipping || null, isFlashSale || false, isNewArrival || false,
      image || null, description || null,
      shipping_fee || null, free_shipping_eligible || false, return_enabled !== false,
      return_window_days || 14, restocking_fee_percent || 0,
      return_shipping_paid_by || 'buyer', return_condition || 'unopened',
      stock || 0, is_featured || false
    ]);

    return result.rows[0];
  }

  /**
   * Update product
   */
  static async update(id, data) {
    const fields = [];
    const params = [];
    let paramIndex = 1;

    const allowedFields = [
      'name', 'price', 'old_price', 'discount_percent', 'category', 'contact',
      'rating', 'badge1', 'badge2', 'shipping', 'isFlashSale', 'isNewArrival',
      'image', 'description', 'shipping_fee', 'free_shipping_eligible',
      'return_enabled', 'return_window_days', 'restocking_fee_percent',
      'return_shipping_paid_by', 'return_condition', 'stock', 'is_featured'
    ];

    for (const field of allowedFields) {
      if (data[field] !== undefined) {
        fields.push(`${field} = $${paramIndex}`);
        params.push(data[field]);
        paramIndex++;
      }
    }

    if (fields.length === 0) return null;

    params.push(id);
    const query = `
      UPDATE products 
      SET ${fields.join(', ')} 
      WHERE id = $${paramIndex} 
      RETURNING *
    `;

    const result = await pool.query(query, params);
    return result.rows[0] || null;
  }

  /**
   * Delete product
   */
  static async delete(id) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      
      // Delete variants first
      await client.query('DELETE FROM product_variants WHERE product_id = $1', [id]);
      
      // Delete product
      const result = await client.query(
        'DELETE FROM products WHERE id = $1 RETURNING id',
        [id]
      );
      
      await client.query('COMMIT');
      return result.rows[0] || null;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Add variant to product
   */
  static async addVariant(productId, variantData) {
    const { name, price, stock = 0, image, color_code } = variantData;
    const result = await pool.query(`
      INSERT INTO product_variants (product_id, name, price, stock, image, color_code)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *
    `, [productId, name, price || null, stock, image || null, color_code || null]);
    return result.rows[0];
  }

  /**
   * Update variant
   */
  static async updateVariant(variantId, data) {
    const fields = [];
    const params = [];
    let paramIndex = 1;

    const allowedFields = ['name', 'price', 'stock', 'image', 'color_code'];

    for (const field of allowedFields) {
      if (data[field] !== undefined) {
        fields.push(`${field} = $${paramIndex}`);
        params.push(data[field]);
        paramIndex++;
      }
    }

    if (fields.length === 0) return null;

    params.push(variantId);
    const query = `
      UPDATE product_variants 
      SET ${fields.join(', ')} 
      WHERE id = $${paramIndex} 
      RETURNING *
    `;

    const result = await pool.query(query, params);
    return result.rows[0] || null;
  }

  /**
   * Delete variant
   */
  static async deleteVariant(variantId) {
    const result = await pool.query(
      'DELETE FROM product_variants WHERE id = $1 RETURNING id',
      [variantId]
    );
    return result.rows[0] || null;
  }

  /**
   * Get product variants
   */
  static async getVariants(productId) {
    const result = await pool.query(
      'SELECT * FROM product_variants WHERE product_id = $1 ORDER BY id',
      [productId]
    );
    return result.rows;
  }

  /**
   * Add review to product
   */
  static async addReview(productId, customerId, rating, reviewText) {
    const result = await pool.query(`
      INSERT INTO product_reviews (product_id, customer_id, rating, review_text)
      VALUES ($1, $2, $3, $4)
      RETURNING *
    `, [productId, customerId, rating, reviewText]);
    return result.rows[0];
  }

  /**
   * Get product reviews
   */
  static async getReviews(productId, limit = 20) {
    const result = await pool.query(`
      SELECT pr.*, c.name AS customer_name
      FROM product_reviews pr
      JOIN customers c ON pr.customer_id = c.id
      WHERE pr.product_id = $1
      ORDER BY pr.created_at DESC
      LIMIT $2
    `, [productId, limit]);
    return result.rows;
  }

  /**
   * Get product rating average
   */
  static async getRating(productId) {
    const result = await pool.query(`
      SELECT 
        AVG(rating) as average,
        COUNT(*) as count
      FROM product_reviews
      WHERE product_id = $1
    `, [productId]);
    return {
      average: parseFloat(result.rows[0].average) || 0,
      count: parseInt(result.rows[0].count) || 0
    };
  }

  /**
   * Check stock availability
   */
  static async checkStock(productId, quantity, variantId = null) {
    if (variantId) {
      const result = await pool.query(
        'SELECT stock FROM product_variants WHERE id = $1',
        [variantId]
      );
      if (result.rows.length === 0) return false;
      return result.rows[0].stock >= quantity;
    } else {
      const result = await pool.query(
        'SELECT stock FROM products WHERE id = $1',
        [productId]
      );
      if (result.rows.length === 0) return false;
      return result.rows[0].stock >= quantity;
    }
  }

  /**
   * Decrement stock
   */
  static async decrementStock(productId, quantity, variantId = null) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      if (variantId) {
        const result = await client.query(
          'UPDATE product_variants SET stock = stock - $1 WHERE id = $2 AND stock >= $1 RETURNING *',
          [quantity, variantId]
        );
        if (result.rows.length === 0) throw new Error('Insufficient stock');
      } else {
        const result = await client.query(
          'UPDATE products SET stock = stock - $1 WHERE id = $2 AND stock >= $1 RETURNING *',
          [quantity, productId]
        );
        if (result.rows.length === 0) throw new Error('Insufficient stock');
      }

      await client.query('COMMIT');
      return true;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Increment stock (restock)
   */
  static async incrementStock(productId, quantity, variantId = null) {
    if (variantId) {
      await pool.query(
        'UPDATE product_variants SET stock = stock + $1 WHERE id = $2',
        [quantity, variantId]
      );
    } else {
      await pool.query(
        'UPDATE products SET stock = stock + $1 WHERE id = $2',
        [quantity, productId]
      );
    }
    return true;
  }

  /**
   * Get low stock products
   */
  static async getLowStock(threshold = 10, limit = 20) {
    const result = await pool.query(`
      SELECT id, name, stock FROM products 
      WHERE stock < $1 
      ORDER BY stock ASC 
      LIMIT $2
    `, [threshold, limit]);
    return result.rows;
  }

  /**
   * Get categories with counts
   */
  static async getCategories() {
    const result = await pool.query(`
      SELECT category, COUNT(*) as count
      FROM products
      WHERE category IS NOT NULL AND category != ''
      GROUP BY category
      ORDER BY category ASC
    `);
    return result.rows;
  }

  /**
   * Search products
   */
  static async search(query, limit = 20) {
    const result = await pool.query(`
      SELECT * FROM products
      WHERE name ILIKE $1 OR description ILIKE $1 OR category ILIKE $1
      ORDER BY created_at DESC
      LIMIT $2
    `, [`%${query}%`, limit]);
    return result.rows;
  }
}

module.exports = Product;