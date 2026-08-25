// ============================================================
//  ORDER MODEL
// ============================================================

const { pool } = require('../config/database');
const { generateOrderRef } = require('../utils/helpers');

class Order {
  /**
   * Find order by ID
   */
  static async findById(id) {
    const result = await pool.query(`
      SELECT o.*, c.name AS customer_name, c.email AS customer_email
      FROM orders o
      JOIN customers c ON o.customer_id = c.id
      WHERE o.id = $1
    `, [id]);
    return result.rows[0] || null;
  }

  /**
   * Find order by reference
   */
  static async findByRef(orderRef) {
    const result = await pool.query(`
      SELECT o.*, c.name AS customer_name, c.email AS customer_email
      FROM orders o
      JOIN customers c ON o.customer_id = c.id
      WHERE o.order_ref = $1
    `, [orderRef]);
    return result.rows[0] || null;
  }

  /**
   * Get orders for a customer
   */
  static async findByCustomer(customerId, limit = 50, offset = 0) {
    const result = await pool.query(`
      SELECT o.*, 
        (SELECT json_agg(oi.*) FROM order_items oi WHERE oi.order_id = o.id) as items
      FROM orders o
      WHERE o.customer_id = $1
      ORDER BY o.created_at DESC
      LIMIT $2 OFFSET $3
    `, [customerId, limit, offset]);
    return result.rows;
  }

