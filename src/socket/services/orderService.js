// ================================================================
//  ORDER SERVICE - Business Logic for Orders
// ================================================================

const { pool, logError } = require('../config/database');
const { generateOrderRef, calculateShippingCost } = require('../utils/helpers');

/**
 * Append a new status to the order's status history
 */
async function appendOrderStatus(orderId, status, note = '') {
  try {
    const result = await pool.query('SELECT status_history FROM orders WHERE id = $1', [orderId]);
    let history = result.rows[0]?.status_history || [];
    if (typeof history === 'string') history = JSON.parse(history);
    
    history.push({
      status,
      timestamp: new Date().toISOString(),
      note
    });
    
    await pool.query('UPDATE orders SET status_history = $1 WHERE id = $2', [JSON.stringify(history), orderId]);
    return { success: true };
  } catch (err) {
    console.error('Error appending order status:', err);
    logError(err, 'Append order status');
    throw err;
  }
}

/**
 * Decrement stock atomically with row locking to prevent race conditions
 */
async function decrementStockAtomic(productId, quantity, variantId = null) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    if (variantId) {
      // Check variant stock
      const stockResult = await client.query(
        'SELECT stock FROM product_variants WHERE id = $1 FOR UPDATE',
        [variantId]
      );
      if (stockResult.rows.length === 0) {
        throw new Error('Variant not found');
      }
      if (stockResult.rows[0].stock < quantity) {
        throw new Error(`Insufficient stock for variant. Available: ${stockResult.rows[0].stock}`);
      }
      // Update variant stock
      await client.query(
        'UPDATE product_variants SET stock = stock - $1 WHERE id = $2',
        [quantity, variantId]
      );
    } else {
      // Check product stock
      const stockResult = await client.query(
        'SELECT stock FROM products WHERE id = $1 FOR UPDATE',
        [productId]
      );
      if (stockResult.rows.length === 0) {
        throw new Error('Product not found');
      }
      if (stockResult.rows[0].stock < quantity) {
        throw new Error(`Insufficient stock. Available: ${stockResult.rows[0].stock}`);
      }
      // Update product stock
      await client.query(
        'UPDATE products SET stock = stock - $1 WHERE id = $2',
        [quantity, productId]
      );
    }
    
    await client.query('COMMIT');
    return { success: true };
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error decrementing stock:', err);
    logError(err, 'Decrement stock');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Restock order items when order is cancelled
 */
