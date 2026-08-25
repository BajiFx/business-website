// ============================================================
//  CUSTOMER MODEL
// ============================================================

const { pool } = require('../config/database');
const bcrypt = require('bcrypt');

class Customer {
  /**
   * Find customer by ID
   */
  static async findById(id) {
    const result = await pool.query(
      'SELECT id, name, email, phone, created_at, last_login_at FROM customers WHERE id = $1',
      [id]
    );
    return result.rows[0] || null;
  }

  /**
   * Find customer by email
   */
  static async findByEmail(email) {
    const result = await pool.query(
      'SELECT * FROM customers WHERE email = $1',
      [email]
    );
    return result.rows[0] || null;
  }

  /**
   * Find customer by phone
   */
  static async findByPhone(phone) {
    const result = await pool.query(
      'SELECT * FROM customers WHERE phone = $1',
      [phone]
    );
    return result.rows[0] || null;
  }

  /**
   * Create new customer
   */
  static async create({ name, email, phone, password }) {
    const hashedPassword = await bcrypt.hash(password, 10);
    const result = await pool.query(
      `INSERT INTO customers (name, email, phone, password) 
       VALUES ($1, $2, $3, $4) 
       RETURNING id, name, email, phone, created_at`,
      [name, email, phone, hashedPassword]
    );
    
    // Create cart for new customer
    await pool.query(
      'INSERT INTO carts (customer_id, items) VALUES ($1, $2)',
      [result.rows[0].id, '[]']
    );
    
    return result.rows[0];
  }

  /**
   * Update customer profile
   */
  static async update(id, data) {
    const { name, email, phone } = data;
    const result = await pool.query(
      `UPDATE customers 
       SET name = COALESCE($1, name), 
           email = COALESCE($2, email), 
           phone = COALESCE($3, phone) 
       WHERE id = $4 
       RETURNING id, name, email, phone, created_at`,
      [name, email, phone, id]
    );
    return result.rows[0] || null;
  }

  /**
   * Update password
   */
  static async updatePassword(id, newPassword) {
    const hashedPassword = await bcrypt.hash(newPassword, 10);
    const result = await pool.query(
      'UPDATE customers SET password = $1 WHERE id = $2 RETURNING id',
      [hashedPassword, id]
    );
    return result.rows[0] || null;
  }

  /**
   * Verify password
   */
  static async verifyPassword(customer, password) {
    return bcrypt.compare(password, customer.password);
  }

  /**
   * Update last login
   */
  static async updateLastLogin(id) {
    await pool.query(
      'UPDATE customers SET last_login_at = NOW() WHERE id = $1',
      [id]
    );
  }

  /**
   * Delete customer account (cascades to all related data)
   */
  static async delete(id) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      
      // Delete order items
      await client.query(
        `DELETE FROM order_items WHERE order_id IN (SELECT id FROM orders WHERE customer_id = $1)`,
        [id]
      );
      
      // Delete order chat messages
      await client.query(
        `DELETE FROM order_chat_messages WHERE order_id IN (SELECT id FROM orders WHERE customer_id = $1)`,
        [id]
      );
      
      // Delete orders
      await client.query('DELETE FROM orders WHERE customer_id = $1', [id]);
      
      // Delete cart
      await client.query('DELETE FROM carts WHERE customer_id = $1', [id]);
      
      // Delete addresses
      await client.query('DELETE FROM customer_addresses WHERE customer_id = $1', [id]);
      
      // Delete wishlist
      await client.query('DELETE FROM wishlist WHERE customer_id = $1', [id]);
      
      // Delete returns
      await client.query('DELETE FROM returns WHERE customer_id = $1', [id]);
      
      // Delete reviews
      await client.query('DELETE FROM product_reviews WHERE customer_id = $1', [id]);
      
      // Delete payments
      await client.query('DELETE FROM payments WHERE customer_id = $1', [id]);
      
      // Delete location requests
      await client.query('DELETE FROM location_requests WHERE customer_id = $1', [id]);
      
      // Delete chat messages
      await client.query('DELETE FROM chat_messages WHERE customer_id = $1', [id]);
      
      // Delete notifications
      await client.query('DELETE FROM notifications WHERE customer_id = $1', [id]);
      
      // Delete customer
      const result = await client.query(
        'DELETE FROM customers WHERE id = $1 RETURNING id',
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
   * Get customer statistics
   */
  static async getStats(id) {
    const result = await pool.query(`
      SELECT 
        (SELECT COUNT(*) FROM orders WHERE customer_id = $1) as total_orders,
        (SELECT SUM(total) FROM orders WHERE customer_id = $1 AND status IN ('confirmed', 'shipped', 'delivered', 'received', 'completed')) as total_spent,
        (SELECT COUNT(*) FROM orders WHERE customer_id = $1 AND status = 'pending') as pending_orders,
        (SELECT COUNT(*) FROM wishlist WHERE customer_id = $1) as wishlist_count
    `, [id]);
    return result.rows[0];
  }

  /**
   * Get all customers (admin)
   */
  static async findAll(limit = 50, offset = 0) {
    const result = await pool.query(`
      SELECT 
        id, name, email, phone, created_at,
        (SELECT COUNT(*) FROM orders WHERE customer_id = customers.id) as order_count,
        (SELECT SUM(total) FROM orders WHERE customer_id = customers.id AND status IN ('confirmed', 'shipped', 'delivered', 'received', 'completed')) as total_spent
      FROM customers
      ORDER BY created_at DESC
      LIMIT $1 OFFSET $2
    `, [limit, offset]);
    return result.rows;
  }

  /**
   * Count total customers
   */
  static async count() {
    const result = await pool.query('SELECT COUNT(*) FROM customers');
    return parseInt(result.rows[0].count);
  }

  /**
   * Search customers
   */
  static async search(query, limit = 20) {
    const result = await pool.query(`
      SELECT id, name, email, phone, created_at
      FROM customers
      WHERE name ILIKE $1 OR email ILIKE $1 OR phone ILIKE $1
      ORDER BY created_at DESC
      LIMIT $2
    `, [`%${query}%`, limit]);
    return result.rows;
  }
}

module.exports = Customer;