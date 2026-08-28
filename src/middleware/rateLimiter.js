// ============================================================
//  RATE LIMITER - COMPLETE FIXED VERSION
//  Location: src\middleware\rateLimiter.js
// ============================================================

const rateLimit = require('express-rate-limit');

// ============================================================
//  GENERAL LIMITER - LESS STRICT
//  For public endpoints like shop, products, etc.
// ============================================================

const generalLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute (instead of 15 minutes)
  max: 100, // 100 requests per minute (instead of 200 per 15 min)
  message: { 
    error: 'Too many requests. Please wait a moment and try again.' 
  },
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: false,
});

// ============================================================
//  API LIMITER - FOR ALL API ROUTES
//  Less strict to prevent 429 errors
// ============================================================

const apiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 200, // 200 requests per minute
  message: { 
    error: 'Too many API requests. Please slow down.' 
  },
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: false,
});

// ============================================================
//  LOGIN LIMITER - STRICT (prevent brute force)
// ============================================================

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5, // 5 attempts
  message: { 
    error: 'Too many login attempts. Please try again in 15 minutes.' 
  },
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true, // Don't count successful logins
});

// ============================================================
//  SENSITIVE LIMITER - FOR ORDERS, PAYMENTS, ETC.
// ============================================================

const sensitiveLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 30, // 30 requests per minute
  message: { 
    error: 'Too many requests. Please wait a moment.' 
  },
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: false,
});

// ============================================================
//  STRICT LIMITER - FOR VERY SENSITIVE ENDPOINTS
// ============================================================

const strictLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 10, // 10 requests per minute
  message: { 
    error: 'Too many attempts. Please try again later.' 
  },
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
});

module.exports = { 
  generalLimiter, 
  apiLimiter,
  loginLimiter, 
  sensitiveLimiter,
  strictLimiter
};
