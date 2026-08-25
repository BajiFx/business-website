// ================================================================
//  CONSTANTS - Application Constants
//  Location: D:\my-business-website\src\utils\constants.js
// ================================================================

module.exports = {
  // Order Statuses
  ORDER_STATUSES: {
    PENDING_PAYMENT: 'pending_payment',
    PENDING: 'pending',
    CONFIRMED: 'confirmed',
    SHIPPED: 'shipped',
    DELIVERED: 'delivered',
    RECEIVED: 'received',
    CANCELLED: 'cancelled',
    COMPLETED: 'completed'
  },
  
  // Payment Statuses
  PAYMENT_STATUSES: {
    PENDING: 'pending',
    SUCCESS: 'success',
    FAILED: 'failed'
  },
  
  // Payment Methods
  PAYMENT_METHODS: {
    MPESA: 'mpesa',
    AIRTEL: 'airtel',
    PAYPAL: 'paypal',
    BANK: 'bank'
  },
  
  // Shipping Tiers
  SHIPPING_TIERS: {
    STANDARD: 'standard',
    EXPRESS: 'express',
    OVERNIGHT: 'overnight'
  },
  
  // Retry Configuration
  MAX_RETRY_ATTEMPTS: parseInt(process.env.MAX_RETRY_ATTEMPTS) || 3,
  RETRY_DELAY_MS: parseInt(process.env.RETRY_DELAY_MS) || 1000,
  
  // Cart Configuration
  CART_RESERVATION_MINUTES: parseInt(process.env.CART_RESERVATION_MINUTES) || 15,
  
  // Order Configuration
  AUTO_CANCEL_HOURS: parseInt(process.env.AUTO_CANCEL_HOURS) || 24,
  AUTO_COMPLETE_DAYS: parseInt(process.env.AUTO_COMPLETE_DAYS) || 7,
  
  // File Upload
  MAX_FILE_SIZE: parseInt(process.env.MAX_FILE_SIZE) || 52428800, // 50MB
  ALLOWED_IMAGE_TYPES: ['image/jpeg', 'image/png', 'image/webp', 'image/gif'],
  ALLOWED_VIDEO_TYPES: ['video/mp4', 'video/webm'],
  
  // Shipping
  FREE_SHIPPING_THRESHOLD: parseFloat(process.env.FREE_SHIPPING_THRESHOLD) || 40000,
  
  // Pagination
  DEFAULT_PAGE_SIZE: 20,
  MAX_PAGE_SIZE: 100
};