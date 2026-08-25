// ============================================================
//  PAYMENT MODEL
// ============================================================

const { pool } = require('../config/database');
const { v4: uuidv4 } = require('uuid');

class Payment {
  /**
   * Find payment by ID
   */
  static async findById(id) {
    const result = await pool.query('SELECT * FROM payments WHERE id = $1', [id]);
    return result.rows[0] || null;
  }

  /**
   * Find payment by transaction ID
   */
  static async findByTransactionId(transactionId) {
    const result = await pool.query(
      'SELECT * FROM payments WHERE transaction_id = $1 OR payment_details->>\'checkoutRequestId\' = $1',
      [transactionId]
    );
    return result.rows[0] || null;
  }

  /**
   * Get payments for an order
   */
  static async findByOrder(orderId) {
    const result = await pool.query(`
      SELECT * FROM payments 
      WHERE order_id = $1 
      ORDER BY created_at DESC
    `, [orderId]);
    return result.rows;
  }

  /**
   * Get payments for a customer
   */
  static async findByCustomer(customerId, limit = 50, offset = 0) {
    const result = await pool.query(`
      SELECT p.*, o.order_ref
      FROM payments p
      LEFT JOIN orders o ON p.order_id = o.id
      WHERE p.customer_id = $1
      ORDER BY p.created_at DESC
      LIMIT $2 OFFSET $3
    `, [customerId, limit, offset]);
    return result.rows;
  }

  /**
   * Create payment record
   */
  static async create(data) {
    const {
      customerId,
      orderId = null,
      amount,
      method,
      status = 'pending',
      transactionId = null,
      paymentDetails = {}
    } = data;

    const result = await pool.query(`
      INSERT INTO payments (
        customer_id, order_id, amount, method, status, 
        transaction_id, payment_details
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING *
    `, [
      customerId,
      orderId,
      amount,
      method,
      status,
      transactionId || uuidv4(),
      JSON.stringify(paymentDetails)
    ]);

    return result.rows[0];
  }

  /**
   * Update payment status
   */
  static async updateStatus(id, status, details = {}) {
    const result = await pool.query(`
      UPDATE payments 
      SET status = $1, 
          payment_details = payment_details || $2,
          updated_at = NOW()
      WHERE id = $3 
      RETURNING *
    `, [status, JSON.stringify(details), id]);
    return result.rows[0] || null;
  }

  /**
   * Update payment by transaction ID
   */
  static async updateByTransactionId(transactionId, data) {
    const { status, details = {} } = data;
    const result = await pool.query(`
      UPDATE payments 
      SET status = $1, 
          payment_details = payment_details || $2,
          updated_at = NOW()
      WHERE transaction_id = $3 OR payment_details->>'checkoutRequestId' = $3
      RETURNING *
    `, [status, JSON.stringify(details), transactionId]);
    return result.rows[0] || null;
  }

  /**
   * Mark payment as success
   */
  static async markSuccess(id, transactionId = null, details = {}) {
    const result = await pool.query(`
      UPDATE payments 
      SET status = 'success', 
          transaction_id = COALESCE($1, transaction_id),
          payment_details = payment_details || $2,
          updated_at = NOW()
      WHERE id = $3 
      RETURNING *
    `, [transactionId, JSON.stringify(details), id]);
    return result.rows[0] || null;
  }

  /**
   * Mark payment as failed
   */
  static async markFailed(id, details = {}) {
    const result = await pool.query(`
      UPDATE payments 
      SET status = 'failed', 
          payment_details = payment_details || $1,
          updated_at = NOW()
      WHERE id = $2 
      RETURNING *
    `, [JSON.stringify(details), id]);
    return result.rows[0] || null;
  }

  /**
   * Get payment statistics
   */
  static async getStats() {
    const result = await pool.query(`
      SELECT 
        COUNT(*) as total,
        SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as successful,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed,
        SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending,
        SUM(CASE WHEN method = 'mpesa' THEN 1 ELSE 0 END) as mpesa_count,
        SUM(CASE WHEN method = 'airtel' THEN 1 ELSE 0 END) as airtel_count,
        SUM(CASE WHEN method = 'paypal' THEN 1 ELSE 0 END) as paypal_count,
        SUM(CASE WHEN method = 'bank' THEN 1 ELSE 0 END) as bank_count,
        SUM(CASE WHEN status = 'success' THEN amount ELSE 0 END) as total_revenue
      FROM payments
    `);
    return result.rows[0];
  }

  /**
   * Get payment by checkout request ID (M-Pesa)
   */
  static async findByCheckoutRequestId(checkoutRequestId) {
    const result = await pool.query(
      `SELECT * FROM payments 
       WHERE transaction_id = $1 OR (payment_details->>'checkoutRequestId' = $1)`,
      [checkoutRequestId]
    );
    return result.rows[0] || null;
  }

  /**
   * Get payments by date range
   */
  static async findByDateRange(startDate, endDate, limit = 100) {
    const result = await pool.query(`
      SELECT * FROM payments 
      WHERE created_at >= $1 AND created_at <= $2
      ORDER BY created_at DESC
      LIMIT $3
    `, [startDate, endDate, limit]);
    return result.rows;
  }

  /**
   * Get recent payments
   */
  static async getRecent(limit = 20) {
    const result = await pool.query(`
      SELECT p.*, o.order_ref, c.name AS customer_name
      FROM payments p
      LEFT JOIN orders o ON p.order_id = o.id
      LEFT JOIN customers c ON p.customer_id = c.id
      ORDER BY p.created_at DESC
      LIMIT $1
    `, [limit]);
    return result.rows;
  }

  /**
   * Get payment totals by method
   */
  static async getTotalsByMethod() {
    const result = await pool.query(`
      SELECT 
        method,
        COUNT(*) as count,
        SUM(amount) as total_amount,
        SUM(CASE WHEN status = 'success' THEN amount ELSE 0 END) as successful_amount
      FROM payments
      GROUP BY method
    `);
    return result.rows;
  }

  /**
   * Check if payment exists for order
   */
  static async existsForOrder(orderId) {
    const result = await pool.query(
      'SELECT COUNT(*) FROM payments WHERE order_id = $1 AND status = $2',
      [orderId, 'success']
    );
    return parseInt(result.rows[0].count) > 0;
  }

  /**
   * Delete payment (admin only)
   */
  static async delete(id) {
    const result = await pool.query(
      'DELETE FROM payments WHERE id = $1 RETURNING id',
      [id]
    );
    return result.rows[0] || null;
  }

  /**
   * Get failed payments
   */
  static async getFailed(limit = 50) {
    const result = await pool.query(`
      SELECT p.*, o.order_ref, c.name AS customer_name
      FROM payments p
      LEFT JOIN orders o ON p.order_id = o.id
      LEFT JOIN customers c ON p.customer_id = c.id
      WHERE p.status = 'failed'
      ORDER BY p.created_at DESC
      LIMIT $1
    `, [limit]);
    return result.rows;
  }

  /**
   * Get pending payments
   */
  static async getPending(limit = 50) {
    const result = await pool.query(`
      SELECT p.*, o.order_ref, c.name AS customer_name
      FROM payments p
      LEFT JOIN orders o ON p.order_id = o.id
      LEFT JOIN customers c ON p.customer_id = c.id
      WHERE p.status = 'pending'
      ORDER BY p.created_at DESC
      LIMIT $1
    `, [limit]);
    return result.rows;
  }
}

module.exports = Payment;