async function restockOrder(orderId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    const items = await client.query(
      'SELECT product_id, quantity, variant_id FROM order_items WHERE order_id = $1',
      [orderId]
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
    
    await client.query('COMMIT');
    return { success: true };
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error restocking order:', err);
    logError(err, 'Restock order');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Get system setting value
 */
async function getSystemSetting(key, defaultValue) {
  try {
    const result = await pool.query('SELECT value FROM system_settings WHERE key = $1', [key]);
    if (result.rows.length === 0) return defaultValue;
    return result.rows[0].value;
  } catch (err) {
    console.error('Error getting system setting:', err);
    logError(err, 'Get system setting');
    return defaultValue;
  }
}

/**
 * Log admin activity
 */
async function logAdminActivity(adminId, action, details = {}) {
  try {
    await pool.query(
      'INSERT INTO admin_logs (admin_id, action, details, created_at) VALUES ($1, $2, $3, NOW())',
      [adminId, action, JSON.stringify(details)]
    );
    return { success: true };
  } catch (err) {
    console.error('Error logging admin activity:', err);
    logError(err, 'Admin activity logging');
    // Don't throw - just log the error
    return { success: false, error: err.message };
  }
}

/**
 * Calculate shipping cost for an order
 */
function calculateOrderShipping(subtotal, tier) {
  return calculateShippingCost(subtotal, tier);
}

/**
 * Generate a unique order reference
 */
function generateOrderReference() {
  return generateOrderRef();
}

/**
 * Validate stock availability for order items
 */
async function validateStock(items) {
  const errors = [];
  
  for (const item of items) {
    try {
      const priceNum = parseFloat(item.price.replace(/[^0-9.]/g, '')) || 0;
      
      if (item.variant_id) {
        const stockResult = await pool.query(
          'SELECT stock FROM product_variants WHERE id = $1',
          [item.variant_id]
        );
        if (stockResult.rows.length === 0) {
          errors.push(`Product variant not found: ${item.name}`);
        } else if (stockResult.rows[0].stock < item.quantity) {
          errors.push(`Insufficient stock for ${item.name} (${item.variant_name || 'Default'}). Available: ${stockResult.rows[0].stock}`);
        }
      } else {
        const stockResult = await pool.query(
          'SELECT stock FROM products WHERE id = $1',
          [item.productId]
        );
        if (stockResult.rows.length === 0) {
          errors.push(`Product not found: ${item.name}`);
        } else if (stockResult.rows[0].stock < item.quantity) {
          errors.push(`Insufficient stock for ${item.name}. Available: ${stockResult.rows[0].stock}`);
        }
      }
    } catch (err) {
      errors.push(`Error checking stock for ${item.name}: ${err.message}`);
    }
  }
  
  return {
    valid: errors.length === 0,
    errors
  };
}

/**
 * Calculate order totals
 */
function calculateOrderTotals(items, shippingTier = 'standard', promoCode = null, promoDiscount = 0) {
  let subtotal = 0;
  
  items.forEach(item => {
    const priceNum = parseFloat(item.price.replace(/[^0-9.]/g, '')) || 0;
    subtotal += priceNum * item.quantity;
  });
  
  const shippingCost = calculateShippingCost(subtotal, shippingTier);
  const discount = promoDiscount || 0;
  const total = subtotal + shippingCost - discount;
  
  return {
    subtotal,
    shippingCost,
    discount,
    total
  };
}

/**
 * Get order status history
 */
async function getOrderStatusHistory(orderId) {
  try {
    const result = await pool.query('SELECT status_history FROM orders WHERE id = $1', [orderId]);
    if (result.rows.length === 0) return [];
    let history = result.rows[0].status_history;
    if (typeof history === 'string') history = JSON.parse(history);
    return history || [];
  } catch (err) {
    console.error('Error getting order status history:', err);
    logError(err, 'Get order status history');
    return [];
  }
}

/**
 * Check if order can be cancelled
 */
function canCancelOrder(order) {
  const cancellableStatuses = ['pending', 'confirmed', 'pending_payment'];
  return cancellableStatuses.includes(order.status);
}

/**
 * Check if order can be refunded
 */
function canRefundOrder(order) {
  const refundableStatuses = ['cancelled', 'delivered', 'received'];
  return refundableStatuses.includes(order.status) && 
         (order.refund_status === 'none' || order.refund_status === 'rejected');
}

/**
 * Check if order can be returned
 */
function canReturnOrder(order) {
  const returnableStatuses = ['delivered', 'received'];
  return returnableStatuses.includes(order.status);
}

/**
 * Check if order can be replaced
 */
function canReplaceOrder(order) {
  const nonReplaceableStatuses = ['cancelled', 'received', 'completed'];
  const replacementStatuses = ['pending', 'approved', 'rejected'];
  return !nonReplaceableStatuses.includes(order.status) && 
         !replacementStatuses.includes(order.replacement_status);
}

/**
 * Get order statistics for dashboard
 */
async function getOrderStats() {
  try {
    const statuses = ['pending', 'confirmed', 'shipped', 'delivered', 'received', 'cancelled', 'pending_payment', 'completed'];
    const stats = {};
    
    for (const status of statuses) {
      const result = await pool.query('SELECT COUNT(*) FROM orders WHERE status = $1', [status]);
      stats[status] = parseInt(result.rows[0].count);
    }
    
    // Additional stats
    const replacementsPending = await pool.query(
      `SELECT COUNT(*) FROM orders WHERE replacement_status IN ('pending', 'pending_payment', 'pending_refund')`
    );
    stats.replacements_pending = parseInt(replacementsPending.rows[0].count);
    
    const refundsPending = await pool.query(`SELECT COUNT(*) FROM orders WHERE refund_status = 'pending'`);
    stats.refunds_pending = parseInt(refundsPending.rows[0].count);
    
    const urgent = await pool.query(
      `SELECT COUNT(*) FROM orders WHERE urgent_delivery = true AND status NOT IN ('received', 'cancelled', 'completed')`
    );
    stats.urgent = parseInt(urgent.rows[0].count);
    
    const total = await pool.query('SELECT COUNT(*) FROM orders');
    stats.total_orders = parseInt(total.rows[0].count);
    
    const revenue = await pool.query(
      `SELECT SUM(total) FROM orders WHERE status IN ('confirmed', 'shipped', 'delivered', 'received', 'completed')`
    );
    stats.total_revenue = parseFloat(revenue.rows[0].sum) || 0;
    
    const returnsPending = await pool.query(`SELECT COUNT(*) FROM returns WHERE status = 'pending'`);
    stats.returns_pending = parseInt(returnsPending.rows[0].count);
    
    return stats;
  } catch (err) {
    console.error('Error getting order stats:', err);
    logError(err, 'Get order stats');
    throw err;
  }
}

/**
 * Get recent orders
 */
async function getRecentOrders(limit = 10) {
  try {
    const result = await pool.query(`
      SELECT o.*, c.name AS customer_name, c.email AS customer_email
      FROM orders o
      JOIN customers c ON o.customer_id = c.id
      ORDER BY o.created_at DESC
      LIMIT $1
    `, [limit]);
    return result.rows;
  } catch (err) {
    console.error('Error getting recent orders:', err);
    logError(err, 'Get recent orders');
    return [];
  }
}

/**
 * Get order by reference
 */
async function getOrderByRef(orderRef) {
  try {
    const result = await pool.query(`
      SELECT o.*, c.name AS customer_name, c.email AS customer_email
      FROM orders o
      JOIN customers c ON o.customer_id = c.id
      WHERE o.order_ref = $1
    `, [orderRef]);
    return result.rows[0] || null;
  } catch (err) {
    console.error('Error getting order by ref:', err);
    logError(err, 'Get order by ref');
    return null;
  }
}

/**
 * Get order with items
 */
async function getOrderWithItems(orderId) {
  try {
    const orderResult = await pool.query(`
      SELECT o.*, c.name AS customer_name, c.email AS customer_email
      FROM orders o
      JOIN customers c ON o.customer_id = c.id
      WHERE o.id = $1
    `, [orderId]);
    
    if (orderResult.rows.length === 0) return null;
    
    const order = orderResult.rows[0];
    const itemsResult = await pool.query(
      'SELECT * FROM order_items WHERE order_id = $1 ORDER BY id',
      [orderId]
    );
    order.items = itemsResult.rows;
    
    return order;
  } catch (err) {
    console.error('Error getting order with items:', err);
    logError(err, 'Get order with items');
    return null;
  }
}

// Export all functions
module.exports = {
  appendOrderStatus,
  decrementStockAtomic,
  restockOrder,
  getSystemSetting,
  logAdminActivity,
  calculateOrderShipping,
  generateOrderReference,
  validateStock,
  calculateOrderTotals,
  getOrderStatusHistory,
  canCancelOrder,
  canRefundOrder,
  canReturnOrder,
  canReplaceOrder,
  getOrderStats,
  getRecentOrders,
  getOrderByRef,
  getOrderWithItems
};