  /**
   * Get orders with filters (admin)
   */
  static async findAll({ status, search, startDate, endDate, limit = 50, offset = 0 }) {
    let query = `
      SELECT o.*, c.name AS customer_name, c.email AS customer_email,
      (SELECT json_agg(oi.*) FROM order_items oi WHERE oi.order_id = o.id) as items
      FROM orders o
      JOIN customers c ON o.customer_id = c.id
    `;
    const params = [];
    const conditions = [];
    let paramIndex = 1;

    if (status && status !== 'all') {
      conditions.push(`o.status = $${paramIndex}`);
      params.push(status);
      paramIndex++;
    }

    if (search) {
      conditions.push(`(c.name ILIKE $${paramIndex} OR c.email ILIKE $${paramIndex} OR o.order_ref ILIKE $${paramIndex})`);
      params.push(`%${search}%`);
      paramIndex++;
    }

    if (startDate) {
      conditions.push(`o.created_at >= $${paramIndex}`);
      params.push(startDate);
      paramIndex++;
    }

    if (endDate) {
      conditions.push(`o.created_at <= $${paramIndex}`);
      params.push(endDate + ' 23:59:59');
      paramIndex++;
    }

    if (conditions.length > 0) {
      query += ' WHERE ' + conditions.join(' AND ');
    }

    query += ' ORDER BY o.created_at DESC';
    query += ` LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
    params.push(limit, offset);

    const result = await pool.query(query, params);
    return result.rows;
  }

  /**
   * Count orders with filters
   */
  static async count({ status, search, startDate, endDate }) {
    let query = `
      SELECT COUNT(*) 
      FROM orders o
      JOIN customers c ON o.customer_id = c.id
    `;
    const params = [];
    const conditions = [];
    let paramIndex = 1;

    if (status && status !== 'all') {
      conditions.push(`o.status = $${paramIndex}`);
      params.push(status);
      paramIndex++;
    }

    if (search) {
      conditions.push(`(c.name ILIKE $${paramIndex} OR c.email ILIKE $${paramIndex} OR o.order_ref ILIKE $${paramIndex})`);
      params.push(`%${search}%`);
      paramIndex++;
    }

    if (startDate) {
      conditions.push(`o.created_at >= $${paramIndex}`);
      params.push(startDate);
      paramIndex++;
    }

    if (endDate) {
      conditions.push(`o.created_at <= $${paramIndex}`);
      params.push(endDate + ' 23:59:59');
      paramIndex++;
    }

    if (conditions.length > 0) {
      query += ' WHERE ' + conditions.join(' AND ');
    }

    const result = await pool.query(query, params);
    return parseInt(result.rows[0].count);
  }

  /**
   * Create new order
   */
  static async create(data) {
    const {
      customerId,
      total,
      items,
      shipping_tier = 'standard',
      shipping_cost = 0,
      order_notes = null,
      promo_code = null,
      discount_applied = 0,
      delivery_address = null,
      recipient_name = null,
      recipient_phone = null,
      delivery_instructions = null,
      customer_lat = null,
      customer_lng = null,
      location_accuracy = null,
      urgent_delivery = false
    } = data;

    // Generate unique order reference
    let orderRef;
    let unique = false;
    while (!unique) {
      orderRef = generateOrderRef();
      const check = await pool.query('SELECT id FROM orders WHERE order_ref = $1', [orderRef]);
      if (check.rows.length === 0) unique = true;
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Insert order
      const orderResult = await client.query(`
        INSERT INTO orders (
          customer_id, total, status, order_ref, status_history,
          shipping_tier, shipping_cost, order_notes, promo_code, discount_applied,
          delivery_address, recipient_name, recipient_phone, delivery_instructions,
          customer_lat, customer_lng, location_accuracy, location_detected_at,
          urgent_delivery, payment_status
        )
        VALUES ($1, $2, 'pending_payment', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, NOW(), $17, 'pending')
        RETURNING *
      `, [
        customerId, total, orderRef,
        JSON.stringify([{ status: 'pending_payment', timestamp: new Date().toISOString() }]),
        shipping_tier, shipping_cost,
        order_notes, promo_code, discount_applied,
        delivery_address, recipient_name, recipient_phone, delivery_instructions,
        customer_lat, customer_lng, location_accuracy,
        urgent_delivery
      ]);

      const order = orderResult.rows[0];

      // Insert order items
      for (const item of items) {
        const uniqueId = generateOrderRef();
        await client.query(`
          INSERT INTO order_items (
            order_id, product_id, product_name, price, quantity, image, 
            unique_id, variant_name, variant_id
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        `, [
          order.id, item.productId || 0, item.name, item.price, item.quantity, 
          item.image || '', uniqueId, item.variant_name || 'Default', item.variant_id || null
        ]);
      }

      // Clear cart
      await client.query(
        'UPDATE carts SET items = $1, reserved_until = NULL WHERE customer_id = $2',
        ['[]', customerId]
      );

      await client.query('COMMIT');
      return order;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Update order status
   */
  static async updateStatus(id, status, note = '') {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const result = await client.query(
        'UPDATE orders SET status = $1, updated_at = NOW() WHERE id = $2 RETURNING *',
        [status, id]
      );

      // Append to status history
      let history = result.rows[0]?.status_history || [];
      if (typeof history === 'string') history = JSON.parse(history);
      history.push({
        status,
        timestamp: new Date().toISOString(),
        note
      });

      await client.query(
        'UPDATE orders SET status_history = $1 WHERE id = $2',
        [JSON.stringify(history), id]
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
   * Mark order as shipped
   */
  static async markShipped(id, trackingNumber) {
    const result = await pool.query(`
      UPDATE orders 
      SET status = 'shipped', 
          shipped_at = NOW(), 
          tracking_number = $1, 
          updated_at = NOW() 
      WHERE id = $2 
      RETURNING *
    `, [trackingNumber, id]);
    return result.rows[0] || null;
  }

  /**
   * Mark order as delivered
   */
  static async markDelivered(id) {
    const result = await pool.query(`
      UPDATE orders 
      SET status = 'delivered', 
          delivered_at = NOW(), 
          updated_at = NOW() 
      WHERE id = $1 
      RETURNING *
    `, [id]);
    return result.rows[0] || null;
  }

  /**
   * Mark order as received
   */
  static async markReceived(id) {
    const result = await pool.query(`
      UPDATE orders 
      SET status = 'received', 
          received_at = NOW(), 
          updated_at = NOW() 
      WHERE id = $1 
      RETURNING *
    `, [id]);
    return result.rows[0] || null;
  }

  /**
   * Cancel order
   */
  static async cancel(id, reason, cancelledBy = 'customer') {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const result = await client.query(`
        UPDATE orders 
        SET status = 'cancelled', 
            cancelled_at = NOW(), 
            cancelled_by = $1, 
            updated_at = NOW() 
        WHERE id = $2 
        RETURNING *
      `, [cancelledBy, id]);

      // Restock items
      const items = await client.query(
        'SELECT product_id, quantity, variant_id FROM order_items WHERE order_id = $1',
        [id]
      );

      for (const item of items.rows) {
        if (item.variant_id) {
          await client.query(
            'UPDATE product_variants SET stock = stock + $1 WHERE id = $2',
            [item.quantity, item.variant_id]
          );
        } else {
          await client.query(
            'UPDATE products SET stock = stock + $1 WHERE id = $2',
            [item.quantity, item.product_id]
          );
        }
      }

      // Append to status history
      let history = result.rows[0]?.status_history || [];
      if (typeof history === 'string') history = JSON.parse(history);
      history.push({
        status: 'cancelled',
        timestamp: new Date().toISOString(),
        note: `Cancelled by ${cancelledBy}. Reason: ${reason}`
      });

      await client.query(
        'UPDATE orders SET status_history = $1 WHERE id = $2',
        [JSON.stringify(history), id]
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
   * Request refund
   */
  static async requestRefund(id, reason) {
    const result = await pool.query(`
      UPDATE orders 
      SET refund_request = $1, 
          refund_status = 'pending', 
          updated_at = NOW() 
      WHERE id = $2 
      RETURNING *
    `, [reason, id]);
    return result.rows[0] || null;
  }

  /**
   * Process refund (admin)
   */
  static async processRefund(id, action) {
    const status = action === 'approve' ? 'approved' : 'rejected';
    const result = await pool.query(`
      UPDATE orders 
      SET refund_status = $1, 
          updated_at = NOW() 
      WHERE id = $2 
      RETURNING *
    `, [status, id]);
    return result.rows[0] || null;
  }

  /**
   * Get order status history
   */
  static async getStatusHistory(id) {
    const result = await pool.query(
      'SELECT status_history FROM orders WHERE id = $1',
      [id]
    );
    if (result.rows.length === 0) return [];
    let history = result.rows[0].status_history;
    if (typeof history === 'string') history = JSON.parse(history);
    return history || [];
  }

  /**
   * Get order items
   */
  static async getItems(id) {
    const result = await pool.query(
      'SELECT * FROM order_items WHERE order_id = $1 ORDER BY id',
      [id]
    );
    return result.rows;
  }

  /**
   * Get order statistics (dashboard)
   */
  static async getStats() {
    const result = await pool.query(`
      SELECT 
        COUNT(*) as total_orders,
        SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending,
        SUM(CASE WHEN status = 'confirmed' THEN 1 ELSE 0 END) as confirmed,
        SUM(CASE WHEN status = 'shipped' THEN 1 ELSE 0 END) as shipped,
        SUM(CASE WHEN status = 'delivered' THEN 1 ELSE 0 END) as delivered,
        SUM(CASE WHEN status = 'received' THEN 1 ELSE 0 END) as received,
        SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) as cancelled,
        SUM(CASE WHEN status = 'pending_payment' THEN 1 ELSE 0 END) as pending_payment,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
        SUM(total) as total_revenue
      FROM orders
    `);
    return result.rows[0];
  }

  /**
   * Get replacement orders
   */
  static async getReplacements(status = 'pending') {
    const result = await pool.query(`
      SELECT o.*, c.name AS customer_name, c.email AS customer_email
      FROM orders o
      JOIN customers c ON o.customer_id = c.id
      WHERE o.replacement_status = $1
      ORDER BY o.created_at DESC
    `, [status]);
    return result.rows;
  }

  /**
   * Get refund requests
   */
  static async getRefundRequests(status = 'pending') {
    const result = await pool.query(`
      SELECT o.*, c.name AS customer_name, c.email AS customer_email
      FROM orders o
      JOIN customers c ON o.customer_id = c.id
      WHERE o.refund_status = $1
      ORDER BY o.created_at DESC
    `, [status]);
    return result.rows;
  }
}

module.exports = Order;