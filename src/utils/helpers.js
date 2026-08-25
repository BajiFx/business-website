// ================================================================
//  HELPERS - Utility Functions
//  Location: D:\my-business-website\src\utils\helpers.js
// ================================================================

const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');

/**
 * Generate a unique order reference
 */
function generateOrderRef() {
  return 'ORD-' + uuidv4().substring(0, 8).toUpperCase();
}

/**
 * Generate a reset token for password reset
 */
function generateResetToken() {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Validate Kenyan phone number
 */
function validateKenyanPhone(phone) {
  const cleaned = phone.replace(/[^0-9]/g, '');
  return /^07[0-9]{8}$/.test(cleaned) || 
         /^01[0-9]{8}$/.test(cleaned) || 
         /^2547[0-9]{8}$/.test(cleaned);
}

/**
 * Validate email format
 */
function validateEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

/**
 * Calculate distance between two coordinates (in km)
 */
function getDistance(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180) * Math.cos(lat2*Math.PI/180) * Math.sin(dLng/2)**2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return R * c;
}

/**
 * Estimate delivery days based on distance
 */
function estimateDeliveryDays(distanceKm) {
  if (distanceKm < 10) return 2;
  if (distanceKm < 50) return 3;
  if (distanceKm < 200) return 5;
  if (distanceKm < 500) return 7;
  return 10;
}

/**
 * Calculate shipping cost based on subtotal and tier
 */
function calculateShippingCost(subtotal, tier = 'standard') {
  const FREE_SHIPPING_THRESHOLD = parseFloat(process.env.FREE_SHIPPING_THRESHOLD) || 40000;
  let standard, express, overnight;
  
  if (subtotal >= FREE_SHIPPING_THRESHOLD) {
    standard = 0; 
    express = 250; 
    overnight = 350;
  } else if (subtotal >= 10000) {
    standard = 150; 
    express = 250; 
    overnight = 300;
  } else if (subtotal >= 2000) {
    standard = 120; 
    express = 200; 
    overnight = 250;
  } else if (subtotal >= 500) {
    standard = 80; 
    express = 150; 
    overnight = 200;
  } else {
    standard = 50; 
    express = 100; 
    overnight = 150;
  }
  
  switch(tier) {
    case 'standard': return standard;
    case 'express': return express;
    case 'overnight': return overnight;
    default: return standard;
  }
}

/**
 * Get callback URL for payment methods
 */
function getCallbackUrl(method) {
  const baseUrl = process.env.BASE_URL || 'http://localhost:3000';
  return `${baseUrl}/api/payments/${method}-callback`;
}

/**
 * Format currency
 */
function formatCurrency(amount, currency = 'KES') {
  return new Intl.NumberFormat('en-KE', {
    style: 'currency',
    currency: currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(amount);
}

/**
 * Truncate text with ellipsis
 */
function truncateText(text, maxLength = 100) {
  if (!text) return '';
  if (text.length <= maxLength) return text;
  return text.substring(0, maxLength) + '...';
}

/**
 * Generate a random string
 */
function generateRandomString(length = 8) {
  return crypto.randomBytes(length).toString('hex').substring(0, length);
}

/**
 * Check if a string is valid JSON
 */
function isValidJSON(str) {
  try {
    JSON.parse(str);
    return true;
  } catch {
    return false;
  }
}

/**
 * Safe JSON parse with fallback
 */
function safeJSONParse(str, fallback = null) {
  try {
    return JSON.parse(str);
  } catch {
    return fallback;
  }
}

/**
 * Get current timestamp in ISO format
 */
function getCurrentTimestamp() {
  return new Date().toISOString();
}

/**
 * Format date for display
 */
function formatDate(date, format = 'short') {
  const d = new Date(date);
  if (format === 'short') {
    return d.toLocaleDateString('en-KE', { 
      year: 'numeric', 
      month: 'short', 
      day: 'numeric' 
    });
  }
  if (format === 'long') {
    return d.toLocaleString('en-KE', { 
      year: 'numeric', 
      month: 'long', 
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  }
  return d.toISOString();
}

module.exports = {
  generateOrderRef,
  generateResetToken,
  validateKenyanPhone,
  validateEmail,
  getDistance,
  estimateDeliveryDays,
  calculateShippingCost,
  getCallbackUrl,
  formatCurrency,
  truncateText,
  generateRandomString,
  isValidJSON,
  safeJSONParse,
  getCurrentTimestamp,
  formatDate
};