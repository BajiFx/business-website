const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const http = require('http');
const socketIo = require('socket.io');
const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cors = require('cors');
const cloudinary = require('cloudinary').v2;
const nodemailer = require('nodemailer');
const { body, validationResult } = require('express-validator');
const PDFDocument = require('pdfkit');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const cron = require('node-cron');
const paypal = require('@paypal/checkout-server-sdk');
const { sendEmail, orderConfirmationEmail, statusUpdateEmail, receivedEmail } = require('./email');
const { getRedisClient, cacheMiddleware } = require('./redis');
const cookieParser = require('cookie-parser');
require('dotenv').config();

// ============================================================
//  EXPRESS APP INITIALIZATION
// ============================================================
const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: process.env.CLIENT_URL || '*',
    methods: ['GET', 'POST'],
    credentials: true
  },
  pingTimeout: 60000,
  pingInterval: 25000
});

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET;
const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const MAX_RETRY_ATTEMPTS = parseInt(process.env.MAX_RETRY_ATTEMPTS) || 3;
const RETRY_DELAY_MS = parseInt(process.env.RETRY_DELAY_MS) || 1000;

if (!JWT_SECRET) {
  console.error('❌ Missing JWT_SECRET in .env');
  process.exit(1);
}

// ============================================================
//  CSRF PROTECTION - DISABLED FOR TESTING
// ============================================================
// const csrf = require('csurf');
// const csrfProtection = csrf({
//   cookie: {
//     httpOnly: true,
//     secure: process.env.NODE_ENV === 'production',
//     sameSite: 'strict'
//   }
// });

app.use(cookieParser());

// ============================================================
//  PAYPAL CLIENT SETUP
// ============================================================
let paypalClient = null;
if (process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_CLIENT_SECRET && 
    process.env.PAYPAL_CLIENT_ID !== 'your_paypal_client_id_here') {
  const environment = process.env.PAYPAL_MODE === 'production' 
    ? new paypal.core.LiveEnvironment(process.env.PAYPAL_CLIENT_ID, process.env.PAYPAL_CLIENT_SECRET)
    : new paypal.core.SandboxEnvironment(process.env.PAYPAL_CLIENT_ID, process.env.PAYPAL_CLIENT_SECRET);
  paypalClient = new paypal.core.PayPalHttpClient(environment);
  console.log('✅ PayPal configured');
} else {
  console.log('⚠️ PayPal credentials not configured. Using simulation mode.');
}

// ============================================================
//  Increase max listeners
// ============================================================
process.setMaxListeners(20);

// ============================================================
//  ERROR LOGGING
// ============================================================
function logError(error, context = '') {
  const logEntry = {
    timestamp: new Date().toISOString(),
    context,
    message: error.message || error,
    stack: error.stack,
    ...error
  };
  
  const logDir = path.join(__dirname, 'logs');
  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
  }
  
  fs.appendFileSync(
    path.join(logDir, 'error.log'),
    JSON.stringify(logEntry) + '\n'
  );
  console.error('❌ Error:', error.message || error);
}

// ============================================================
//  RETRY HELPER
// ============================================================
async function retryOperation(fn, maxRetries = MAX_RETRY_ATTEMPTS, delay = RETRY_DELAY_MS) {
  let lastError;
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      console.log(`🔄 Retry ${i + 1}/${maxRetries} after error:`, err.message);
      if (i < maxRetries - 1) {
        await new Promise(resolve => setTimeout(resolve, delay * (i + 1)));
      }
    }
  }
  throw lastError;
}

// ============================================================
//  NODEMAILER
// ============================================================
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: process.env.SMTP_PORT,
  secure: process.env.SMTP_SECURE === 'true',
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

// ============================================================
//  CLOUDINARY
// ============================================================
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});
console.log('✅ Cloudinary configured');

// ============================================================
//  POSTGRESQL (Neon)
// ============================================================
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { 
    rejectUnauthorized: false,
    sslmode: 'verify-full'
  },
  max: 20,
  idleTimeoutMillis: 10000,
  connectionTimeoutMillis: 5000,
  keepAlive: true,
});

pool.on('error', (err) => {
  console.error('⚠️ PostgreSQL pool error:', err);
  logError(err, 'Database pool error');
});

pool.connect((err, client, release) => {
  if (err) {
    console.error('❌ Database connection failed:', err);
    logError(err, 'Database connection failed');
    setTimeout(() => {
      pool.connect((err2, client2, release2) => {
        if (err2) {
          console.error('❌ Database still unreachable:', err2);
          logError(err2, 'Database reconnection failed');
        } else {
          console.log('✅ Neon PostgreSQL reconnected successfully');
          release2();
        }
      });
    }, 5000);
  } else {
    console.log('✅ Neon PostgreSQL connected');
    release();
  }
});

process.on('SIGINT', () => {
  pool.end(() => {
    console.log('🔌 Database pool closed');
    process.exit(0);
  });
});

process.on('uncaughtException', (err) => {
  console.error('❌ Uncaught Exception:', err);
  logError(err, 'Uncaught Exception');
});

process.on('unhandledRejection', (reason) => {
  console.error('❌ Unhandled Rejection:', reason);
  logError(reason, 'Unhandled Rejection');
});

// ============================================================
//  SECURITY
// ============================================================
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'", "https://unpkg.com", "https://cdnjs.cloudflare.com", "https://cdn.jsdelivr.net", "https://localhost:3000"],
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://unpkg.com", "https://cdnjs.cloudflare.com", "https://cdn.jsdelivr.net", "https://fonts.googleapis.com"],
      styleSrcElem: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com", "https://unpkg.com", "https://cdnjs.cloudflare.com", "https://cdn.jsdelivr.net"],
      fontSrc: ["'self'", "https://cdnjs.cloudflare.com", "https://cdn.jsdelivr.net", "https://fonts.gstatic.com", "data:"],
      imgSrc: ["'self'", "data:", "https://res.cloudinary.com", "https://*.tile.openstreetmap.org", "https://*.openstreetmap.org", "https://unpkg.com"],
      connectSrc: ["'self'", "ws://localhost:3000", "wss://*.onrender.com", "https://unpkg.com", "https://nominatim.openstreetmap.org"],
      objectSrc: ["'none'"],
    },
  },
  crossOriginEmbedderPolicy: false,
}));

app.use(cors({ 
  origin: process.env.CLIENT_URL || '*',
  credentials: true 
}));
app.use(express.json());
app.use(cookieParser());
app.use(express.static('public'));

// ============================================================
//  RATE LIMITER
// ============================================================
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  message: { error: 'Too many requests, please try again later.' }
});
app.use('/api', limiter);

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: { error: 'Too many login attempts. Try again in 15 minutes.' }
});

const sensitiveLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Too many attempts. Please try again later.' }
});

app.use('/api/orders', sensitiveLimiter);
app.use('/api/payments', sensitiveLimiter);

// ============================================================
//  FILE UPLOAD
// ============================================================
const uploadDir = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname)
});

const fileFilter = (req, file, cb) => {
  const allowedImage = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
  const allowedVideo = ['video/mp4', 'video/webm'];
  if (allowedImage.includes(file.mimetype) || allowedVideo.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error('Invalid file type. Allowed: JPEG, PNG, WebP, GIF, MP4, WebM.'));
  }
};

const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter
});

app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    return res.status(400).json({ error: err.message });
  } else if (err) {
    return res.status(500).json({ error: err.message });
  }
  next();
});

// ============================================================
//  CLOUDINARY UPLOAD HELPER
// ============================================================
async function uploadToCloudinary(filePath, options = {}) {
  try {
    const defaultOptions = {
      folder: 'business_shop',
      transformation: [
        { width: 1920, height: 600, crop: 'limit' },
        { quality: 'auto:good' },
        { fetch_format: 'auto' }
      ]
    };
    const mergedOptions = { ...defaultOptions, ...options };
    const result = await cloudinary.uploader.upload(filePath, mergedOptions);
    return result.secure_url;
  } catch (err) {
    console.error('❌ Cloudinary upload error:', err);
    logError(err, 'Cloudinary upload');
    const localPath = '/uploads/' + path.basename(filePath);
    console.log('⚠️ Using local fallback:', localPath);
    return localPath;
  }
}

function getHeroImage(row) {
  if (!row) return null;
  return row.heroImage || row.heroimage || null;
}

function getOptimizedImage(url, width = 500, height = 500) {
  if (!url || !url.includes('cloudinary')) return url;
  return url.replace('/upload/', `/upload/w_${width},h_${height},c_fill/`);
}

// ============================================================
//  JWT AUTH
// ============================================================
function generateToken(userId, role = 'customer') {
  return jwt.sign({ userId, role }, JWT_SECRET, { expiresIn: '7d' });
}

function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.userId = decoded.userId;
    req.role = decoded.role || 'customer';
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

// ============================================================
//  ADMIN ACTIVITY LOGGER
// ============================================================
async function logAdminActivity(adminId, action, details = {}) {
  try {
    await pool.query(
      'INSERT INTO admin_logs (admin_id, action, details, created_at) VALUES ($1, $2, $3, NOW())',
      [adminId, action, JSON.stringify(details)]
    );
  } catch (err) {
    console.error('Error logging admin activity:', err);
    logError(err, 'Admin activity logging');
  }
}

// ============================================================
//  ORDER REFERENCE GENERATOR
// ============================================================
function generateOrderRef() {
  return 'ORD-' + uuidv4().substring(0, 8).toUpperCase();
}

// ============================================================
//  HELPER: APPEND STATUS HISTORY
// ============================================================
async function appendOrderStatus(orderId, status, note = '') {
  const result = await pool.query('SELECT status_history FROM orders WHERE id = $1', [orderId]);
  let history = result.rows[0]?.status_history || [];
  if (typeof history === 'string') history = JSON.parse(history);
  history.push({
    status,
    timestamp: new Date().toISOString(),
    note
  });
  await pool.query('UPDATE orders SET status_history = $1 WHERE id = $2', [JSON.stringify(history), orderId]);
}

// ============================================================
//  DISTANCE CALCULATION
// ============================================================
function getDistance(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180) * Math.cos(lat2*Math.PI/180) * Math.sin(dLng/2)**2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return R * c;
}

function estimateDeliveryDays(distanceKm) {
  if (distanceKm < 10) return 2;
  if (distanceKm < 50) return 3;
  if (distanceKm < 200) return 5;
  if (distanceKm < 500) return 7;
  return 10;
}

// ============================================================
//  HELPER: GET SYSTEM SETTING
// ============================================================
async function getSetting(key, defaultValue) {
  const result = await pool.query('SELECT value FROM system_settings WHERE key = $1', [key]);
  if (result.rows.length === 0) return defaultValue;
  return result.rows[0].value;
}

// ============================================================
//  SHIPPING COST CALCULATION
// ============================================================
function calculateShippingCost(subtotal, tier) {
  const FREE_SHIPPING_THRESHOLD = parseFloat(process.env.FREE_SHIPPING_THRESHOLD) || 40000;
  let standard, express, overnight;
  if (subtotal >= FREE_SHIPPING_THRESHOLD) {
    standard = 0; express = 250; overnight = 350;
  } else if (subtotal >= 10000) {
    standard = 150; express = 250; overnight = 300;
  } else if (subtotal >= 2000) {
    standard = 120; express = 200; overnight = 250;
  } else if (subtotal >= 500) {
    standard = 80; express = 150; overnight = 200;
  } else {
    standard = 50; express = 100; overnight = 150;
  }
  switch(tier) {
    case 'standard': return standard;
    case 'express': return express;
    case 'overnight': return overnight;
    default: return standard;
  }
}

// ============================================================
//  PASSWORD RESET TOKEN GENERATOR
// ============================================================
function generateResetToken() {
  return crypto.randomBytes(32).toString('hex');
}

// ============================================================
//  VALIDATION HELPERS
// ============================================================
function validateKenyanPhone(phone) {
  const cleaned = phone.replace(/[^0-9]/g, '');
  return /^07[0-9]{8}$/.test(cleaned) || /^01[0-9]{8}$/.test(cleaned) || /^2547[0-9]{8}$/.test(cleaned);
}

function validateEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

// ============================================================
//  STOCK DECREMENT WITH ROW LOCKING (Race Condition Fix)
// ============================================================
async function decrementStockAtomic(productId, quantity, variantId = null) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    if (variantId) {
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
      await client.query(
        'UPDATE product_variants SET stock = stock - $1 WHERE id = $2',
        [quantity, variantId]
      );
    } else {
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
      await client.query(
        'UPDATE products SET stock = stock - $1 WHERE id = $2',
        [quantity, productId]
      );
    }
    
    await client.query('COMMIT');
    return { success: true };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ============================================================
//  RESTOCK ON CANCELLATION
// ============================================================
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
    throw err;
  } finally {
    client.release();
  }
}

// ============================================================
//  AUTO-CANCEL UNPAID ORDERS
// ============================================================
cron.schedule('0 * * * *', async () => {
  console.log('🔄 Running auto-cancel job for unpaid orders...');
  try {
    const result = await pool.query(
      `SELECT id, order_ref, customer_id 
       FROM orders 
       WHERE status = 'pending_payment' 
       AND created_at < NOW() - INTERVAL '24 hours'`
    );
    
    for (const order of result.rows) {
      await pool.query(
        `UPDATE orders SET status = 'cancelled', cancelled_at = NOW(), cancelled_by = 'system' 
         WHERE id = $1`,
        [order.id]
      );
      
      await appendOrderStatus(order.id, 'cancelled', 'Auto-cancelled: Payment not completed within 24 hours');
      
      // Restock items
      await restockOrder(order.id);
      
      await pool.query(
        `INSERT INTO order_chat_messages (order_id, from_user, message) 
         VALUES ($1, 'System', $2)`,
        [order.id, `⏰ Order ${order.order_ref} auto-cancelled: Payment was not completed within 24 hours.`]
      );
      
      io.to(`order_${order.id}`).emit('new-order-chat-message', {
        order_id: order.id,
        from_user: 'System',
        message: `⏰ Order ${order.order_ref} auto-cancelled: Payment was not completed within 24 hours.`,
        timestamp: new Date()
      });
      
      console.log(`✅ Auto-cancelled order ${order.order_ref}`);
    }
  } catch (err) {
    console.error('❌ Auto-cancel job error:', err);
    logError(err, 'Auto-cancel job');
  }
});

// ============================================================
//  AUTO-COMPLETE ORDERS (7 days after received)
// ============================================================
cron.schedule('0 * * * *', async () => {
  try {
    const result = await pool.query(
      `SELECT id FROM orders WHERE status = 'received' AND received_at < NOW() - INTERVAL '7 days'`
    );
    for (const order of result.rows) {
      await pool.query(
        `UPDATE orders SET status = 'completed', completed_at = NOW() WHERE id = $1`,
        [order.id]
      );
      await appendOrderStatus(order.id, 'completed', 'Auto-completed: 7 days after receipt');
      console.log(`✅ Order ${order.id} auto-completed after 7 days`);
    }
  } catch (err) {
    console.error('❌ Auto-complete job error:', err);
    logError(err, 'Auto-complete job');
  }
});

// ============================================================
//  DYNAMIC CALLBACK URL HELPER
// ============================================================
function getCallbackUrl(method) {
  return `${BASE_URL}/api/payments/${method}-callback`;
}

// ============================================================
//  M-PESA INTEGRATION
// ============================================================
async function getMpesaAccessToken() {
  const consumerKey = process.env.MPESA_CONSUMER_KEY;
  const consumerSecret = process.env.MPESA_CONSUMER_SECRET;

  if (!consumerKey || !consumerSecret || consumerKey === 'YOUR_CONSUMER_KEY_HERE') {
    console.warn('⚠️ M-Pesa credentials not configured. Using simulation mode.');
    return null;
  }

  try {
    const auth = Buffer.from(`${consumerKey}:${consumerSecret}`).toString('base64');
    const response = await retryOperation(async () => {
      const res = await fetch('https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials', {
        method: 'GET',
        headers: {
          'Authorization': `Basic ${auth}`,
          'Content-Type': 'application/json'
        }
      });
      if (!res.ok) {
        throw new Error(`Failed to get token: ${res.status}`);
      }
      return res;
    });

    const data = await response.json();
    if (!data.access_token) {
      throw new Error('No access token in response');
    }

    return data.access_token;
  } catch (error) {
    console.error('❌ M-Pesa token error:', error);
    logError(error, 'M-Pesa token');
    return null;
  }
}

async function initiateMpesaStkPush(phoneNumber, amount, accountReference, transactionDesc = 'Payment for order') {
  try {
    const accessToken = await retryOperation(() => getMpesaAccessToken());
    
    if (!accessToken) {
      console.warn('⚠️ Using M-Pesa simulation mode');
      return {
        success: true,
        checkoutRequestId: `SIM-${Date.now()}`,
        message: 'M-Pesa payment simulated successfully',
        isSimulation: true
      };
    }

    const shortcode = process.env.MPESA_SHORTCODE;
    const passkey = process.env.MPESA_PASSKEY;
    const callbackUrl = getCallbackUrl('mpesa');

    if (!shortcode || !passkey) {
      console.warn('⚠️ M-Pesa configuration incomplete. Using simulation.');
      return {
        success: true,
        checkoutRequestId: `SIM-${Date.now()}`,
        message: 'M-Pesa payment simulated (incomplete config)',
        isSimulation: true
      };
    }

    let formattedPhone = phoneNumber.replace(/^0/, '254').replace(/^\+/, '').replace(/[^0-9]/g, '');
    if (!formattedPhone.startsWith('254')) {
      formattedPhone = '254' + formattedPhone;
    }

    const timestamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
    const password = Buffer.from(`${shortcode}${passkey}${timestamp}`).toString('base64');

    const requestBody = {
      BusinessShortCode: shortcode,
      Password: password,
      Timestamp: timestamp,
      TransactionType: 'CustomerPayBillOnline',
      Amount: Math.round(amount),
      PartyA: formattedPhone,
      PartyB: shortcode,
      PhoneNumber: formattedPhone,
      CallBackURL: callbackUrl,
      AccountReference: accountReference || `ORD-${Date.now()}`,
      TransactionDesc: transactionDesc
    };

    console.log('📤 M-Pesa STK Push Request:', {
      ...requestBody,
      Password: '***HIDDEN***'
    });

    const response = await retryOperation(async () => {
      const res = await fetch('https://sandbox.safaricom.co.ke/mpesa/stkpush/v1/processrequest', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(requestBody)
      });
      return res;
    });

    const data = await response.json();

    if (data.ResponseCode === '0') {
      return {
        success: true,
        checkoutRequestId: data.CheckoutRequestID,
        merchantRequestId: data.MerchantRequestID,
        message: 'STK Push sent successfully. Please check your phone.',
        isSimulation: false
      };
    } else {
      return {
        success: false,
        errorCode: data.ResponseCode,
        message: data.ResponseDescription || 'STK Push failed',
        isSimulation: false
      };
    }
  } catch (error) {
    console.error('❌ M-Pesa STK Push error:', error);
    logError(error, 'M-Pesa STK Push');
    return {
      success: false,
      message: error.message || 'Payment initiation failed',
      isSimulation: false
    };
  }
}

// ============================================================
//  AIRTEL MONEY INTEGRATION
// ============================================================
async function getAirtelAccessToken() {
  const clientId = process.env.AIRTEL_CLIENT_ID;
  const clientSecret = process.env.AIRTEL_CLIENT_SECRET;

  if (!clientId || !clientSecret || clientId === 'your_airtel_client_id_here') {
    console.warn('⚠️ Airtel credentials not configured. Using simulation mode.');
    return null;
  }

  try {
    const response = await retryOperation(async () => {
      const res = await fetch('https://openapi.airtel.africa/auth/oauth/v2/token', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          client_id: clientId,
          client_secret: clientSecret,
          grant_type: 'client_credentials'
        })
      });
      if (!res.ok) {
        throw new Error(`Failed to get Airtel token: ${res.status}`);
      }
      return res;
    });

    const data = await response.json();
    if (!data.access_token) {
      throw new Error('No access token in response');
    }
    return data.access_token;
  } catch (error) {
    console.error('❌ Airtel token error:', error);
    logError(error, 'Airtel token');
    return null;
  }
}

async function initiateAirtelPayment(phoneNumber, amount, accountReference, transactionDesc = 'Payment for order') {
  try {
    const accessToken = await retryOperation(() => getAirtelAccessToken());
    
    if (!accessToken) {
      console.warn('⚠️ Using Airtel simulation mode');
      return {
        success: true,
        transactionId: `SIM-AIRTEL-${Date.now()}`,
        message: 'Airtel Money payment simulated successfully',
        isSimulation: true
      };
    }

    const callbackUrl = getCallbackUrl('airtel');

    if (!callbackUrl) {
      console.warn('⚠️ Airtel callback URL not configured. Using simulation.');
      return {
        success: true,
        transactionId: `SIM-AIRTEL-${Date.now()}`,
        message: 'Airtel Money payment simulated (incomplete config)',
        isSimulation: true
      };
    }

    let formattedPhone = phoneNumber.replace(/^0/, '254').replace(/^\+/, '').replace(/[^0-9]/g, '');
    if (!formattedPhone.startsWith('254')) {
      formattedPhone = '254' + formattedPhone;
    }

    const requestBody = {
      amount: Math.round(amount),
      currency: 'KES',
      country: 'KE',
      msisdn: formattedPhone,
      transaction_type: 'PAYMENT',
      reference: accountReference || `ORD-${Date.now()}`,
      callback_url: callbackUrl,
      description: transactionDesc
    };

    console.log('📤 Airtel Payment Request:', {
      ...requestBody,
      client_id: process.env.AIRTEL_CLIENT_ID ? '***HIDDEN***' : 'NOT SET'
    });

    const response = await retryOperation(async () => {
      const res = await fetch('https://openapi.airtel.africa/merchant/v1/payments', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: JSON.stringify(requestBody)
      });
      return res;
    });

    const data = await response.json();

    console.log('📥 Airtel Payment Response:', data);

    if (data.status === 'success' || data.status === 'pending' || data.transaction_id) {
      return {
        success: true,
        transactionId: data.transaction_id || data.reference || `AIRTEL-${Date.now()}`,
        message: 'Airtel Money payment initiated. Please check your phone.',
        isSimulation: false,
        rawResponse: data
      };
    } else {
      return {
        success: false,
        message: data.message || data.error || 'Airtel payment failed',
        errorCode: data.code,
        isSimulation: false
      };
    }
  } catch (error) {
    console.error('❌ Airtel payment error:', error);
    logError(error, 'Airtel payment');
    return {
      success: false,
      message: error.message || 'Payment initiation failed',
      isSimulation: false
    };
  }
}

// ============================================================
//  PAYPAL PAYMENT ROUTES
// ============================================================
app.post('/api/payments/paypal/create-order', authMiddleware, async (req, res) => {
  try {
    const { amount, orderId, currency = 'KES' } = req.body;
    
    if (!amount || amount <= 0) {
      return res.status(400).json({ error: 'Invalid amount' });
    }
    
    if (!paypalClient) {
      const transactionId = `SIM-PAYPAL-${uuidv4().substring(0, 8)}`;
      
      const paymentResult = await pool.query(
        `INSERT INTO payments (customer_id, order_id, amount, method, status, transaction_id, payment_details)
         VALUES ($1, $2, $3, 'paypal', 'pending', $4, $5)
         RETURNING *`,
        [req.userId, orderId || null, amount, transactionId, JSON.stringify({ isSimulation: true })]
      );
      
      return res.json({
        success: true,
        orderId: paymentResult.rows[0].id,
        transactionId: transactionId,
        isSimulation: true,
        approvalUrl: '#',
        message: 'PayPal payment simulated successfully'
      });
    }
    
    const request = new paypal.orders.OrdersCreateRequest();
    request.prefer('return=representation');
    request.requestBody({
      intent: 'CAPTURE',
      purchase_units: [{
        amount: {
          currency_code: currency,
          value: amount.toString()
        },
        reference_id: `order-${orderId || Date.now()}`,
        description: `Order payment for ${orderId || 'shop order'}`
      }],
      application_context: {
        brand_name: process.env.SHOP_NAME || 'Our Shop',
        landing_page: 'BILLING',
        user_action: 'PAY_NOW',
        return_url: `${process.env.CLIENT_URL || 'http://localhost:3000'}/payment-success.html`,
        cancel_url: `${process.env.CLIENT_URL || 'http://localhost:3000'}/payment-cancel.html`
      }
    });
    
    const response = await paypalClient.execute(request);
    const approvalUrl = response.result.links.find(link => link.rel === 'approve').href;
    
    const paymentResult = await pool.query(
      `INSERT INTO payments (customer_id, order_id, amount, method, status, transaction_id, payment_details)
       VALUES ($1, $2, $3, 'paypal', 'pending', $4, $5)
       RETURNING *`,
      [req.userId, orderId || null, amount, response.result.id, JSON.stringify({ paypalOrder: response.result })]
    );
    
    res.json({
      success: true,
      orderId: paymentResult.rows[0].id,
      transactionId: response.result.id,
      approvalUrl: approvalUrl,
      isSimulation: false
    });
    
  } catch (error) {
    console.error('❌ PayPal order creation error:', error);
    logError(error, 'PayPal create order');
    res.status(500).json({ error: 'Failed to create PayPal order: ' + error.message });
  }
});

app.post('/api/payments/paypal/capture', authMiddleware, async (req, res) => {
  try {
    const { orderId, paypalOrderId } = req.body;
    
    if (!orderId || !paypalOrderId) {
      return res.status(400).json({ error: 'Order ID and PayPal Order ID required' });
    }
    
    const paymentCheck = await pool.query(
      `SELECT * FROM payments WHERE transaction_id = $1 AND customer_id = $2`,
      [paypalOrderId, req.userId]
    );
    
    if (paymentCheck.rows.length > 0 && paymentCheck.rows[0].payment_details?.isSimulation) {
      await pool.query(
        `UPDATE payments SET status = 'success' WHERE id = $1`,
        [paymentCheck.rows[0].id]
      );
      return res.json({ success: true, message: 'Simulation payment captured' });
    }
    
    if (!paypalClient) {
      return res.status(400).json({ error: 'PayPal not configured' });
    }
    
    const request = new paypal.orders.OrdersCaptureRequest(paypalOrderId);
    request.requestBody({});
    
    const response = await paypalClient.execute(request);
    
    if (response.result.status === 'COMPLETED') {
      await pool.query(
        `UPDATE payments SET status = 'success', payment_details = payment_details || $1 
         WHERE transaction_id = $2`,
        [JSON.stringify({ captureResult: response.result }), paypalOrderId]
      );
      
      const orderResult = await pool.query(
        `SELECT id FROM orders WHERE id = $1`,
        [orderId]
      );
      
      if (orderResult.rows.length > 0) {
        await pool.query(
          `UPDATE orders SET payment_status = 'paid', status = 'pending' 
           WHERE id = $1 AND status = 'pending_payment'`,
          [orderId]
        );
        await appendOrderStatus(orderId, 'pending', 'PayPal payment successful. Order confirmed.');
        
        try {
          const orderWithCustomer = await pool.query(
            `SELECT o.*, c.name AS customer_name, c.email AS customer_email
             FROM orders o
             JOIN customers c ON o.customer_id = c.id
             WHERE o.id = $1`,
            [orderId]
          );
          
          if (orderWithCustomer.rows.length > 0) {
            const order = orderWithCustomer.rows[0];
            const itemsResult = await pool.query('SELECT * FROM order_items WHERE order_id = $1', [orderId]);
            order.items = itemsResult.rows;
            const mailData = orderConfirmationEmail(order, order.customer_name);
            await sendEmail({ to: order.customer_email, ...mailData });
          }
        } catch (emailError) {
          console.error('⚠️ Email send failed:', emailError.message);
          logError(emailError, 'PayPal confirmation email');
        }
        
        io.emit('new-order', { orderId });
        io.to(`order_${orderId}`).emit('payment-updated', {
          orderId,
          paymentStatus: 'paid',
          transactionId: paypalOrderId
        });
      }
      
      res.json({
        success: true,
        message: 'Payment captured successfully',
        transactionId: paypalOrderId
      });
    } else {
      res.status(400).json({
        success: false,
        message: 'Payment not completed',
        status: response.result.status
      });
    }
    
  } catch (error) {
    console.error('❌ PayPal capture error:', error);
    logError(error, 'PayPal capture');
    res.status(500).json({ error: 'Failed to capture payment: ' + error.message });
  }
});

// ============================================================
//  ANALYTICS & STATISTICS ENDPOINTS
// ============================================================
app.get('/api/admin/analytics', authMiddleware, async (req, res) => {
  if (req.role !== 'admin') {
    return res.status(403).json({ error: 'Admin only' });
  }
  
  try {
    const { period = 'week' } = req.query;
    const interval = period === 'week' ? '7 days' : period === 'month' ? '30 days' : '1 day';
    
    const revenueResult = await pool.query(
      `SELECT DATE(created_at) as date, SUM(total) as revenue, COUNT(*) as orders
       FROM orders 
       WHERE status IN ('confirmed', 'shipped', 'delivered', 'received', 'completed')
       AND created_at > NOW() - INTERVAL '${interval}'
       GROUP BY DATE(created_at)
       ORDER BY date ASC`
    );
    
    const topProducts = await pool.query(
      `SELECT oi.product_name, SUM(oi.quantity) as total_sold, SUM(oi.quantity * CAST(REPLACE(oi.price, 'Ksh ', '') AS DECIMAL)) as revenue
       FROM order_items oi
       JOIN orders o ON oi.order_id = o.id
       WHERE o.status IN ('confirmed', 'shipped', 'delivered', 'received', 'completed')
       AND o.created_at > NOW() - INTERVAL '${interval}'
       GROUP BY oi.product_name
       ORDER BY total_sold DESC
       LIMIT 10`
    );
    
    const customerStats = await pool.query(
      `SELECT COUNT(*) as total_customers,
       COUNT(CASE WHEN created_at > NOW() - INTERVAL '${interval}' THEN 1 END) as new_customers
       FROM customers`
    );
    
    const orderStats = await pool.query(
      `SELECT status, COUNT(*) as count
       FROM orders
       GROUP BY status`
    );
    
    const refundStats = await pool.query(
      `SELECT refund_status, COUNT(*) as count
       FROM orders
       WHERE refund_status IS NOT NULL AND refund_status != 'none'
       GROUP BY refund_status`
    );
    
    // Low stock alerts
    const lowStock = await pool.query(
      `SELECT id, name, stock FROM products WHERE stock < 10 ORDER BY stock ASC LIMIT 20`
    );
    
    res.json({
      period,
      revenue: revenueResult.rows,
      topProducts: topProducts.rows,
      customers: customerStats.rows[0],
      orderStatuses: orderStats.rows,
      refundStatuses: refundStats.rows,
      totalRevenue: revenueResult.rows.reduce((sum, row) => sum + parseFloat(row.revenue || 0), 0),
      totalOrders: revenueResult.rows.reduce((sum, row) => sum + parseInt(row.orders || 0), 0),
      lowStock: lowStock.rows
    });
    
  } catch (err) {
    console.error('❌ Analytics error:', err);
    logError(err, 'Analytics');
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/shop/statistics', async (req, res) => {
  try {
    const products = await pool.query('SELECT COUNT(*) FROM products');
    const orders = await pool.query('SELECT COUNT(*) FROM orders WHERE status != $1', ['cancelled']);
    const reviews = await pool.query('SELECT COUNT(*) FROM product_reviews');
    const customers = await pool.query('SELECT COUNT(*) FROM customers');
    
    const avgRating = await pool.query('SELECT AVG(rating) as avg_rating FROM product_reviews');
    
    res.json({
      totalProducts: parseInt(products.rows[0].count),
      totalOrders: parseInt(orders.rows[0].count),
      totalReviews: parseInt(reviews.rows[0].count),
      totalCustomers: parseInt(customers.rows[0].count),
      averageRating: parseFloat(avgRating.rows[0].avg_rating || 0)
    });
  } catch (err) {
    console.error('❌ Statistics error:', err);
    logError(err, 'Statistics');
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
//  SHIPPING LABEL GENERATION ENDPOINT
// ============================================================
app.post('/api/admin/returns/:id/shipping-label', authMiddleware, async (req, res) => {
  if (req.role !== 'admin') {
    return res.status(403).json({ error: 'Admin only' });
  }
  
  const returnId = parseInt(req.params.id);
  
  try {
    const returnResult = await pool.query(
      `SELECT r.*, o.delivery_address, o.recipient_name, o.recipient_phone,
       c.name as customer_name, c.email as customer_email
       FROM returns r
       JOIN orders o ON r.order_id = o.id
       JOIN customers c ON r.customer_id = c.id
       WHERE r.id = $1`,
      [returnId]
    );
    
    if (returnResult.rows.length === 0) {
      return res.status(404).json({ error: 'Return not found' });
    }
    
    const returnData = returnResult.rows[0];
    
    // Generate shipping label
    const trackingNumber = `RET-${uuidv4().substring(0, 8).toUpperCase()}`;
    
    const labelData = {
      trackingNumber,
      carrier: 'DHL / Sendy',
      estimatedPickup: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      labelUrl: `https://example.com/labels/${trackingNumber}.pdf`,
      instructions: 'Package the item securely. The courier will pick up within 24 hours.'
    };
    
    await pool.query(
      `UPDATE returns SET tracking_number = $1, shipping_label = $2 WHERE id = $3`,
      [trackingNumber, JSON.stringify(labelData), returnId]
    );
    
    res.json({
      success: true,
      label: labelData
    });
    
  } catch (err) {
    console.error('❌ Shipping label generation error:', err);
    logError(err, 'Shipping label');
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
//  NOTIFICATIONS ENDPOINTS
// ============================================================
app.get('/api/notifications/customer', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM notifications 
       WHERE customer_id = $1 
       ORDER BY created_at DESC 
       LIMIT 50`,
      [req.userId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    logError(err, 'Notifications');
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/notifications/mark-read', authMiddleware, async (req, res) => {
  try {
    const { notificationIds } = req.body;
    if (!notificationIds || !Array.isArray(notificationIds) || notificationIds.length === 0) {
      return res.status(400).json({ error: 'No notification IDs provided' });
    }
    
    await pool.query(
      `UPDATE notifications SET read = true 
       WHERE id = ANY($1::int[]) AND customer_id = $2`,
      [notificationIds, req.userId]
    );
    
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    logError(err, 'Mark notifications read');
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
//  FEATURED PRODUCTS ENDPOINT
// ============================================================
app.put('/api/shop/featured-products', authMiddleware, async (req, res) => {
  if (req.role !== 'admin') {
    return res.status(403).json({ error: 'Admin only' });
  }
  
  try {
    const { productIds } = req.body;
    if (!productIds || !Array.isArray(productIds)) {
      return res.status(400).json({ error: 'Product IDs required' });
    }
    
    await pool.query(`UPDATE products SET is_featured = false`);
    
    if (productIds.length > 0) {
      await pool.query(
        `UPDATE products SET is_featured = true WHERE id = ANY($1::int[])`,
        [productIds]
      );
    }
    
    await logAdminActivity(req.userId, 'UPDATE_FEATURED_PRODUCTS', { productIds });
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    logError(err, 'Featured products');
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
//  SIMPLIFIED REPLACEMENT FLOW
// ============================================================
app.put('/api/orders/:id/replace-simple', authMiddleware, async (req, res) => {
  if (req.role !== 'customer') {
    return res.status(403).json({ error: 'Customer only.' });
  }
  
  const orderId = parseInt(req.params.id);
  const { oldProductIds, newProductIds } = req.body;
  
  try {
    const orderCheck = await pool.query(
      `SELECT customer_id, status, created_at FROM orders WHERE id = $1`,
      [orderId]
    );
    if (orderCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Order not found' });
    }
    const order = orderCheck.rows[0];
    if (order.customer_id !== req.userId) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    
    const hoursSinceOrder = (Date.now() - new Date(order.created_at).getTime()) / (1000 * 60 * 60);
    const maxHours = parseInt(await getSetting('replacement_hours', '6'));
    if (hoursSinceOrder > maxHours) {
      return res.status(400).json({ error: `Replacement only allowed within ${maxHours} hours of order placement.` });
    }
    
    const oldItemsResult = await pool.query(
      `SELECT product_id, product_name, price, quantity 
       FROM order_items 
       WHERE order_id = $1 AND product_id = ANY($2::int[])`,
      [orderId, oldProductIds]
    );
    
    if (oldItemsResult.rows.length === 0) {
      return res.status(400).json({ error: 'No matching items found in order.' });
    }
    
    let oldTotal = 0;
    oldItemsResult.rows.forEach(item => {
      const priceNum = parseFloat(item.price.replace(/[^0-9.]/g,'')) || 0;
      oldTotal += priceNum * item.quantity;
    });
    
    const newProductsResult = await pool.query(
      `SELECT id, name, price FROM products WHERE id = ANY($1::int[])`,
      [newProductIds]
    );
    
    if (newProductsResult.rows.length === 0) {
      return res.status(400).json({ error: 'No valid replacement products found.' });
    }
    
    let newTotal = 0;
    newProductsResult.rows.forEach(item => {
      const priceNum = parseFloat(item.price.replace(/[^0-9.]/g,'')) || 0;
      newTotal += priceNum;
    });
    
    const diff = newTotal - oldTotal;
    
    let replacementStatus = 'pending';
    let paymentStatus = 'none';
    let refundStatus = 'none';
    
    if (diff === 0) {
      replacementStatus = 'approved';
      paymentStatus = 'approved';
      refundStatus = 'approved';
    } else if (diff > 0) {
      paymentStatus = 'pending';
    } else {
      refundStatus = 'pending';
    }
    
    const replacementData = {
      old_items: oldItemsResult.rows,
      new_items: newProductsResult.rows,
      old_total: oldTotal,
      new_total: newTotal,
      diff: diff,
      status: replacementStatus
    };
    
    await pool.query(
      `UPDATE orders 
       SET replacement_request = $1, 
           replacement_status = $2, 
           replacement_diff = $3,
           replacement_payment_status = $4, 
           replacement_refund_status = $5 
       WHERE id = $6`,
      [JSON.stringify(replacementData), replacementStatus, diff, paymentStatus, refundStatus, orderId]
    );
    
    let msg = `🔄 Replacement request submitted: ${oldItemsResult.rows.map(i => i.product_name).join(', ')} → ${newProductsResult.rows.map(i => i.name).join(', ')}. `;
    
    if (diff === 0) {
      msg += `✅ Prices are equal. Replacement auto-approved!`;
      await pool.query(
        `UPDATE orders SET replacement_status = 'approved' WHERE id = $1`,
        [orderId]
      );
    } else if (diff > 0) {
      msg += `You need to pay Ksh ${diff.toFixed(2)} extra.`;
    } else {
      msg += `You will get a refund of Ksh ${Math.abs(diff).toFixed(2)}.`;
    }
    
    await pool.query(
      `INSERT INTO order_chat_messages (order_id, from_user, message) VALUES ($1, 'System', $2)`,
      [orderId, msg]
    );
    
    io.to(`order_${orderId}`).emit('new-order-chat-message', {
      order_id: orderId,
      from_user: 'System',
      message: msg,
      timestamp: new Date()
    });
    
    res.json({
      success: true,
      replacement: replacementData,
      diff,
      status: replacementStatus,
      payment_status: paymentStatus,
      refund_status: refundStatus
    });
    
  } catch (err) {
    console.error('❌ Replacement error:', err);
    logError(err, 'Replacement');
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
//  REST OF EXISTING API ROUTES (All your original routes)
// ============================================================

// ---- SHOP profile ----
app.get('/api/shop', cacheMiddleware(300), async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM shop LIMIT 1');
    if (result.rows.length === 0) {
      return res.json({
        name: 'My Shop', location: 'Nairobi, Kenya', address: '',
        latitude: '', longitude: '', description: '', mission: '', vision: '',
        logo: '', heroImage: '', whatsapp: '', tiktok: '', instagram: '', facebook: '', phone: '',
        location_sharing_enabled: false, admin_lat: '', admin_lng: '',
        mpesa_enabled: false, mpesa_number: '',
        airtel_enabled: false, airtel_number: '',
        bank_enabled: false, bank_name: '', bank_account: '', bank_account_name: '',
        paypal_enabled: false, paypal_email: '',
        shipping_policy: '', return_policy: '', terms_policy: '', privacy_policy: '',
        delivery_enabled: true, online_orders_enabled: true
      });
    }
    const row = result.rows[0];
    const heroImage = getHeroImage(row);
    res.json({ ...row, heroImage });
  } catch (err) {
    console.error(err);
    logError(err, 'Shop profile');
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/shop', authMiddleware, upload.fields([{ name: 'logo' }, { name: 'heroImage' }]), async (req, res) => {
  try {
    const {
      name, location, address, latitude, longitude, description, mission, vision,
      whatsapp, tiktok, instagram, facebook, phone,
      mpesa_enabled, mpesa_number,
      airtel_enabled, airtel_number,
      bank_enabled, bank_name, bank_account, bank_account_name,
      paypal_enabled, paypal_email,
      shipping_policy, return_policy, terms_policy, privacy_policy,
      delivery_enabled, online_orders_enabled
    } = req.body;
    let logo = null, heroImage = null;
    if (req.files['logo']) {
      const file = req.files['logo'][0];
      logo = await uploadToCloudinary(file.path, { folder: 'business_shop/logos' });
      if (logo) fs.unlink(file.path, (err) => { if (err) console.error('Failed to delete local file:', err); });
    }
    if (req.files['heroImage']) {
      const file = req.files['heroImage'][0];
      heroImage = await uploadToCloudinary(file.path, { folder: 'business_shop/hero', width: 1920, height: 600 });
      if (heroImage) fs.unlink(file.path, (err) => { if (err) console.error('Failed to delete local file:', err); });
    }
    const existing = await pool.query('SELECT * FROM shop LIMIT 1');
    let updatedRow;
    if (existing.rows.length === 0) {
      const insertResult = await pool.query(`
        INSERT INTO shop (
          name, location, address, latitude, longitude, description, mission, vision,
          logo, heroImage, whatsapp, tiktok, instagram, facebook, phone,
          mpesa_enabled, mpesa_number,
          airtel_enabled, airtel_number,
          bank_enabled, bank_name, bank_account, bank_account_name,
          paypal_enabled, paypal_email,
          shipping_policy, return_policy, terms_policy, privacy_policy,
          delivery_enabled, online_orders_enabled
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30)
        RETURNING *
      `, [name, location, address, latitude, longitude, description, mission, vision,
          logo, heroImage, whatsapp, tiktok, instagram, facebook, phone,
          mpesa_enabled === 'true', mpesa_number,
          airtel_enabled === 'true', airtel_number,
          bank_enabled === 'true', bank_name, bank_account, bank_account_name,
          paypal_enabled === 'true', paypal_email,
          shipping_policy, return_policy, terms_policy, privacy_policy,
          delivery_enabled === 'true', online_orders_enabled === 'true']);
      updatedRow = insertResult.rows[0];
    } else {
      const fields = ['name','location','address','latitude','longitude','description','mission','vision',
                      'whatsapp','tiktok','instagram','facebook','phone',
                      'mpesa_enabled','mpesa_number',
                      'airtel_enabled','airtel_number',
                      'bank_enabled','bank_name','bank_account','bank_account_name',
                      'paypal_enabled','paypal_email',
                      'shipping_policy','return_policy','terms_policy','privacy_policy',
                      'delivery_enabled','online_orders_enabled'];
      const values = fields.map(f => {
        if (f.endsWith('_enabled')) return req.body[f] === 'true';
        return req.body[f] || null;
      });
      let setClause = fields.map((f, i) => `${f} = $${i+1}`).join(', ');
      let params = [...values];
      let paramIdx = fields.length + 1;
      if (logo) {
        setClause += `, logo = $${paramIdx}`;
        params.push(logo);
        paramIdx++;
      }
      if (heroImage) {
        setClause += `, heroImage = $${paramIdx}`;
        params.push(heroImage);
        paramIdx++;
      }
      const updateResult = await pool.query(
        `UPDATE shop SET ${setClause} WHERE id = 1 RETURNING *`,
        params
      );
      updatedRow = updateResult.rows[0];
    }
    const hero = getHeroImage(updatedRow);
    res.json({ success: true, shop: { ...updatedRow, heroImage: hero } });
  } catch (err) {
    console.error('❌ Shop update error:', err);
    logError(err, 'Shop update');
    res.status(500).json({ error: err.message });
  }
});

// ---- Shop Policies ----
app.get('/api/shop/policies', cacheMiddleware(300), async (req, res) => {
  try {
    const result = await pool.query('SELECT shipping_policy, return_policy, terms_policy, privacy_policy, delivery_enabled, online_orders_enabled FROM shop LIMIT 1');
    if (result.rows.length === 0) {
      return res.json({
        shipping_policy: '🚚 We deliver to all major towns in Kenya. Delivery takes 2-5 working days.',
        return_policy: '🔄 Returns are accepted within 14 days of delivery. Products must be in original condition.',
        terms_policy: '📋 By using our platform, you agree to our terms and conditions.',
        privacy_policy: '🔒 We protect your personal data and never share it with third parties.',
        delivery_enabled: true,
        online_orders_enabled: true
      });
    }
    res.json(result.rows[0]);
  } catch (err) {
    logError(err, 'Shop policies');
    res.status(500).json({ error: err.message });
  }
});

// ---- Products with Caching ----
app.get('/api/products', cacheMiddleware(60), async (req, res) => {
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
    logError(err, 'Products');
    res.status(500).json({ error: err.message });
  }
});

// ---- Batch variants endpoint ----
app.get('/api/products/variants/batch', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM product_variants ORDER BY product_id, id');
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    logError(err, 'Variants batch');
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/products/:id/detail', async (req, res) => {
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
    logError(err, 'Product detail');
    res.status(500).json({ error: err.message });
  }
});

// ---- Product CRUD ----
app.post('/api/products', authMiddleware, upload.fields([{ name: 'image' }, { name: 'variantImages' }]), [
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
    logError(err, 'Product creation');
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/products/:id', authMiddleware, upload.fields([{ name: 'image' }, { name: 'variantImages' }]), [
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
    logError(err, 'Product update');
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/products/:id', authMiddleware, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    await pool.query('DELETE FROM product_variants WHERE product_id = $1', [id]);
    await pool.query('DELETE FROM products WHERE id = $1', [id]);
    await logAdminActivity(req.userId, 'DELETE_PRODUCT', { productId: id });
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    logError(err, 'Product deletion');
    res.status(500).json({ error: err.message });
  }
});

// ---- Product Reviews ----
app.post('/api/products/:id/review', authMiddleware, [
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
    logError(err, 'Product review');
    res.status(500).json({ error: err.message });
  }
});

// ---- Wishlist ----
app.post('/api/wishlist', authMiddleware, async (req, res) => {
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
    logError(err, 'Wishlist');
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/wishlist', authMiddleware, async (req, res) => {
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
    logError(err, 'Get wishlist');
    res.status(500).json({ error: err.message });
  }
});

// ---- Admin Auth ----
app.get('/api/auth/admin-exists', async (req, res) => {
  try {
    const result = await pool.query('SELECT COUNT(*) FROM admin_users');
    const count = parseInt(result.rows[0].count);
    res.json({ exists: count > 0 });
  } catch (err) {
    console.error(err);
    logError(err, 'Admin exists check');
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/auth/register', [
  body('email').isEmail().withMessage('Invalid email'),
  body('password').isLength({ min: 6 }).withMessage('Password must be at least 6 characters')
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  try {
    const { email, password } = req.body;
    const existsResult = await pool.query('SELECT COUNT(*) FROM admin_users');
    const count = parseInt(existsResult.rows[0].count);
    if (count > 0) return res.status(403).json({ error: 'An admin account already exists.' });
    const hashedPassword = await bcrypt.hash(password, 10);
    await pool.query('INSERT INTO admin_users (email, password) VALUES ($1, $2)', [email, hashedPassword]);
    const token = generateToken(email, 'admin');
    res.json({ success: true, token, message: '✅ Admin account created successfully!' });
  } catch (err) {
    console.error(err);
    logError(err, 'Admin registration');
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/auth/login', loginLimiter, [
  body('email').isEmail().withMessage('Invalid email'),
  body('password').notEmpty().withMessage('Password required')
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  try {
    const { email, password } = req.body;
    const result = await pool.query('SELECT * FROM admin_users WHERE email = $1', [email]);
    if (result.rows.length === 0) return res.status(401).json({ error: 'Invalid credentials' });
    const user = result.rows[0];
    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(401).json({ error: 'Invalid credentials' });
    const token = generateToken(email, 'admin');
    await logAdminActivity(user.id, 'LOGIN', { email });
    res.json({ success: true, token });
  } catch (err) {
    console.error(err);
    logError(err, 'Admin login');
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/auth/verify', authMiddleware, (req, res) => {
  res.json({ authenticated: true, role: req.role });
});

// ---- Customer Auth ----
app.post('/api/auth/customer/register', [
  body('name').notEmpty().withMessage('Name required'),
  body('email').isEmail().withMessage('Invalid email'),
  body('phone').notEmpty().withMessage('Phone number required'),
  body('phone').custom(value => validateKenyanPhone(value)).withMessage('Invalid phone number. Must be a valid Kenyan number (e.g., 0712345678)'),
  body('password').isLength({ min: 6 }).withMessage('Password must be at least 6 characters')
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  try {
    const { name, email, phone, password } = req.body;
    const cleanPhone = phone.replace(/[^0-9]/g, '');
    const existing = await pool.query('SELECT * FROM customers WHERE email = $1', [email]);
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'Email already registered.' });
    }
    const existingPhone = await pool.query('SELECT * FROM customers WHERE phone = $1', [cleanPhone]);
    if (existingPhone.rows.length > 0) {
      return res.status(409).json({ error: 'Phone number already registered.' });
    }
    const hashedPassword = await bcrypt.hash(password, 10);
    const result = await pool.query(
      'INSERT INTO customers (name, email, password, phone) VALUES ($1, $2, $3, $4) RETURNING id, name, email, phone, created_at',
      [name, email, hashedPassword, cleanPhone]
    );
    const customer = result.rows[0];
    await pool.query('INSERT INTO carts (customer_id, items) VALUES ($1, $2)', [customer.id, '[]']);
    const token = generateToken(customer.id, 'customer');
    res.json({ success: true, token, customer });
  } catch (err) {
    console.error(err);
    logError(err, 'Customer registration');
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/auth/customer/login', loginLimiter, [
  body('email').isEmail().withMessage('Invalid email'),
  body('password').notEmpty().withMessage('Password required')
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  try {
    const { email, password } = req.body;
    const result = await pool.query('SELECT * FROM customers WHERE email = $1', [email]);
    if (result.rows.length === 0) return res.status(401).json({ error: 'Invalid credentials' });
    const customer = result.rows[0];
    const match = await bcrypt.compare(password, customer.password);
    if (!match) return res.status(401).json({ error: 'Invalid credentials' });
    await pool.query('UPDATE customers SET last_login_at = NOW() WHERE id = $1', [customer.id]);
    await pool.query(
      'INSERT INTO carts (customer_id, items) VALUES ($1, $2) ON CONFLICT (customer_id) DO NOTHING',
      [customer.id, '[]']
    );
    const token = generateToken(customer.id, 'customer');
    res.json({ success: true, token, customer: { id: customer.id, name: customer.name, email: customer.email, phone: customer.phone || '' } });
  } catch (err) {
    console.error(err);
    logError(err, 'Customer login');
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/auth/customer/verify', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query('SELECT id, name, email, phone, created_at FROM customers WHERE id = $1', [req.userId]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'User not found' });
    res.json({ user: result.rows[0] });
  } catch (err) {
    console.error(err);
    logError(err, 'Customer verify');
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/auth/customer/profile', authMiddleware, async (req, res) => {
  const { name, phone, email } = req.body;
  try {
    // Validate phone if provided
    if (phone && !validateKenyanPhone(phone)) {
      return res.status(400).json({ error: 'Invalid phone number. Must be a valid Kenyan number.' });
    }
    const cleanPhone = phone ? phone.replace(/[^0-9]/g, '') : null;
    const result = await pool.query(
      'UPDATE customers SET name = COALESCE($1, name), phone = COALESCE($2, phone), email = COALESCE($3, email) WHERE id = $4 RETURNING id, name, email, phone',
      [name, cleanPhone, email, req.userId]
    );
    res.json({ user: result.rows[0] });
  } catch (err) {
    logError(err, 'Profile update');
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/auth/customer/logout', authMiddleware, (req, res) => {
  res.json({ success: true });
});

app.post('/api/auth/customer/check-email', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email required' });
  try {
    const result = await pool.query('SELECT id FROM customers WHERE email = $1', [email]);
    res.json({ exists: result.rows.length > 0 });
  } catch (err) {
    logError(err, 'Check email');
    res.status(500).json({ error: err.message });
  }
});

// ---- Delete Account ----
app.delete('/api/auth/customer/delete', authMiddleware, async (req, res) => {
  try {
    const customerId = req.userId;
    await pool.query('BEGIN');
    await pool.query(`
      DELETE FROM order_items WHERE order_id IN (SELECT id FROM orders WHERE customer_id = $1)
    `, [customerId]);
    await pool.query(`
      DELETE FROM order_chat_messages WHERE order_id IN (SELECT id FROM orders WHERE customer_id = $1)
    `, [customerId]);
    await pool.query('DELETE FROM orders WHERE customer_id = $1', [customerId]);
    await pool.query('DELETE FROM carts WHERE customer_id = $1', [customerId]);
    await pool.query('DELETE FROM customer_addresses WHERE customer_id = $1', [customerId]);
    await pool.query('DELETE FROM wishlist WHERE customer_id = $1', [customerId]);
    await pool.query('DELETE FROM returns WHERE customer_id = $1', [customerId]);
    await pool.query('DELETE FROM product_reviews WHERE customer_id = $1', [customerId]);
    await pool.query('DELETE FROM payments WHERE customer_id = $1', [customerId]);
    await pool.query('DELETE FROM location_requests WHERE customer_id = $1', [customerId]);
    await pool.query('DELETE FROM chat_messages WHERE customer_id = $1', [customerId]);
    await pool.query('DELETE FROM notifications WHERE customer_id = $1', [customerId]);
    await pool.query('DELETE FROM customers WHERE id = $1', [customerId]);
    await pool.query('COMMIT');
    res.json({ success: true, message: 'Account deleted successfully.' });
  } catch (err) {
    await pool.query('ROLLBACK');
    console.error(err);
    logError(err, 'Account deletion');
    res.status(500).json({ error: err.message });
  }
});

// ---- Password Reset ----
app.post('/api/auth/forgot-password', [
  body('email').isEmail().withMessage('Invalid email')
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  try {
    const { email } = req.body;
    const result = await pool.query('SELECT id, email FROM customers WHERE email = $1', [email]);
    if (result.rows.length === 0) {
      return res.json({ success: true, message: 'If your email is registered, you will receive a reset link.' });
    }

    const token = generateResetToken();
    const expiresAt = new Date(Date.now() + 3600000);

    await pool.query(
      'INSERT INTO password_resets (email, token, expires_at) VALUES ($1, $2, $3) ON CONFLICT (email) DO UPDATE SET token = $2, expires_at = $3',
      [email, token, expiresAt]
    );

    const resetLink = `${process.env.CLIENT_URL || 'http://localhost:3000'}/reset-password.html?token=${token}`;
    await sendEmail({
      to: email,
      subject: '🔑 Reset Your Password',
      html: `
        <h2>Password Reset Request</h2>
        <p>Click the link below to reset your password. This link expires in 1 hour.</p>
        <p><a href="${resetLink}" style="background:#2563eb;color:white;padding:10px 20px;border-radius:6px;text-decoration:none;">Reset Password</a></p>
        <p>If you didn't request this, please ignore this email.</p>
      `,
      text: `Reset your password by visiting: ${resetLink}`
    });

    res.json({ success: true, message: 'If your email is registered, you will receive a reset link.' });
  } catch (err) {
    console.error(err);
    logError(err, 'Forgot password');
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/auth/reset-password', [
  body('token').notEmpty().withMessage('Token required'),
  body('password').isLength({ min: 6 }).withMessage('Password must be at least 6 characters')
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  try {
    const { token, password } = req.body;
    const result = await pool.query(
      'SELECT email FROM password_resets WHERE token = $1 AND expires_at > NOW()',
      [token]
    );
    if (result.rows.length === 0) {
      return res.status(400).json({ error: 'Invalid or expired reset token.' });
    }

    const email = result.rows[0].email;
    const hashedPassword = await bcrypt.hash(password, 10);
    await pool.query('UPDATE customers SET password = $1 WHERE email = $2', [hashedPassword, email]);
    await pool.query('DELETE FROM password_resets WHERE token = $1', [token]);

    res.json({ success: true, message: '✅ Password reset successfully! You can now login.' });
  } catch (err) {
    console.error(err);
    logError(err, 'Reset password');
    res.status(500).json({ error: err.message });
  }
});

// ---- Address Book ----
app.get('/api/addresses', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM customer_addresses WHERE customer_id = $1 ORDER BY is_default DESC, created_at ASC', [req.userId]);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    logError(err, 'Get addresses');
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/addresses', authMiddleware, [
  body('label').trim().escape().notEmpty().withMessage('Label required'),
  body('address').trim().escape().notEmpty().withMessage('Address required'),
  body('building_name').optional().trim().escape(),
  body('estate').optional().trim().escape(),
  body('nearest_landmark').optional().trim().escape(),
  body('delivery_instructions').optional().trim().escape()
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  const { label, address, lat, lng, location_name, address_type, recipient_name, recipient_phone,
          building_name, floor_room, road, estate, nearest_landmark, delivery_instructions,
          county_id, sub_county_id, ward_id, pickup_station_id } = req.body;

  try {
    const countResult = await pool.query('SELECT COUNT(*) FROM customer_addresses WHERE customer_id = $1', [req.userId]);
    const isDefault = parseInt(countResult.rows[0].count) === 0;

    let fullAddress = address;
    if (building_name) fullAddress = `${building_name}, ${fullAddress}`;
    if (estate) fullAddress = `${fullAddress}, ${estate}`;

    await pool.query(
      `INSERT INTO customer_addresses (
        customer_id, label, address, lat, lng, location_name, is_default,
        address_type, recipient_name, recipient_phone, building_name, floor_room,
        road, estate, nearest_landmark, delivery_instructions,
        county_id, sub_county_id, ward_id, pickup_station_id
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)`,
      [req.userId, label, fullAddress, lat || null, lng || null, location_name || null, isDefault,
       address_type || 'doorstep', recipient_name || null, recipient_phone || null,
       building_name || null, floor_room || null, road || null, estate || null,
       nearest_landmark || null, delivery_instructions || null,
       county_id || null, sub_county_id || null, ward_id || null, pickup_station_id || null]
    );
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    logError(err, 'Add address');
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/addresses/:id/default', authMiddleware, async (req, res) => {
  const id = parseInt(req.params.id);
  try {
    await pool.query('UPDATE customer_addresses SET is_default = false WHERE customer_id = $1', [req.userId]);
    await pool.query('UPDATE customer_addresses SET is_default = true WHERE id = $1 AND customer_id = $2', [id, req.userId]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    logError(err, 'Set default address');
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/addresses/:id', authMiddleware, async (req, res) => {
  const id = parseInt(req.params.id);
  try {
    await pool.query('DELETE FROM customer_addresses WHERE id = $1 AND customer_id = $2', [id, req.userId]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    logError(err, 'Delete address');
    res.status(500).json({ error: err.message });
  }
});

// ---- Cart ----
app.get('/api/cart', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query('SELECT items, reserved_until FROM carts WHERE customer_id = $1', [req.userId]);
    if (result.rows.length === 0) return res.json({ items: [] });
    const row = result.rows[0];
    if (row.reserved_until && new Date() > new Date(row.reserved_until)) {
      await pool.query('UPDATE carts SET items = $1, reserved_until = NULL WHERE customer_id = $2', ['[]', req.userId]);
      return res.json({ items: [] });
    }
    res.json({ items: row.items });
  } catch (err) {
    console.error(err);
    logError(err, 'Get cart');
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/cart', authMiddleware, async (req, res) => {
  try {
    const { items } = req.body;
    const reservedUntil = new Date(Date.now() + 15 * 60 * 1000);
    await pool.query(
      'INSERT INTO carts (customer_id, items, reserved_until) VALUES ($1, $2, $3) ON CONFLICT (customer_id) DO UPDATE SET items = $2, reserved_until = $3, updated_at = NOW()',
      [req.userId, JSON.stringify(items), reservedUntil]
    );
    res.json({ success: true, reserved_until: reservedUntil });
  } catch (err) {
    console.error(err);
    logError(err, 'Update cart');
    res.status(500).json({ error: err.message });
  }
});

// ---- Promo code ----
app.post('/api/promo/validate', async (req, res) => {
  const { code, subtotal } = req.body;
  if (!code) return res.json({ valid: false, message: 'No code provided.' });
  try {
    const result = await pool.query('SELECT * FROM promo_codes WHERE code = $1 AND active = true AND (expires_at IS NULL OR expires_at > NOW()) AND (usage_limit IS NULL OR used_count < usage_limit)', [code.toUpperCase()]);
    if (result.rows.length === 0) return res.json({ valid: false, message: 'Invalid or expired promo code.' });
    const promo = result.rows[0];
    if (subtotal < promo.min_order_value) {
      return res.json({ valid: false, message: `Minimum order value is Ksh ${promo.min_order_value}.` });
    }
    let discount = 0;
    if (promo.discount_type === 'percentage') {
      discount = subtotal * promo.discount_value / 100;
    } else {
      discount = promo.discount_value;
    }
    discount = Math.min(discount, subtotal);
    res.json({ valid: true, discount, message: '🎉 Promo applied!' });
  } catch (err) {
    console.error(err);
    logError(err, 'Promo validate');
    res.status(500).json({ error: err.message });
  }
});

// ---- PROMO CODES ADMIN ----
app.get('/api/admin/promo-codes', authMiddleware, async (req, res) => {
  if (req.role !== 'admin') return res.status(403).json({ error: 'Admin only.' });
  try {
    const result = await pool.query('SELECT * FROM promo_codes ORDER BY created_at DESC');
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    logError(err, 'Get promo codes');
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/promo-codes', authMiddleware, [
  body('code').notEmpty().withMessage('Code required'),
  body('discount_type').isIn(['percentage', 'fixed']).withMessage('Invalid type'),
  body('discount_value').isNumeric().withMessage('Discount value must be a number'),
], async (req, res) => {
  if (req.role !== 'admin') return res.status(403).json({ error: 'Admin only.' });
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  const { code, discount_type, discount_value, min_order_value, expires_at, usage_limit } = req.body;
  try {
    await pool.query(
      `INSERT INTO promo_codes (code, discount_type, discount_value, min_order_value, expires_at, usage_limit)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [code.toUpperCase(), discount_type, discount_value, min_order_value || 0, expires_at || null, usage_limit || null]
    );
    await logAdminActivity(req.userId, 'CREATE_PROMO', { code });
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    logError(err, 'Create promo');
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/admin/promo-codes/:id', authMiddleware, async (req, res) => {
  if (req.role !== 'admin') return res.status(403).json({ error: 'Admin only.' });
  const id = parseInt(req.params.id);
  try {
    await pool.query('DELETE FROM promo_codes WHERE id = $1', [id]);
    await logAdminActivity(req.userId, 'DELETE_PROMO', { id });
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    logError(err, 'Delete promo');
    res.status(500).json({ error: err.message });
  }
});

// ---- Chat ----
app.get('/api/chat', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT cm.*, c.name AS customer_name
      FROM chat_messages cm
      LEFT JOIN customers c ON cm.customer_id = c.id
      ORDER BY timestamp ASC
    `);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    logError(err, 'Get chat');
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/customer/chat', authMiddleware, async (req, res) => {
  if (req.role !== 'customer') return res.status(403).json({ error: 'Customer only' });
  try {
    const result = await pool.query(
      `SELECT cm.*, c.name AS customer_name
       FROM chat_messages cm
       LEFT JOIN customers c ON cm.customer_id = c.id       WHERE cm.customer_id = $1
       ORDER BY timestamp DESC LIMIT 20`,
      [req.userId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    logError(err, 'Customer chat');
    res.status(500).json({ error: err.message });
  }
});

// ---- Location Requests ----
app.get('/api/admin/location/requests', authMiddleware, async (req, res) => {
  if (req.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  try {
    const result = await pool.query(`
      SELECT lr.*, c.name, c.email
      FROM location_requests lr
      JOIN customers c ON lr.customer_id = c.id
      WHERE lr.status = 'pending'
      ORDER BY lr.created_at ASC
    `);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    logError(err, 'Location requests');
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/location/requests/:id/approve', authMiddleware, async (req, res) => {
  if (req.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const id = parseInt(req.params.id);
  try {
    await pool.query('UPDATE location_requests SET status = $1, updated_at = NOW() WHERE id = $2', ['approved', id]);
    const result = await pool.query('SELECT customer_id FROM location_requests WHERE id = $1', [id]);
    const customerId = result.rows[0]?.customer_id;
    if (customerId) io.to(`customer_${customerId}`).emit('location_request_approved');
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    logError(err, 'Approve location');
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/location/requests/:id/reject', authMiddleware, async (req, res) => {
  if (req.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const id = parseInt(req.params.id);
  try {
    await pool.query('UPDATE location_requests SET status = $1, updated_at = NOW() WHERE id = $2', ['rejected', id]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    logError(err, 'Reject location');
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/customer/location/request', authMiddleware, async (req, res) => {
  if (req.role !== 'customer') return res.status(403).json({ error: 'Customer only' });
  const customerId = req.userId;
  try {
    const existing = await pool.query(
      'SELECT * FROM location_requests WHERE customer_id = $1 AND status = $2',
      [customerId, 'pending']
    );
    if (existing.rows.length > 0) return res.status(400).json({ error: 'You already have a pending request.' });
    const approved = await pool.query(
      'SELECT * FROM location_requests WHERE customer_id = $1 AND status = $2',
      [customerId, 'approved']
    );
    if (approved.rows.length > 0) return res.json({ success: true, alreadyApproved: true });
    await pool.query('INSERT INTO location_requests (customer_id, status) VALUES ($1, $2)', [customerId, 'pending']);
    res.json({ success: true, message: 'Request sent. Awaiting admin approval.' });
  } catch (err) {
    console.error(err);
    logError(err, 'Request location');
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/customer/location/status', authMiddleware, async (req, res) => {
  if (req.role !== 'customer') return res.status(403).json({ error: 'Customer only' });
  const customerId = req.userId;
  try {
    const result = await pool.query(
      'SELECT status FROM location_requests WHERE customer_id = $1 ORDER BY updated_at DESC LIMIT 1',
      [customerId]
    );
    const status = result.rows[0]?.status || 'none';
    res.json({ status });
  } catch (err) {
    console.error(err);
    logError(err, 'Location status');
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/location/toggle', authMiddleware, async (req, res) => {
  if (req.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const { lat, lng, enabled } = req.body;
  try {
    await pool.query(
      'UPDATE shop SET location_sharing_enabled = $1, admin_lat = $2, admin_lng = $3',
      [enabled, lat || null, lng || null]
    );
    if (enabled && lat && lng) {
      const customers = await pool.query('SELECT customer_id FROM location_requests WHERE status = $1', ['approved']);
      customers.rows.forEach(row => io.to(`customer_${row.customer_id}`).emit('admin_location', { lat, lng }));
    }
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    logError(err, 'Toggle location');
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/location/update', authMiddleware, async (req, res) => {
  if (req.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const { lat, lng } = req.body;
  if (!lat || !lng) return res.status(400).json({ error: 'Missing coordinates' });
  try {
    await pool.query('UPDATE shop SET admin_lat = $1, admin_lng = $2', [lat, lng]);
    const customers = await pool.query('SELECT customer_id FROM location_requests WHERE status = $1', ['approved']);
    customers.rows.forEach(row => io.to(`customer_${row.customer_id}`).emit('admin_location', { lat, lng }));
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    logError(err, 'Update location');
    res.status(500).json({ error: err.message });
  }
});

// ---- PAYMENT ROUTES ----
app.post('/api/payments/mpesa-callback', async (req, res) => {
  try {
    console.log('📥 M-Pesa Callback received');
    const body = req.body;
    const stkCallback = body?.Body?.stkCallback;

    if (!stkCallback) {
      console.error('❌ Invalid callback structure');
      return res.status(400).json({ ResultCode: 1, ResultDesc: 'Invalid callback' });
    }

    const resultCode = stkCallback.ResultCode;
    const resultDesc = stkCallback.ResultDesc;
    const checkoutRequestId = stkCallback.CheckoutRequestID;

    let transactionId = null;
    let amount = null;
    let phoneNumber = null;

    if (stkCallback.CallbackMetadata) {
      const items = stkCallback.CallbackMetadata.Item || [];
      items.forEach(item => {
        if (item.Name === 'MpesaReceiptNumber') transactionId = item.Value;
        if (item.Name === 'Amount') amount = item.Value;
        if (item.Name === 'PhoneNumber') phoneNumber = item.Value;
      });
    }

    const isSuccess = resultCode === '0';

    const paymentResult = await pool.query(`
      SELECT id, order_id, customer_id 
      FROM payments 
      WHERE transaction_id = $1 OR (payment_details->>'checkoutRequestId' = $1)
      ORDER BY created_at DESC 
      LIMIT 1
    `, [checkoutRequestId]);

    if (paymentResult.rows.length > 0) {
      const payment = paymentResult.rows[0];
      const orderId = payment.order_id;

      await pool.query(`
        UPDATE payments 
        SET status = $1, 
            transaction_id = COALESCE($2, transaction_id),
            payment_details = payment_details || $3
        WHERE id = $4
      `, [
        isSuccess ? 'success' : 'failed',
        transactionId || uuidv4(),
        JSON.stringify({
          callbackResult: {
            resultCode,
            resultDesc,
            checkoutRequestId,
            transactionId,
            amount,
            phoneNumber
          }
        }),
        payment.id
      ]);

      if (isSuccess && orderId) {
        await pool.query(`
          UPDATE orders 
          SET payment_status = 'paid', 
              status = 'pending'
          WHERE id = $1 AND status = 'pending_payment'
        `, [orderId]);

        await appendOrderStatus(orderId, 'pending', 'Payment successful. Order confirmed.');

        const orderResult = await pool.query(`
          SELECT o.*, c.name AS customer_name, c.email AS customer_email
          FROM orders o
          JOIN customers c ON o.customer_id = c.id
          WHERE o.id = $1
        `, [orderId]);

        if (orderResult.rows.length > 0) {
          const order = orderResult.rows[0];
          const itemsResult = await pool.query('SELECT * FROM order_items WHERE order_id = $1', [orderId]);
          order.items = itemsResult.rows;

          try {
            const mailData = orderConfirmationEmail(order, order.customer_name);
            await sendEmail({
              to: order.customer_email,
              ...mailData
            });
          } catch (emailError) {
            console.error('⚠️ Email send failed:', emailError.message);
            logError(emailError, 'M-Pesa confirmation email');
          }

          io.emit('new-order', { orderId });
          io.to(`order_${orderId}`).emit('payment-updated', {
            orderId,
            paymentStatus: 'paid',
            transactionId
          });
        }
      }
    }

    res.json({ ResultCode: 0, ResultDesc: 'Success' });

  } catch (error) {
    console.error('❌ M-Pesa callback error:', error);
    logError(error, 'M-Pesa callback');
    res.status(500).json({ ResultCode: 1, ResultDesc: 'Error processing callback' });
  }
});

app.post('/api/payments/mpesa/initiate', authMiddleware, [
  body('phone').notEmpty().withMessage('Phone number required'),
  body('amount').isNumeric().withMessage('Amount must be a number')
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  try {
    const { phone, amount, orderId } = req.body;
    const customerId = req.userId;

    if (amount < 1) {
      return res.status(400).json({ error: 'Amount must be at least Ksh 1' });
    }

    // Validate phone number
    if (!validateKenyanPhone(phone)) {
      return res.status(400).json({ error: 'Invalid phone number. Must be a valid Kenyan number (e.g., 0712345678)' });
    }

    let orderRef = `ORD-${Date.now()}`;
    let actualOrderId = orderId;

    if (!orderId) {
      const orderResult = await pool.query(`
        INSERT INTO orders (customer_id, total, status, order_ref, status_history, payment_status)
        VALUES ($1, $2, 'pending_payment', $3, $4, 'pending')
        RETURNING *
      `, [
        customerId,
        amount,
        orderRef,
        JSON.stringify([{ status: 'pending_payment', timestamp: new Date().toISOString() }])
      ]);
      actualOrderId = orderResult.rows[0].id;
    }

    const stkResult = await initiateMpesaStkPush(phone, amount, orderRef);

    if (stkResult.success) {
      const paymentResult = await pool.query(`
        INSERT INTO payments (customer_id, order_id, amount, method, status, transaction_id, payment_details)
        VALUES ($1, $2, $3, 'mpesa', 'pending', $4, $5)
        RETURNING *
      `, [
        customerId,
        actualOrderId,
        amount,
        stkResult.checkoutRequestId || `SIM-${Date.now()}`,
        JSON.stringify({
          phone: phone,
          checkoutRequestId: stkResult.checkoutRequestId,
          isSimulation: stkResult.isSimulation || false
        })
      ]);

      res.json({
        success: true,
        message: stkResult.message,
        checkoutRequestId: stkResult.checkoutRequestId,
        orderId: actualOrderId,
        paymentId: paymentResult.rows[0].id,
        isSimulation: stkResult.isSimulation || false
      });
    } else {
      res.status(400).json({
        success: false,
        message: stkResult.message,
        errorCode: stkResult.errorCode
      });
    }

  } catch (error) {
    console.error('❌ M-Pesa initiate error:', error);
    logError(error, 'M-Pesa initiate');
    res.status(500).json({ error: 'Payment initiation failed' });
  }
});

app.get('/api/payments/mpesa/status/:checkoutRequestId', authMiddleware, async (req, res) => {
  try {
    const { checkoutRequestId } = req.params;

    if (!checkoutRequestId) {
      return res.status(400).json({ error: 'Checkout Request ID required' });
    }

    // Check if it's a simulation
    if (checkoutRequestId.startsWith('SIM-')) {
      const paymentResult = await pool.query(`
        SELECT status FROM payments 
        WHERE transaction_id = $1
      `, [checkoutRequestId]);

      if (paymentResult.rows.length > 0 && paymentResult.rows[0].status === 'success') {
        return res.json({
          success: true,
          data: { ResultCode: '0', ResultDesc: 'Success' }
        });
      }

      return res.json({
        success: true,
        data: { ResultCode: '1', ResultDesc: 'Pending' }
      });
    }

    // Real status query
    const accessToken = await getMpesaAccessToken();
    if (!accessToken) {
      return res.status(400).json({ error: 'Unable to query transaction status' });
    }

    const shortcode = process.env.MPESA_SHORTCODE;
    const passkey = process.env.MPESA_PASSKEY;
    const timestamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
    const password = Buffer.from(`${shortcode}${passkey}${timestamp}`).toString('base64');

    const response = await fetch('https://sandbox.safaricom.co.ke/mpesa/stkpushquery/v1/query', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        BusinessShortCode: shortcode,
        Password: password,
        Timestamp: timestamp,
        CheckoutRequestID: checkoutRequestId
      })
    });

    const data = await response.json();
    
    const paymentResult = await pool.query(`
      SELECT id FROM payments 
      WHERE transaction_id = $1 OR (payment_details->>'checkoutRequestId' = $1)
    `, [checkoutRequestId]);

    if (paymentResult.rows.length > 0) {
      await pool.query(`
        UPDATE payments 
        SET payment_details = payment_details || $1
        WHERE id = $2
      `, [
        JSON.stringify({ queryResult: data }),
        paymentResult.rows[0].id
      ]);

      if (data.ResultCode === '0') {
        await pool.query(`
          UPDATE payments SET status = 'success' WHERE id = $1
        `, [paymentResult.rows[0].id]);
      }
    }

    res.json({
      success: true,
      data: data
    });

  } catch (error) {
    console.error('❌ M-Pesa status query error:', error);
    logError(error, 'M-Pesa status');
    res.status(500).json({
      error: 'Failed to query transaction status'
    });
  }
});

app.post('/api/mpesa/save-credentials', authMiddleware, async (req, res) => {
  if (req.role !== 'admin') {
    return res.status(403).json({ error: 'Admin only' });
  }

  try {
    const { consumerKey, consumerSecret, passkey, shortcode, callbackUrl, environment } = req.body;

    if (!consumerKey || !consumerSecret || !passkey) {
      return res.status(400).json({ error: 'All M-Pesa credentials are required' });
    }

    const envPath = path.join(__dirname, '.env');
    let envContent = '';
    
    if (fs.existsSync(envPath)) {
      envContent = fs.readFileSync(envPath, 'utf8');
    }

    const lines = envContent.split('\n');
    const newLines = [];
    const mpesaKeys = {
      'MPESA_CONSUMER_KEY': consumerKey,
      'MPESA_CONSUMER_SECRET': consumerSecret,
      'MPESA_PASSKEY': passkey,
      'MPESA_SHORTCODE': shortcode || '174379',
      'MPESA_CALLBACK_URL': callbackUrl || `${BASE_URL}/api/payments/mpesa-callback`,
      'MPESA_ENVIRONMENT': environment || 'sandbox'
    };

    let updated = false;
    for (const line of lines) {
      let isKey = false;
      for (const [key, value] of Object.entries(mpesaKeys)) {
        if (line.trim().startsWith(`${key}=`)) {
          newLines.push(`${key}=${value}`);
          isKey = true;
          updated = true;
          delete mpesaKeys[key];
          break;
        }
      }
      if (!isKey) {
        newLines.push(line);
      }
    }

    for (const [key, value] of Object.entries(mpesaKeys)) {
      if (value && value.trim()) {
        newLines.push(`${key}=${value}`);
        updated = true;
      }
    }

    fs.writeFileSync(envPath, newLines.join('\n'));

    await logAdminActivity(req.userId, 'UPDATE_MPESA_CREDENTIALS', {
      environment: environment || 'sandbox',
      shortcode: shortcode || '174379'
    });

    res.json({
      success: true,
      message: 'M-Pesa credentials saved successfully'
    });

  } catch (error) {
    console.error('❌ Error saving M-Pesa credentials:', error);
    logError(error, 'Save M-Pesa credentials');
    res.status(500).json({
      error: 'Failed to save credentials: ' + error.message
    });
  }
});

app.get('/api/mpesa/test-connection', authMiddleware, async (req, res) => {
  if (req.role !== 'admin') {
    return res.status(403).json({ error: 'Admin only' });
  }

  try {
    const consumerKey = process.env.MPESA_CONSUMER_KEY;
    const consumerSecret = process.env.MPESA_CONSUMER_SECRET;

    if (!consumerKey || !consumerSecret || consumerKey === 'YOUR_CONSUMER_KEY_HERE') {
      return res.status(400).json({
        success: false,
        error: 'M-Pesa credentials are not configured'
      });
    }

    const auth = Buffer.from(`${consumerKey}:${consumerSecret}`).toString('base64');
    const response = await fetch('https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials', {
      method: 'GET',
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/json'
      }
    });

    if (response.ok) {
      const data = await response.json();
      res.json({
        success: true,
        message: 'Successfully connected to Safaricom API',
        environment: process.env.MPESA_ENVIRONMENT || 'sandbox'
      });
    } else {
      const text = await response.text();
      res.status(400).json({
        success: false,
        error: `Failed to connect: ${response.status} - ${text}`
      });
    }

  } catch (error) {
    console.error('❌ M-Pesa connection test error:', error);
    logError(error, 'M-Pesa test');
    res.status(500).json({
      success: false,
      error: 'Connection test failed: ' + error.message
    });
  }
});

// ---- Airtel Money Routes ----
app.post('/api/payments/airtel/initiate', authMiddleware, [
  body('phone').notEmpty().withMessage('Phone number required'),
  body('amount').isNumeric().withMessage('Amount must be a number')
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  try {
    const { phone, amount, orderId } = req.body;
    const customerId = req.userId;

    if (amount < 1) {
      return res.status(400).json({ error: 'Amount must be at least Ksh 1' });
    }

    // Validate phone number
    if (!validateKenyanPhone(phone)) {
      return res.status(400).json({ error: 'Invalid phone number. Must be a valid Kenyan number (e.g., 0712345678)' });
    }

    let orderRef = `ORD-${Date.now()}`;
    let actualOrderId = orderId;

    if (!orderId) {
      const orderResult = await pool.query(`
        INSERT INTO orders (customer_id, total, status, order_ref, status_history, payment_status)
        VALUES ($1, $2, 'pending_payment', $3, $4, 'pending')
        RETURNING *
      `, [
        customerId,
        amount,
        orderRef,
        JSON.stringify([{ status: 'pending_payment', timestamp: new Date().toISOString() }])
      ]);
      actualOrderId = orderResult.rows[0].id;
    }

    const airtelResult = await initiateAirtelPayment(phone, amount, orderRef);

    if (airtelResult.success) {
      const paymentResult = await pool.query(`
        INSERT INTO payments (customer_id, order_id, amount, method, status, transaction_id, payment_details)
        VALUES ($1, $2, $3, 'airtel', 'pending', $4, $5)
        RETURNING *
      `, [
        customerId,
        actualOrderId,
        amount,
        airtelResult.transactionId || `AIRTEL-${Date.now()}`,
        JSON.stringify({
          phone: phone,
          transactionId: airtelResult.transactionId,
          isSimulation: airtelResult.isSimulation || false,
          rawResponse: airtelResult.rawResponse || null
        })
      ]);

      res.json({
        success: true,
        message: airtelResult.message || 'Airtel Money payment initiated. Please check your phone.',
        transactionId: airtelResult.transactionId,
        orderId: actualOrderId,
        paymentId: paymentResult.rows[0].id,
        isSimulation: airtelResult.isSimulation || false
      });
    } else {
      res.status(400).json({
        success: false,
        message: airtelResult.message || 'Airtel payment failed. Please try again.',
        errorCode: airtelResult.errorCode
      });
    }

  } catch (error) {
    console.error('❌ Airtel initiate error:', error);
    logError(error, 'Airtel initiate');
    res.status(500).json({ error: 'Airtel payment initiation failed. Please try again.' });
  }
});

app.post('/api/payments/airtel-callback', async (req, res) => {
  try {
    console.log('📥 Airtel Callback received:', JSON.stringify(req.body, null, 2));

    const body = req.body;
    const transactionId = body.transaction_id || body.transactionId || body.reference || body.id;
    const status = body.status || body.transaction_status || body.state || body.resultCode;
    const orderRef = body.reference || body.accountReference || body.external_id;

    const isSuccess = 
      status === 'success' || 
      status === 'completed' || 
      status === 'SUCCESS' || 
      status === 'approved' ||
      status === 'APPROVED' ||
      status === '00';

    if (!orderRef) {
      console.error('❌ No order reference in callback');
      return res.json({ status: 'success', message: 'Callback received' });
    }

    const orderResult = await pool.query(
      'SELECT id, customer_id FROM orders WHERE order_ref = $1',
      [orderRef]
    );

    if (orderResult.rows.length === 0) {
      console.error('❌ Order not found for reference:', orderRef);
      return res.json({ status: 'success', message: 'Callback received' });
    }

    const orderId = orderResult.rows[0].id;

    await pool.query(`
      UPDATE payments 
      SET status = $1, 
          transaction_id = COALESCE($2, transaction_id),
          payment_details = payment_details || $3
      WHERE order_id = $4 AND method = 'airtel'
    `, [
      isSuccess ? 'success' : 'failed',
      transactionId || uuidv4(),
      JSON.stringify({ 
        callback: body,
        callbackReceivedAt: new Date().toISOString()
      }),
      orderId
    ]);

    if (isSuccess) {
      await pool.query(`
        UPDATE orders 
        SET payment_status = 'paid', 
            status = 'pending'
        WHERE id = $1 AND status = 'pending_payment'
      `, [orderId]);

      await appendOrderStatus(orderId, 'pending', 'Airtel Money payment successful. Order confirmed.');

      try {
        const orderWithCustomer = await pool.query(`
          SELECT o.*, c.name AS customer_name, c.email AS customer_email
          FROM orders o
          JOIN customers c ON o.customer_id = c.id
          WHERE o.id = $1
        `, [orderId]);

        if (orderWithCustomer.rows.length > 0) {
          const order = orderWithCustomer.rows[0];
          const itemsResult = await pool.query('SELECT * FROM order_items WHERE order_id = $1', [orderId]);
          order.items = itemsResult.rows;

          const mailData = orderConfirmationEmail(order, order.customer_name);
          await sendEmail({
            to: order.customer_email,
            ...mailData
          });
        }
      } catch (emailError) {
        console.error('⚠️ Email send failed:', emailError.message);
        logError(emailError, 'Airtel confirmation email');
      }

      io.emit('new-order', { orderId });
      io.to(`order_${orderId}`).emit('payment-updated', {
        orderId,
        paymentStatus: 'paid',
        transactionId
      });
    }

    res.json({ status: 'success', message: 'Callback processed successfully' });

  } catch (error) {
    console.error('❌ Airtel callback error:', error);
    logError(error, 'Airtel callback');
    res.status(500).json({ status: 'error', message: 'Failed to process callback' });
  }
});

app.get('/api/payments/airtel/status/:transactionId', authMiddleware, async (req, res) => {
  try {
    const { transactionId } = req.params;

    if (!transactionId) {
      return res.status(400).json({ error: 'Transaction ID required' });
    }

    if (transactionId.startsWith('SIM-AIRTEL-')) {
      const paymentResult = await pool.query(`
        SELECT status FROM payments 
        WHERE transaction_id = $1
      `, [transactionId]);

      if (paymentResult.rows.length > 0 && paymentResult.rows[0].status === 'success') {
        return res.json({
          success: true,
          data: { status: 'success', message: 'Simulation payment successful' }
        });
      }

      return res.json({
        success: true,
        data: { status: 'pending', message: 'Simulation payment pending' }
      });
    }

    const accessToken = await getAirtelAccessToken();

    if (!accessToken) {
      return res.status(400).json({
        success: false,
        message: 'Unable to query transaction status'
      });
    }

    const response = await fetch(`https://openapi.airtel.africa/merchant/v1/payments/${transactionId}`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      }
    });

    const data = await response.json();

    const paymentResult = await pool.query(`
      SELECT id FROM payments 
      WHERE transaction_id = $1
    `, [transactionId]);

    if (paymentResult.rows.length > 0 && (data.status === 'success' || data.status === 'completed')) {
      await pool.query(`
        UPDATE payments SET status = 'success' WHERE id = $1
      `, [paymentResult.rows[0].id]);
    }

    res.json({
      success: true,
      data: data
    });

  } catch (error) {
    console.error('❌ Airtel status query error:', error);
    logError(error, 'Airtel status');
    res.status(500).json({
      error: 'Failed to query transaction status'
    });
  }
});

app.post('/api/payments/initiate', authMiddleware, async (req, res) => {
  try {
    const {
      orderId, method, amount, phone, account, bank, pin,
      delivery_address, recipient_name, recipient_phone,
      delivery_instructions, customer_lat, customer_lng, location_accuracy
    } = req.body;
    const customerId = req.userId;

    if (!method || !amount) {
      return res.status(400).json({ error: 'Payment method and amount required.' });
    }

    if (method === 'mpesa') {
      if (!phone) return res.status(400).json({ error: 'Phone number required for M-Pesa.' });
      if (!validateKenyanPhone(phone)) {
        return res.status(400).json({ error: 'Invalid phone number. Must be a valid Kenyan number.' });
      }
      
      const stkResult = await initiateMpesaStkPush(phone, amount, `ORD-${orderId || Date.now()}`);

      if (stkResult.success) {
        const paymentResult = await pool.query(`
          INSERT INTO payments (customer_id, order_id, amount, method, status, transaction_id, payment_details)
          VALUES ($1, $2, $3, 'mpesa', 'pending', $4, $5)
          RETURNING *
        `, [
          customerId,
          orderId || null,
          amount,
          stkResult.checkoutRequestId || `SIM-${Date.now()}`,
          JSON.stringify({
            phone: phone,
            checkoutRequestId: stkResult.checkoutRequestId,
            isSimulation: stkResult.isSimulation || false
          })
        ]);

        return res.json({
          success: true,
          payment: paymentResult.rows[0],
          message: stkResult.message,
          checkoutRequestId: stkResult.checkoutRequestId,
          isSimulation: stkResult.isSimulation || false
        });
      } else {
        return res.status(400).json({
          success: false,
          message: stkResult.message || 'M-Pesa payment failed'
        });
      }
    }

    if (method === 'airtel') {
      if (!phone) return res.status(400).json({ error: 'Phone number required for Airtel Money.' });
      if (!validateKenyanPhone(phone)) {
        return res.status(400).json({ error: 'Invalid phone number. Must be a valid Kenyan number.' });
      }
      
      const airtelResult = await initiateAirtelPayment(phone, amount, `ORD-${orderId || Date.now()}`);

      if (airtelResult.success) {
        const paymentResult = await pool.query(`
          INSERT INTO payments (customer_id, order_id, amount, method, status, transaction_id, payment_details)
          VALUES ($1, $2, $3, 'airtel', 'pending', $4, $5)
          RETURNING *
        `, [
          customerId,
          orderId || null,
          amount,
          airtelResult.transactionId || `AIRTEL-${Date.now()}`,
          JSON.stringify({
            phone: phone,
            transactionId: airtelResult.transactionId,
            isSimulation: airtelResult.isSimulation || false
          })
        ]);

        return res.json({
          success: true,
          payment: paymentResult.rows[0],
          message: airtelResult.message || 'Airtel Money payment initiated.',
          transactionId: airtelResult.transactionId,
          isSimulation: airtelResult.isSimulation || false
        });
      } else {
        return res.status(400).json({
          success: false,
          message: airtelResult.message || 'Airtel Money payment failed'
        });
      }
    }

    if (method === 'bank') {
      if (!bank || !account) return res.status(400).json({ error: 'Bank and account number required.' });
      if (!pin || pin.length < 4) return res.status(400).json({ error: 'Valid PIN required.' });
    }

    if (orderId) {
      await pool.query(
        `UPDATE orders SET
          delivery_address = $1,
          recipient_name = $2,
          recipient_phone = $3,
          delivery_instructions = $4,
          customer_lat = $5,
          customer_lng = $6,
          location_accuracy = $7,
          location_detected_at = NOW()
        WHERE id = $8`,
        [delivery_address || null, recipient_name || null, recipient_phone || null,
         delivery_instructions || null, customer_lat || null, customer_lng || null,
         location_accuracy || null, orderId]
      );
    }

    const isSuccess = pin && pin.length >= 4;
    const status = isSuccess ? 'success' : 'failed';
    const transactionId = isSuccess ? uuidv4() : null;

    const paymentDetails = { phone, account, bank, pin: pin ? '***' : null };
    const result = await pool.query(
      `INSERT INTO payments (customer_id, order_id, amount, method, status, transaction_id, payment_details)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [customerId, orderId || null, amount, method, status, transactionId, JSON.stringify(paymentDetails)]
    );

    const payment = result.rows[0];

    if (isSuccess && orderId) {
      await pool.query('UPDATE orders SET payment_status = $1 WHERE id = $2', ['paid', orderId]);
      await pool.query(
        `UPDATE orders SET status = 'pending' WHERE id = $1 AND status = 'pending_payment'`,
        [orderId]
      );
      await appendOrderStatus(orderId, 'pending', 'Payment successful. Order confirmed.');
      io.emit('new-order', { orderId });
      io.to(`order_${orderId}`).emit('payment-updated', { orderId, paymentStatus: 'paid' });
    }

    res.json({
      success: isSuccess,
      payment: payment,
      message: isSuccess ? '✅ Payment successful! Your order has been confirmed.' : '❌ Payment failed. Please try again.',
      transactionId
    });

  } catch (err) {
    console.error('Payment initiation error:', err);
    logError(err, 'Payment initiate');
    res.status(500).json({ error: 'Payment processing failed.' });
  }
});

app.get('/api/payments/order/:orderId', authMiddleware, async (req, res) => {
  const orderId = parseInt(req.params.id);
  try {
    const result = await pool.query(
      'SELECT * FROM payments WHERE order_id = $1 ORDER BY created_at DESC',
      [orderId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    logError(err, 'Get order payments');
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/payments/customer', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT p.*, o.order_ref
       FROM payments p
       LEFT JOIN orders o ON p.order_id = o.id
       WHERE p.customer_id = $1
       ORDER BY p.created_at DESC`,
      [req.userId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    logError(err, 'Get customer payments');
    res.status(500).json({ error: err.message });
  }
});

// ---- ORDERS ----
app.post('/api/orders', authMiddleware, [
  body('items').isArray().withMessage('Items must be array'),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  if (req.role !== 'customer') {
    return res.status(403).json({ error: 'Only customers can place orders.' });
  }

  const customerId = req.userId;
  const {
    items, shipping_tier, order_notes,
    promo_code,
    delivery_address, recipient_name, recipient_phone,
    delivery_instructions, customer_lat, customer_lng, location_accuracy
  } = req.body;

  try {
    console.log('📦 ORDER CREATION STARTED');
    console.log('📦 User:', customerId);
    console.log('📦 Items:', items.length);
    console.log('📦 Delivery Address:', delivery_address);

    let subtotal = 0;
    
    for (const item of items) {
      const priceNum = parseFloat(item.price.replace(/[^0-9.]/g,'')) || 0;
      subtotal += priceNum * item.quantity;
      
      if (item.variant_id) {
        const stockResult = await pool.query(
          'SELECT stock FROM product_variants WHERE id = $1',
          [item.variant_id]
        );
        if (stockResult.rows.length === 0) {
          return res.status(400).json({ error: `Product variant not found: ${item.name}` });
        }
        if (stockResult.rows[0].stock < item.quantity) {
          return res.status(400).json({ 
            error: `Insufficient stock for ${item.name} (${item.variant_name || 'Default'}). Available: ${stockResult.rows[0].stock}`
          });
        }
      } else {
        const stockResult = await pool.query(
          'SELECT stock FROM products WHERE id = $1',
          [item.productId]
        );
        if (stockResult.rows.length === 0) {
          return res.status(400).json({ error: `Product not found: ${item.name}` });
        }
        if (stockResult.rows[0].stock < item.quantity) {
          return res.status(400).json({ 
            error: `Insufficient stock for ${item.name}. Available: ${stockResult.rows[0].stock}`
          });
        }
      }
    }

    const tier = shipping_tier || 'standard';
    const shippingCost = calculateShippingCost(subtotal, tier);

    let discount = 0;
    if (promo_code) {
      const promoResult = await pool.query(
        'SELECT * FROM promo_codes WHERE code = $1 AND active = true AND (expires_at IS NULL OR expires_at > NOW()) AND (usage_limit IS NULL OR used_count < usage_limit)',
        [promo_code.toUpperCase()]
      );
      if (promoResult.rows.length > 0) {
        const promo = promoResult.rows[0];
        if (subtotal >= promo.min_order_value) {
          if (promo.discount_type === 'percentage') {
            discount = subtotal * promo.discount_value / 100;
          } else {
            discount = promo.discount_value;
          }
          discount = Math.min(discount, subtotal);
          await pool.query('UPDATE promo_codes SET used_count = used_count + 1 WHERE id = $1', [promo.id]);
        }
      }
    }

    const total = subtotal + shippingCost - discount;

    let orderRef;
    let unique = false;
    while (!unique) {
      orderRef = generateOrderRef();
      const check = await pool.query('SELECT id FROM orders WHERE order_ref = $1', [orderRef]);
      if (check.rows.length === 0) unique = true;
    }

    const urgent = tier === 'overnight';

    await pool.query('BEGIN');
    
    const orderResult = await pool.query(`
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
      tier, shippingCost,
      order_notes || null, promo_code || null, discount,
      delivery_address || null, recipient_name || null, recipient_phone || null,
      delivery_instructions || null, customer_lat || null, customer_lng || null,
      location_accuracy || null, urgent
    ]);

    const order = orderResult.rows[0];
    console.log('📦 Order created:', order.id);

    for (const item of items) {
      const uniqueId = generateOrderRef();
      await pool.query(`
        INSERT INTO order_items (order_id, product_id, product_name, price, quantity, image, unique_id, variant_name, variant_id)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      `, [order.id, item.productId || 0, item.name, item.price, item.quantity, item.image || '',
          uniqueId, item.variant_name || 'Default', item.variant_id || null]);

      if (item.variant_id) {
        await decrementStockAtomic(item.productId, item.quantity, item.variant_id);
      } else {
        await decrementStockAtomic(item.productId, item.quantity);
      }
    }

    await pool.query('UPDATE carts SET items = $1, reserved_until = NULL WHERE customer_id = $2', ['[]', customerId]);

    await pool.query('COMMIT');

    io.emit('new-order', { orderId: order.id });

    try {
      const customerResult = await pool.query('SELECT name, email FROM customers WHERE id = $1', [customerId]);
      if (customerResult.rows.length > 0) {
        const orderWithItems = { ...order, items };
        const mailData = orderConfirmationEmail(orderWithItems, customerResult.rows[0].name);
        await sendEmail({
          to: customerResult.rows[0].email,
          ...mailData
        });
        console.log('📧 Order confirmation email sent to:', customerResult.rows[0].email);
      }
    } catch (emailErr) {
      console.error('⚠️ Email send failed:', emailErr.message);
      logError(emailErr, 'Order confirmation email');
    }

    res.status(201).json({ success: true, order, requiresPayment: true });

  } catch (err) {
    await pool.query('ROLLBACK');
    console.error('❌ Order creation error:', err);
    console.error('❌ Stack:', err.stack);
    logError(err, 'Order creation');
    res.status(500).json({ 
      error: err.message || 'Order creation failed',
      details: process.env.NODE_ENV === 'development' ? err.stack : undefined
    });
  }
});

app.get('/api/orders', authMiddleware, async (req, res) => {
  try {
    const { status, search, startDate, endDate, limit = 50, page = 1 } = req.query;
    const offset = (page - 1) * limit;
    
    let query = `
      SELECT o.*, c.name AS customer_name, c.email AS customer_email,
      (SELECT json_agg(oi.*) FROM order_items oi WHERE oi.order_id = o.id) as items
      FROM orders o
      JOIN customers c ON o.customer_id = c.id
    `;
    const params = [];
    const conditions = [];
    
    if (req.role === 'customer') {
      conditions.push('o.customer_id = $' + (params.length + 1));
      params.push(req.userId);
    }
    
    if (req.role === 'admin') {
      if (status && status !== 'all') {
        conditions.push('o.status = $' + (params.length + 1));
        params.push(status);
      }
      if (search) {
        conditions.push('(c.name ILIKE $' + (params.length + 1) + ' OR c.email ILIKE $' + (params.length + 1) + ' OR o.order_ref ILIKE $' + (params.length + 1) + ')');
        params.push(`%${search}%`);
      }
      if (startDate) {
        conditions.push('o.created_at >= $' + (params.length + 1));
        params.push(startDate);
      }
      if (endDate) {
        conditions.push('o.created_at <= $' + (params.length + 1));
        params.push(endDate + ' 23:59:59');
      }
    }
    
    if (conditions.length > 0) {
      query += ' WHERE ' + conditions.join(' AND ');
    }
    
    query += ' ORDER BY o.created_at DESC';
    query += ' LIMIT $' + (params.length + 1) + ' OFFSET $' + (params.length + 2);
    params.push(parseInt(limit), parseInt(offset));
    
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    logError(err, 'Get orders');
    res.status(500).json({ error: err.message });
  }
});

// ---- GET ORDER BY ID ----
app.get('/api/orders/:id', authMiddleware, async (req, res) => {
  const orderId = parseInt(req.params.id);
  try {
    const result = await pool.query(`
      SELECT o.*, c.name AS customer_name, c.email AS customer_email
      FROM orders o
      JOIN customers c ON o.customer_id = c.id
      WHERE o.id = $1
    `, [orderId]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Order not found' });
    const order = result.rows[0];
    if (req.role !== 'admin' && order.customer_id !== req.userId) return res.status(403).json({ error: 'Forbidden' });
    const itemsResult = await pool.query('SELECT * FROM order_items WHERE order_id = $1', [orderId]);
    res.json({ ...order, items: itemsResult.rows });
  } catch (err) {
    console.error(err);
    logError(err, 'Get order by ID');
    res.status(500).json({ error: err.message });
  }
});

// ---- GET ORDER TRACKING ----
app.get('/api/orders/:id/tracking', authMiddleware, async (req, res) => {
  const orderId = parseInt(req.params.id);
  try {
    const orderResult = await pool.query(`
      SELECT o.*, c.name AS customer_name, c.email AS customer_email
      FROM orders o
      JOIN customers c ON o.customer_id = c.id
      WHERE o.id = $1
    `, [orderId]);
    if (orderResult.rows.length === 0) return res.status(404).json({ error: 'Order not found' });
    const order = orderResult.rows[0];
    if (req.role !== 'admin' && order.customer_id !== req.userId) return res.status(403).json({ error: 'Forbidden' });
    const itemsResult = await pool.query('SELECT * FROM order_items WHERE order_id = $1', [orderId]);
    order.items = itemsResult.rows;
    let statusMessage = '';
    switch (order.status) {
      case 'pending_payment': statusMessage = '⏳ Awaiting payment confirmation.'; break;
      case 'pending': statusMessage = '📋 Your order is being reviewed.'; break;
      case 'confirmed': statusMessage = '✅ Your order is confirmed and being prepared.'; break;
      case 'shipped': statusMessage = '🚚 Your order is on the way.'; break;
      case 'delivered': statusMessage = '📦 Please collect within 7 working days.'; break;
      case 'received': statusMessage = '✔️ You have confirmed receipt. Thank you!'; break;
      case 'cancelled': statusMessage = '❌ This order has been cancelled.'; break;
      case 'completed': statusMessage = '✅ Order completed. Thank you for shopping!'; break;
      default: statusMessage = 'Status unknown.';
    }
    res.json({ ...order, statusMessage });
  } catch (err) {
    console.error(err);
    logError(err, 'Order tracking');
    res.status(500).json({ error: err.message });
  }
});

// ---- CANCEL ORDER ----
app.put('/api/orders/:id/cancel', authMiddleware, [
  body('reason').notEmpty().withMessage('Cancellation reason required')
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  const orderId = parseInt(req.params.id);
  const { reason } = req.body;
  try {
    const orderResult = await pool.query('SELECT customer_id, status, order_ref, created_at FROM orders WHERE id = $1', [orderId]);
    if (orderResult.rows.length === 0) return res.status(404).json({ error: 'Order not found' });
    const order = orderResult.rows[0];
    if (req.role !== 'admin' && order.customer_id !== req.userId) return res.status(403).json({ error: 'Forbidden' });
    if (req.role !== 'admin') {
      const hoursSinceOrder = (Date.now() - new Date(order.created_at).getTime()) / (1000 * 60 * 60);
      const maxHours = parseInt(await getSetting('replacement_hours', '6'));
      if (hoursSinceOrder > maxHours) {
        return res.status(400).json({ error: `Cancellation only allowed within ${maxHours} hours of order placement.` });
      }
    }
    if (!['pending', 'confirmed', 'pending_payment'].includes(order.status)) {
      return res.status(400).json({ error: 'This order cannot be cancelled.' });
    }
    
    // Restock items
    await restockOrder(orderId);
    
    await pool.query(
      `UPDATE orders SET status = 'cancelled', cancelled_at = NOW(), cancelled_by = $1, updated_at = NOW() WHERE id = $2`,
      [req.role === 'admin' ? 'admin' : 'customer', orderId]
    );
    await appendOrderStatus(orderId, 'cancelled', `Cancelled by ${req.role === 'admin' ? 'admin' : 'customer'}. Reason: ${reason}`);
    const ref = order.order_ref || `#${orderId}`;
    const msg = `❌ Order ${ref} has been cancelled. Reason: ${reason}`;
    await pool.query('INSERT INTO order_chat_messages (order_id, from_user, message) VALUES ($1, $2, $3)', [orderId, 'System', msg]);
    io.to(`order_${orderId}`).emit('new-order-chat-message', { order_id: orderId, from_user: 'System', message: msg, timestamp: new Date() });
    res.json({ success: true, message: 'Order cancelled.' });
  } catch (err) {
    console.error(err);
    logError(err, 'Cancel order');
    res.status(500).json({ error: err.message });
  }
});

// ---- REFUND ORDER ----
app.put('/api/orders/:id/refund', authMiddleware, [
  body('reason').notEmpty().withMessage('Refund reason required')
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  if (req.role !== 'customer') return res.status(403).json({ error: 'Customer only.' });
  const orderId = parseInt(req.params.id);
  const { reason } = req.body;
  try {
    const orderCheck = await pool.query('SELECT customer_id, status FROM orders WHERE id = $1', [orderId]);
    if (orderCheck.rows.length === 0) return res.status(404).json({ error: 'Order not found' });
    if (orderCheck.rows[0].customer_id !== req.userId) return res.status(403).json({ error: 'Forbidden' });
    if (orderCheck.rows[0].status === 'cancelled' || orderCheck.rows[0].status === 'received' || orderCheck.rows[0].status === 'completed') {
      return res.status(400).json({ error: 'This order cannot be refunded.' });
    }
    await pool.query(`UPDATE orders SET refund_request = $1, refund_status = 'pending' WHERE id = $2`, [reason, orderId]);
    const msg = `💰 Refund requested for order #${orderId}. Reason: ${reason}`;
    await pool.query('INSERT INTO order_chat_messages (order_id, from_user, message) VALUES ($1, $2, $3)', [orderId, 'System', msg]);
    io.to(`order_${orderId}`).emit('new-order-chat-message', { order_id: orderId, from_user: 'System', message: msg, timestamp: new Date() });
    res.json({ success: true, message: 'Refund request submitted.' });
  } catch (err) {
    console.error(err);
    logError(err, 'Refund request');
    res.status(500).json({ error: err.message });
  }
});

// ---- ADMIN REFUND APPROVAL ----
app.put('/api/admin/orders/:id/refund', authMiddleware, async (req, res) => {
  if (req.role !== 'admin') return res.status(403).json({ error: 'Admin only.' });
  const orderId = parseInt(req.params.id);
  const { action } = req.body;
  if (!['approve', 'reject'].includes(action)) return res.status(400).json({ error: 'Invalid action.' });
  try {
    const orderResult = await pool.query('SELECT refund_status FROM orders WHERE id = $1', [orderId]);
    if (orderResult.rows.length === 0) return res.status(404).json({ error: 'Order not found' });
    if (orderResult.rows[0].refund_status !== 'pending') return res.status(400).json({ error: 'Refund not pending.' });
    const newStatus = action === 'approve' ? 'approved' : 'rejected';
    await pool.query(`UPDATE orders SET refund_status = $1 WHERE id = $2`, [newStatus, orderId]);
    const msg = action === 'approve' ? '✅ Refund approved.' : '❌ Refund rejected.';
    await pool.query('INSERT INTO order_chat_messages (order_id, from_user, message) VALUES ($1, $2, $3)', [orderId, 'System', msg]);
    io.to(`order_${orderId}`).emit('new-order-chat-message', { order_id: orderId, from_user: 'System', message: msg, timestamp: new Date() });
    await logAdminActivity(req.userId, action === 'approve' ? 'APPROVE_REFUND' : 'REJECT_REFUND', { orderId });
    res.json({ success: true, message: `Refund ${action}d.` });
  } catch (err) {
    console.error(err);
    logError(err, 'Admin refund');
    res.status(500).json({ error: err.message });
  }
});

// ---- REPLACEMENT PAYMENT ----
app.post('/api/orders/:id/replacement-payment', authMiddleware, async (req, res) => {
  if (req.role !== 'customer') return res.status(403).json({ error: 'Customer only.' });
  const orderId = parseInt(req.params.id);
  const { payment_method, payment_details } = req.body;
  try {
    const orderCheck = await pool.query('SELECT replacement_payment_status, replacement_diff FROM orders WHERE id = $1', [orderId]);
    if (orderCheck.rows.length === 0) return res.status(404).json({ error: 'Order not found' });
    const order = orderCheck.rows[0];
    if (order.replacement_payment_status !== 'pending') {
      return res.status(400).json({ error: 'No pending payment.' });
    }
    const amount = order.replacement_diff;
    const method = payment_method;
    const details = payment_details || {};
    const transactionId = uuidv4();

    await pool.query(
      `INSERT INTO payments (customer_id, order_id, amount, method, status, transaction_id, payment_details)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [req.userId, orderId, amount, method, 'success', transactionId, JSON.stringify(details)]
    );

    await pool.query(
      `UPDATE orders SET replacement_payment_status = 'paid', replacement_payment_method = $1, replacement_payment_details = $2, replacement_payment_date = NOW() WHERE id = $3`,
      [method, JSON.stringify(details || {}), orderId]
    );
    await pool.query(`UPDATE orders SET replacement_status = 'approved' WHERE id = $1`, [orderId]);
    const msg = `✅ Replacement payment received via ${method}. Replacement approved.`;
    await pool.query('INSERT INTO order_chat_messages (order_id, from_user, message) VALUES ($1, $2, $3)', [orderId, 'System', msg]);
    io.to(`order_${orderId}`).emit('new-order-chat-message', { order_id: orderId, from_user: 'System', message: msg, timestamp: new Date() });
    res.json({ success: true, message: 'Payment recorded. Replacement approved.' });
  } catch (err) {
    console.error(err);
    logError(err, 'Replacement payment');
    res.status(500).json({ error: err.message });
  }
});

// ---- ADMIN REPLACEMENT APPROVAL ----
app.put('/api/admin/orders/:id/replace', authMiddleware, async (req, res) => {
  if (req.role !== 'admin') return res.status(403).json({ error: 'Admin only.' });
  const orderId = parseInt(req.params.id);
  const { action } = req.body;
  try {
    const orderResult = await pool.query('SELECT replacement_status, replacement_diff FROM orders WHERE id = $1', [orderId]);
    if (orderResult.rows.length === 0) return res.status(404).json({ error: 'Order not found' });
    const order = orderResult.rows[0];
    if (order.replacement_status === 'none' || order.replacement_status === 'approved' || order.replacement_status === 'rejected') {
      return res.status(400).json({ error: 'No pending replacement request.' });
    }
    const diff = parseFloat(order.replacement_diff) || 0;
    if (diff > 0 && order.replacement_payment_status !== 'paid') {
      return res.status(400).json({ error: 'Customer must complete payment first.' });
    }
    const newStatus = action === 'approve' ? 'approved' : 'rejected';
    await pool.query(`UPDATE orders SET replacement_status = $1 WHERE id = $2`, [newStatus, orderId]);
    const msg = action === 'approve' ? '✅ Replacement approved.' : '❌ Replacement rejected.';
    await pool.query('INSERT INTO order_chat_messages (order_id, from_user, message) VALUES ($1, $2, $3)', [orderId, 'System', msg]);
    io.to(`order_${orderId}`).emit('new-order-chat-message', { order_id: orderId, from_user: 'System', message: msg, timestamp: new Date() });
    await logAdminActivity(req.userId, action === 'approve' ? 'APPROVE_REPLACEMENT' : 'REJECT_REPLACEMENT', { orderId });
    res.json({ success: true, message: `Replacement ${action}d.` });
  } catch (err) {
    console.error(err);
    logError(err, 'Admin replacement');
    res.status(500).json({ error: err.message });
  }
});

// ---- RETURN REQUEST ----
app.post('/api/orders/:id/return', authMiddleware, [
  body('product_id').isInt().withMessage('Product ID required'),
  body('reason').notEmpty().withMessage('Return reason required')
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  if (req.role !== 'customer') return res.status(403).json({ error: 'Customer only.' });
  const orderId = parseInt(req.params.id);
  const { product_id, reason, photos } = req.body;
  try {
    const productCheck = await pool.query('SELECT return_enabled FROM products WHERE id = $1', [product_id]);
    if (productCheck.rows.length === 0) return res.status(404).json({ error: 'Product not found.' });
    if (!productCheck.rows[0].return_enabled) {
      return res.status(400).json({ error: 'This product is non-returnable.' });
    }
    const orderCheck = await pool.query('SELECT customer_id, status FROM orders WHERE id = $1', [orderId]);
    if (orderCheck.rows.length === 0) return res.status(404).json({ error: 'Order not found.' });
    if (orderCheck.rows[0].customer_id !== req.userId) return res.status(403).json({ error: 'Forbidden.' });
    if (!['delivered', 'received', 'completed'].includes(orderCheck.rows[0].status)) {
      return res.status(400).json({ error: 'Return only allowed after delivery.' });
    }
    const existingReturn = await pool.query(
      'SELECT id FROM returns WHERE order_id = $1 AND product_id = $2 AND status IN ($3,$4)',
      [orderId, product_id, 'pending', 'approved']
    );
    if (existingReturn.rows.length > 0) return res.status(400).json({ error: 'Return already requested for this product.' });
    await pool.query(
      'INSERT INTO returns (order_id, customer_id, product_id, reason, photos, status) VALUES ($1, $2, $3, $4, $5, $6)',
      [orderId, req.userId, product_id, reason, photos || null, 'pending']
    );
    const msg = `📦 Return requested for product #${product_id}. Reason: ${reason}`;
    await pool.query('INSERT INTO order_chat_messages (order_id, from_user, message) VALUES ($1, $2, $3)', [orderId, 'System', msg]);
    io.to(`order_${orderId}`).emit('new-order-chat-message', { order_id: orderId, from_user: 'System', message: msg, timestamp: new Date() });
    io.emit('return-requested', { orderId });
    res.json({ success: true, message: 'Return request submitted.' });
  } catch (err) {
    console.error(err);
    logError(err, 'Return request');
    res.status(500).json({ error: err.message });
  }
});

// ---- ADMIN RETURN APPROVAL ----
app.put('/api/admin/returns/:id', authMiddleware, async (req, res) => {
  if (req.role !== 'admin') return res.status(403).json({ error: 'Admin only.' });
  const returnId = parseInt(req.params.id);
  const { action, admin_notes } = req.body;
  try {
    const returnResult = await pool.query('SELECT * FROM returns WHERE id = $1', [returnId]);
    if (returnResult.rows.length === 0) return res.status(404).json({ error: 'Return not found.' });
    const ret = returnResult.rows[0];
    if (ret.status !== 'pending') return res.status(400).json({ error: 'Return already processed.' });
    const newStatus = action === 'approve' ? 'approved' : 'rejected';
    await pool.query(`UPDATE returns SET status = $1, approved_at = NOW(), admin_notes = $2 WHERE id = $3`,
      [newStatus, admin_notes || null, returnId]);
    const msg = action === 'approve' ? '✅ Return approved.' : '❌ Return rejected.';
    await pool.query('INSERT INTO order_chat_messages (order_id, from_user, message) VALUES ($1, $2, $3)', [ret.order_id, 'System', msg]);
    io.to(`order_${ret.order_id}`).emit('new-order-chat-message', { order_id: ret.order_id, from_user: 'System', message: msg, timestamp: new Date() });
    await logAdminActivity(req.userId, action === 'approve' ? 'APPROVE_RETURN' : 'REJECT_RETURN', { returnId });
    res.json({ success: true, message: `Return ${action}d.` });
  } catch (err) {
    console.error(err);
    logError(err, 'Admin return');
    res.status(500).json({ error: err.message });
  }
});

// ---- REORDER ----
app.post('/api/orders/:id/reorder', authMiddleware, async (req, res) => {
  const orderId = parseInt(req.params.id);
  try {
    const orderResult = await pool.query('SELECT customer_id FROM orders WHERE id = $1', [orderId]);
    if (orderResult.rows.length === 0) return res.status(404).json({ error: 'Order not found' });
    const order = orderResult.rows[0];
    if (order.customer_id !== req.userId) return res.status(403).json({ error: 'Forbidden' });
    const itemsResult = await pool.query(
      'SELECT product_id, product_name, price, image, variant_name, variant_id FROM order_items WHERE order_id = $1',
      [orderId]
    );
    if (itemsResult.rows.length === 0) return res.status(400).json({ error: 'No items to reorder.' });
    const cartItems = itemsResult.rows.map(item => ({
      id: item.product_id,
      name: item.product_name,
      price: item.price,
      image: item.image || '',
      quantity: 1,
      variant_name: item.variant_name || 'Default',
      variant_id: item.variant_id || null
    }));
    await pool.query('UPDATE carts SET items = $1, updated_at = NOW() WHERE customer_id = $2',
      [JSON.stringify(cartItems), req.userId]);
    res.json({ success: true, items: cartItems });
  } catch (err) {
    console.error(err);
    logError(err, 'Reorder');
    res.status(500).json({ error: err.message });
  }
});

// ---- CONFIRM ORDER ----
app.put('/api/orders/:id/confirm', authMiddleware, async (req, res) => {
  if (req.role !== 'admin') return res.status(403).json({ error: 'Admin only.' });
  const orderId = parseInt(req.params.id);
  try {
    const orderResult = await pool.query(`
      SELECT o.*, c.name AS customer_name, c.email AS customer_email
      FROM orders o
      JOIN customers c ON o.customer_id = c.id
      WHERE o.id = $1
    `, [orderId]);
    if (orderResult.rows.length === 0) return res.status(404).json({ error: 'Order not found' });
    const order = orderResult.rows[0];
    if (order.status !== 'pending') {
      return res.status(400).json({ error: `Order already processed (status: ${order.status})` });
    }
    await pool.query(`UPDATE orders SET status = 'confirmed', updated_at = NOW() WHERE id = $1`, [orderId]);
    await appendOrderStatus(orderId, 'confirmed');
    await logAdminActivity(req.userId, 'CONFIRM_ORDER', { orderId });

    const itemsResult = await pool.query('SELECT * FROM order_items WHERE order_id = $1', [orderId]);
    const items = itemsResult.rows;

    const ref = order.order_ref || `#${order.id}`;
    let message = `✅ **Order ${ref} Confirmed!**\n\n`;
    message += `Dear ${order.customer_name},\n\n`;
    message += `Your order has been confirmed. Here are the details:\n\n`;
    message += `📦 **Order Items:**\n`;
    let total = 0;
    items.forEach((item, index) => {
      const priceNum = parseFloat(item.price.replace(/[^0-9.]/g, '')) || 0;
      const subtotal = priceNum * item.quantity;
      total += subtotal;
      const variant = item.variant_name || 'Default';
      const uniqueId = item.unique_id || '—';
      message += `${index+1}. ${item.product_name} (${variant}) x${item.quantity} – Ksh ${subtotal.toFixed(2)} (ID: ${uniqueId})\n`;
    });
    message += `\n💰 **Total:** Ksh ${Number(order.total).toFixed(2)}\n\n`;
    message += `📍 **Delivery Location:**\n`;
    message += `   ${order.delivery_address || 'Not provided'}\n`;
    if (order.recipient_name) message += `   👤 Recipient: ${order.recipient_name} (${order.recipient_phone || 'N/A'})\n`;
    if (order.delivery_instructions) message += `   📝 Instructions: ${order.delivery_instructions}\n`;
    if (order.customer_lat && order.customer_lng) {
      message += `   🗺️ GPS: ${order.customer_lat}, ${order.customer_lng}\n`;
    }
    message += `\n📅 Order Date: ${new Date(order.created_at).toLocaleString()}\n`;
    message += `🆔 Reference: ${ref}\n\n`;
    message += `Thank you for shopping with us! 🙏`;

    await pool.query('INSERT INTO order_chat_messages (order_id, from_user, message) VALUES ($1, $2, $3)',
      [orderId, 'Seller', message]);
    io.to(`order_${orderId}`).emit('new-order-chat-message', { order_id: orderId, from_user: 'Seller', message: message, timestamp: new Date() });

    if (order.customer_email) {
      try {
        const mailData = orderConfirmationEmail(order, order.customer_name);
        await sendEmail({ to: order.customer_email, ...mailData });
      } catch (emailErr) {
        console.error('⚠️ Email send failed:', emailErr.message);
        logError(emailErr, 'Order confirmation');
      }
    }
    res.json({ success: true, message: '✅ Order confirmed.' });
  } catch (err) {
    console.error('Confirm error:', err);
    logError(err, 'Confirm order');
    res.status(500).json({ error: err.message });
  }
});

// ---- UPDATE ORDER STATUS ----
app.put('/api/orders/:id/status', authMiddleware, async (req, res) => {
  if (req.role !== 'admin') return res.status(403).json({ error: 'Admin only.' });
  const orderId = parseInt(req.params.id);
  const { status, tracking_number } = req.body;
  try {
    const current = await pool.query('SELECT status, customer_id, order_ref FROM orders WHERE id = $1', [orderId]);
    if (current.rows.length === 0) return res.status(404).json({ error: 'Order not found' });
    const currentStatus = current.rows[0].status;
    if (currentStatus === 'pending') return res.status(400).json({ error: 'Order must be confirmed first.' });
    if (currentStatus === 'received' || currentStatus === 'cancelled' || currentStatus === 'completed') {
      return res.status(400).json({ error: 'Order already processed.' });
    }
    const updates = { status };
    if (status === 'shipped') {
      updates.shipped_at = new Date();
      if (tracking_number) updates.tracking_number = tracking_number;
    } else if (status === 'delivered') {
      updates.delivered_at = new Date();
    }
    await pool.query(
      `UPDATE orders SET status = $1, shipped_at = $2, delivered_at = $3, tracking_number = $4, updated_at = NOW() WHERE id = $5`,
      [updates.status, updates.shipped_at || null, updates.delivered_at || null, updates.tracking_number || null, orderId]
    );
    await appendOrderStatus(orderId, status);
    await logAdminActivity(req.userId, `UPDATE_ORDER_TO_${status.toUpperCase()}`, { orderId });

    const orderRef = current.rows[0].order_ref || `#${orderId}`;
    const msg = `📦 Order ${orderRef} status updated to: ${status.toUpperCase()}`;
    await pool.query('INSERT INTO order_chat_messages (order_id, from_user, message) VALUES ($1, $2, $3)',
      [orderId, 'Seller', msg]);
    io.to(`order_${orderId}`).emit('new-order-chat-message', { order_id: orderId, from_user: 'Seller', message: msg, timestamp: new Date() });

    const customerResult = await pool.query('SELECT name, email FROM customers WHERE id = $1', [current.rows[0].customer_id]);
    const customer = customerResult.rows[0];
    if (customer && customer.email) {
      try {
        const mailData = statusUpdateEmail({ ...current.rows[0], status, tracking_number }, status, customer.name);
        await sendEmail({ to: customer.email, ...mailData });
        console.log('📧 Status update email sent to:', customer.email);
      } catch (emailErr) {
        console.error('⚠️ Email send failed:', emailErr.message);
        logError(emailErr, 'Status update email');
      }
    }
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    logError(err, 'Update order status');
    res.status(500).json({ error: err.message });
  }
});

// ---- RECEIVE ORDER ----
app.put('/api/orders/:id/receive', authMiddleware, async (req, res) => {
  if (req.role !== 'customer') return res.status(403).json({ error: 'Customer only.' });
  const orderId = parseInt(req.params.id);
  try {
    const orderResult = await pool.query('SELECT customer_id, status, order_ref FROM orders WHERE id = $1', [orderId]);
    if (orderResult.rows.length === 0) return res.status(404).json({ error: 'Order not found' });
    const order = orderResult.rows[0];
    if (order.customer_id !== req.userId) return res.status(403).json({ error: 'Not your order.' });
    if (order.status !== 'delivered') {
      return res.status(400).json({ error: 'Order must be delivered before you can mark it as received.' });
    }
    await pool.query(`UPDATE orders SET status = 'received', received_at = NOW(), updated_at = NOW() WHERE id = $1`, [orderId]);
    await appendOrderStatus(orderId, 'received');
    const ref = order.order_ref || `#${orderId}`;
    const msg = `✅ Order ${ref} has been received by the customer.`;
    await pool.query('INSERT INTO order_chat_messages (order_id, from_user, message) VALUES ($1, $2, $3)',
      [orderId, 'Customer', msg]);
    io.to(`order_${orderId}`).emit('new-order-chat-message', { order_id: orderId, from_user: 'Customer', message: msg, timestamp: new Date() });
    const customerResult = await pool.query('SELECT name, email FROM customers WHERE id = $1', [req.userId]);
    const customer = customerResult.rows[0];
    if (customer && customer.email) {
      try {
        const mailData = receivedEmail({ ...order, status: 'received' }, customer.name);
        await sendEmail({ to: customer.email, ...mailData });
      } catch (emailErr) {
        console.error('⚠️ Email send failed:', emailErr.message);
        logError(emailErr, 'Received email');
      }
    }
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    logError(err, 'Receive order');
    res.status(500).json({ error: err.message });
  }
});

// ---- ORDER CHAT ----
app.get('/api/orders/:id/chat', authMiddleware, async (req, res) => {
  const orderId = parseInt(req.params.id);
  try {
    const orderResult = await pool.query('SELECT customer_id FROM orders WHERE id = $1', [orderId]);
    if (orderResult.rows.length === 0) return res.status(404).json({ error: 'Order not found' });
    const order = orderResult.rows[0];
    if (req.role !== 'admin' && order.customer_id !== req.userId) return res.status(403).json({ error: 'Forbidden' });
    const result = await pool.query('SELECT * FROM order_chat_messages WHERE order_id = $1 ORDER BY timestamp ASC', [orderId]);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    logError(err, 'Get order chat');
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/orders/:id/chat', authMiddleware, async (req, res) => {
  const orderId = parseInt(req.params.id);
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: 'Message is required.' });
  try {
    const orderResult = await pool.query('SELECT customer_id FROM orders WHERE id = $1', [orderId]);
    if (orderResult.rows.length === 0) return res.status(404).json({ error: 'Order not found' });
    const order = orderResult.rows[0];
    const from = (req.role === 'admin') ? 'Seller' : 'Customer';
    if (req.role !== 'admin' && order.customer_id !== req.userId) return res.status(403).json({ error: 'Forbidden' });
    const result = await pool.query(
      'INSERT INTO order_chat_messages (order_id, from_user, message) VALUES ($1, $2, $3) RETURNING *',
      [orderId, from, message]
    );
    io.to(`order_${orderId}`).emit('new-order-chat-message', result.rows[0]);
    res.json({ success: true, msg: result.rows[0] });
  } catch (err) {
    console.error(err);
    logError(err, 'Order chat send');
    res.status(500).json({ error: err.message });
  }
});

// ---- ADMIN DASHBOARD ----
app.get('/api/admin/dashboard', authMiddleware, async (req, res) => {
  if (req.role !== 'admin') return res.status(403).json({ error: 'Admin only.' });
  try {
    const stats = {};
    const statuses = ['pending', 'confirmed', 'shipped', 'delivered', 'received', 'cancelled', 'pending_payment', 'completed'];
    for (const status of statuses) {
      const result = await pool.query('SELECT COUNT(*) FROM orders WHERE status = $1', [status]);
      stats[status] = parseInt(result.rows[0].count);
    }
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
    res.json(stats);
  } catch (err) {
    console.error(err);
    logError(err, 'Admin dashboard');
    res.status(500).json({ error: err.message });
  }
});

// ---- ADMIN RETURNS ----
app.get('/api/admin/returns', authMiddleware, async (req, res) => {
  if (req.role !== 'admin') return res.status(403).json({ error: 'Admin only.' });
  try {
    const result = await pool.query(`
      SELECT r.*, o.order_ref, c.name AS customer_name, c.email AS customer_email
      FROM returns r
      JOIN orders o ON r.order_id = o.id
      JOIN customers c ON r.customer_id = c.id
      ORDER BY r.requested_at DESC
    `);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    logError(err, 'Admin returns');
    res.status(500).json({ error: err.message });
  }
});

// ---- CUSTOMER RETURNS ----
app.get('/api/returns/customer', authMiddleware, async (req, res) => {
  if (req.role !== 'customer') return res.status(403).json({ error: 'Customer only.' });
  try {
    const result = await pool.query(
      'SELECT * FROM returns WHERE customer_id = $1 ORDER BY requested_at DESC',
      [req.userId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    logError(err, 'Customer returns');
    res.status(500).json({ error: err.message });
  }
});

// ---- ADMIN REMINDER ----
app.post('/api/admin/orders/:id/remind', authMiddleware, async (req, res) => {
  if (req.role !== 'admin') return res.status(403).json({ error: 'Admin only.' });
  const orderId = parseInt(req.params.id);
  try {
    const orderResult = await pool.query('SELECT customer_id, order_ref FROM orders WHERE id = $1 AND status = $2',
      [orderId, 'delivered']);
    if (orderResult.rows.length === 0) {
      return res.status(400).json({ error: 'Order not found or not in "delivered" state.' });
    }
    const customerId = orderResult.rows[0].customer_id;
    const ref = orderResult.rows[0].order_ref || `#${orderId}`;
    const customerResult = await pool.query('SELECT name FROM customers WHERE id = $1', [customerId]);
    const customerName = customerResult.rows[0]?.name || 'Customer';
    const message = `📢 Reminder: Dear ${customerName}, your order ${ref} has been delivered and is awaiting pickup. Please collect it within 7 working days. If you have already collected, please mark it as "Received" in your account. Thank you!`;
    await pool.query(
      'INSERT INTO order_chat_messages (order_id, from_user, message) VALUES ($1, $2, $3)',
      [orderId, 'System', message]
    );
    io.to(`order_${orderId}`).emit('new-order-chat-message', {
      order_id: orderId,
      from_user: 'System',
      message: message,
      timestamp: new Date()
    });
    await logAdminActivity(req.userId, 'SEND_REMINDER', { orderId });
    res.json({ success: true, message: 'Reminder sent.' });
  } catch (err) {
    console.error(err);
    logError(err, 'Admin reminder');
    res.status(500).json({ error: err.message });
  }
});

// ---- ADMIN LOGS ----
app.get('/api/admin/logs', authMiddleware, async (req, res) => {
  if (req.role !== 'admin') return res.status(403).json({ error: 'Admin only.' });
  try {
    const result = await pool.query(
      'SELECT * FROM admin_logs ORDER BY created_at DESC LIMIT 100'
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    logError(err, 'Admin logs');
    res.status(500).json({ error: err.message });
  }
});

// ---- ADMIN CUSTOMERS ----
app.get('/api/admin/customers', authMiddleware, async (req, res) => {
  if (req.role !== 'admin') return res.status(403).json({ error: 'Admin only.' });
  try {
    const result = await pool.query(`
      SELECT id, name, email, phone, created_at,
      (SELECT COUNT(*) FROM orders WHERE customer_id = customers.id) as order_count,
      (SELECT SUM(total) FROM orders WHERE customer_id = customers.id AND status IN ('confirmed', 'shipped', 'delivered', 'received', 'completed')) as total_spent
      FROM customers
      ORDER BY created_at DESC
    `);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    logError(err, 'Admin customers');
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/customers/:id', authMiddleware, async (req, res) => {
  if (req.role !== 'admin') return res.status(403).json({ error: 'Admin only.' });
  const id = parseInt(req.params.id);
  try {
    const result = await pool.query(`
      SELECT id, name, email, phone, created_at
      FROM customers WHERE id = $1
    `, [id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Customer not found' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    logError(err, 'Get customer');
    res.status(500).json({ error: err.message });
  }
});

// ---- BULK ORDER ACTIONS ----
app.post('/api/admin/orders/bulk', authMiddleware, async (req, res) => {
  if (req.role !== 'admin') return res.status(403).json({ error: 'Admin only.' });
  const { orderIds, action, status, tracking_number } = req.body;
  if (!orderIds || !Array.isArray(orderIds) || orderIds.length === 0) {
    return res.status(400).json({ error: 'No orders selected.' });
  }
  try {
    const results = [];
    for (const id of orderIds) {
      const orderId = parseInt(id);
      if (action === 'update_status' && status) {
        await pool.query(
          `UPDATE orders SET status = $1, updated_at = NOW() WHERE id = $2`,
          [status, orderId]
        );
        await appendOrderStatus(orderId, status, 'Bulk status update');
        results.push({ id: orderId, status });
      } else if (action === 'delete') {
        await pool.query('DELETE FROM order_items WHERE order_id = $1', [orderId]);
        await pool.query('DELETE FROM order_chat_messages WHERE order_id = $1', [orderId]);
        await pool.query('DELETE FROM orders WHERE id = $1', [orderId]);
        results.push({ id: orderId, action: 'deleted' });
      }
    }
    await logAdminActivity(req.userId, 'BULK_ORDER_ACTION', { action, count: orderIds.length });
    res.json({ success: true, results });
  } catch (err) {
    console.error(err);
    logError(err, 'Bulk order action');
    res.status(500).json({ error: err.message });
  }
});

// ---- EXPORT ORDERS CSV ----
app.get('/api/admin/orders/export', authMiddleware, async (req, res) => {
  if (req.role !== 'admin') return res.status(403).json({ error: 'Admin only.' });
  try {
    const result = await pool.query(`
      SELECT o.id, o.order_ref, o.created_at, o.status, o.total,
             c.name as customer_name, c.email as customer_email,
             o.delivery_address, o.recipient_name, o.recipient_phone
      FROM orders o
      JOIN customers c ON o.customer_id = c.id
      ORDER BY o.created_at DESC
    `);
    const rows = result.rows;
    if (rows.length === 0) {
      return res.status(404).json({ error: 'No orders to export.' });
    }

    let csv = 'Order ID,Reference,Date,Status,Total,Customer,Email,Delivery Address,Recipient,Phone\n';
    rows.forEach(row => {
      csv += `${row.id},${row.order_ref || 'N/A'},${new Date(row.created_at).toLocaleDateString()},${row.status},${row.total},${row.customer_name},${row.customer_email},${row.delivery_address || 'N/A'},${row.recipient_name || 'N/A'},${row.recipient_phone || 'N/A'}\n`;
    });

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename=orders-${new Date().toISOString().slice(0,10)}.csv`);
    res.send(csv);
  } catch (err) {
    console.error(err);
    logError(err, 'Export orders');
    res.status(500).json({ error: err.message });
  }
});

// ---- PDF RECEIPT ----
app.get('/api/orders/:id/receipt', authMiddleware, async (req, res) => {
  const orderId = parseInt(req.params.id);
  try {
    const orderResult = await pool.query(`
      SELECT o.*, c.name AS customer_name, c.email AS customer_email
      FROM orders o
      JOIN customers c ON o.customer_id = c.id
      WHERE o.id = $1
    `, [orderId]);
    if (orderResult.rows.length === 0) return res.status(404).json({ error: 'Order not found' });
    const order = orderResult.rows[0];
    if (req.role !== 'admin' && order.customer_id !== req.userId) return res.status(403).json({ error: 'Forbidden' });

    const itemsResult = await pool.query('SELECT * FROM order_items WHERE order_id = $1', [orderId]);
    const items = itemsResult.rows;

    const doc = new PDFDocument({ margin: 50 });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=receipt-${order.order_ref || order.id}.pdf`);
    doc.pipe(res);

    doc.fontSize(20).text('🧾 RECEIPT', { align: 'center' });
    doc.moveDown();
    doc.fontSize(12).text(`Order #: ${order.order_ref || order.id}`, { align: 'center' });
    doc.text(`Date: ${new Date(order.created_at).toLocaleString()}`, { align: 'center' });
    doc.text(`Status: ${order.status.toUpperCase()}`, { align: 'center' });
    doc.moveDown();

    doc.fontSize(14).text('👤 Customer Details:');
    doc.fontSize(12).text(`Name: ${order.customer_name}`);
    doc.text(`Email: ${order.customer_email}`);
    doc.moveDown();

    doc.fontSize(14).text('📍 Delivery Details:');
    doc.fontSize(12).text(`Address: ${order.delivery_address || 'N/A'}`);
    doc.text(`Recipient: ${order.recipient_name || 'N/A'} (${order.recipient_phone || 'N/A'})`);
    doc.moveDown();

    doc.fontSize(14).text('📦 Order Items:');
    doc.moveDown(0.5);
    let total = 0;
    items.forEach((item, index) => {
      const priceNum = parseFloat(item.price.replace(/[^0-9.]/g, '')) || 0;
      const subtotal = priceNum * item.quantity;
      total += subtotal;
      doc.fontSize(12).text(
        `${index + 1}. ${item.product_name} x${item.quantity} @ ${item.price} = Ksh ${subtotal.toFixed(2)}`
      );
      if (item.unique_id) {
        doc.fontSize(10).text(`   ID: ${item.unique_id}`, { indent: 20 });
      }
    });
    doc.moveDown();
    doc.fontSize(14).text(`Total: Ksh ${total.toFixed(2)}`, { align: 'right' });

    doc.moveDown(2);
    doc.fontSize(10).text('Thank you for your purchase! 🙏', { align: 'center' });
    doc.text('This is a system-generated receipt.', { align: 'center' });

    doc.end();
  } catch (err) {
    console.error(err);
    logError(err, 'PDF receipt');
    res.status(500).json({ error: err.message });
  }
});

// ---- SEND ORDER CONFIRMATION ----
app.post('/api/orders/:id/send-confirmation', authMiddleware, async (req, res) => {
  if (req.role !== 'admin') return res.status(403).json({ error: 'Admin only.' });

  const orderId = parseInt(req.params.id);

  try {
    const orderResult = await pool.query(`
      SELECT o.*, c.name AS customer_name, c.email AS customer_email
      FROM orders o
      JOIN customers c ON o.customer_id = c.id
      WHERE o.id = $1
    `, [orderId]);

    if (orderResult.rows.length === 0) {
      return res.status(404).json({ error: 'Order not found' });
    }

    const order = orderResult.rows[0];
    const itemsResult = await pool.query('SELECT * FROM order_items WHERE order_id = $1', [orderId]);
    const items = itemsResult.rows;

    const ref = order.order_ref || `#${order.id}`;
    let message = `✅ **Order ${ref} Confirmed!**\n\n`;
    message += `Dear ${order.customer_name},\n\n`;
    message += `Your order has been confirmed. Here are the details:\n\n`;
    message += `📦 **Order Items:**\n`;
    let total = 0;
    items.forEach((item, index) => {
      const priceNum = parseFloat(item.price.replace(/[^0-9.]/g, '')) || 0;
      const subtotal = priceNum * item.quantity;
      total += subtotal;
      const variant = item.variant_name || 'Default';
      const uniqueId = item.unique_id || '—';
      message += `${index+1}. ${item.product_name} (${variant}) x${item.quantity} – Ksh ${subtotal.toFixed(2)} (ID: ${uniqueId})\n`;
    });
    message += `\n💰 **Total:** Ksh ${Number(order.total).toFixed(2)}\n\n`;
    message += `📍 **Delivery Location:**\n`;
    message += `   ${order.delivery_address || 'Not provided'}\n`;
    if (order.recipient_name) message += `   👤 Recipient: ${order.recipient_name} (${order.recipient_phone || 'N/A'})\n`;
    if (order.delivery_instructions) message += `   📝 Instructions: ${order.delivery_instructions}\n`;
    if (order.customer_lat && order.customer_lng) {
      message += `   🗺️ GPS: ${order.customer_lat}, ${order.customer_lng}\n`;
    }
    message += `\n📅 Order Date: ${new Date(order.created_at).toLocaleString()}\n`;
    message += `🆔 Reference: ${ref}\n\n`;
    message += `Thank you for shopping with us! 🙏`;

    await pool.query(
      'INSERT INTO order_chat_messages (order_id, from_user, message) VALUES ($1, $2, $3)',
      [orderId, 'Seller', message]
    );

    io.to(`order_${orderId}`).emit('new-order-chat-message', {
      order_id: orderId,
      from_user: 'Seller',
      message: message,
      timestamp: new Date()
    });

    res.json({ success: true, message: '✅ Confirmation sent to customer.' });

  } catch (err) {
    console.error(err);
    logError(err, 'Send confirmation');
    res.status(500).json({ error: err.message });
  }
});

// ---- ASSET MINIFICATION ENDPOINT ----
app.post('/api/admin/minify', authMiddleware, async (req, res) => {
  if (req.role !== 'admin') {
    return res.status(403).json({ error: 'Admin only' });
  }
  
  try {
    const publicDir = path.join(__dirname, 'public');
    const files = fs.readdirSync(publicDir);
    const minified = [];
    let totalReduction = 0;
    
    for (const file of files) {
      if (file.endsWith('.js') || file.endsWith('.css')) {
        const filePath = path.join(publicDir, file);
        const content = fs.readFileSync(filePath, 'utf8');
        const originalSize = content.length;
        
        let minifiedContent = content
          .replace(/\/\/.*$/gm, '')
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/\s+/g, ' ')
          .replace(/;\s*/g, ';')
          .replace(/:\s*/g, ':')
          .replace(/{\s*/g, '{')
          .replace(/}\s*/g, '}')
          .replace(/\(\s*/g, '(')
          .replace(/\s*\)/g, ')')
          .trim();
        
        const minifiedSize = minifiedContent.length;
        const reduction = originalSize - minifiedSize;
        totalReduction += reduction;
        
        const minifiedPath = path.join(publicDir, file.replace(/\.(js|css)$/, '.min.$1'));
        fs.writeFileSync(minifiedPath, minifiedContent);
        minified.push(file);
        
        console.log(`✅ Minified ${file}: ${(reduction / 1024).toFixed(2)}KB saved`);
      }
    }
    
    await logAdminActivity(req.userId, 'MINIFY_ASSETS', { 
      files: minified,
      totalReduction: `${(totalReduction / 1024).toFixed(2)}KB`
    });
    
    res.json({
      success: true,
      message: `Minified ${minified.length} files`,
      files: minified,
      totalReduction: `${(totalReduction / 1024).toFixed(2)}KB`
    });
    
  } catch (err) {
    console.error('❌ Minify error:', err);
    logError(err, 'Minify');
    res.status(500).json({ error: err.message });
  }
});

// ---- ASSET STATS ENDPOINT ----
app.get('/api/admin/assets/stats', authMiddleware, async (req, res) => {
  if (req.role !== 'admin') {
    return res.status(403).json({ error: 'Admin only' });
  }
  
  try {
    const publicDir = path.join(__dirname, 'public');
    const files = fs.readdirSync(publicDir);
    let jsCount = 0, cssCount = 0, totalSize = 0;
    
    for (const file of files) {
      if (file.endsWith('.js')) {
        jsCount++;
        const stats = fs.statSync(path.join(publicDir, file));
        totalSize += stats.size;
      } else if (file.endsWith('.css')) {
        cssCount++;
        const stats = fs.statSync(path.join(publicDir, file));
        totalSize += stats.size;
      }
    }
    
    res.json({
      success: true,
      jsCount,
      cssCount,
      totalSize: (totalSize / 1024).toFixed(1) + ' KB'
    });
  } catch (err) {
    console.error('❌ Stats error:', err);
    logError(err, 'Asset stats');
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
//  CSRF TOKEN ENDPOINT (Disabled for now)
// ============================================================
app.get('/api/csrf-token', authMiddleware, (req, res) => {
  try {
    const token = crypto.randomBytes(32).toString('hex');
    res.json({ csrfToken: token });
  } catch (err) {
    logError(err, 'CSRF token');
    res.status(500).json({ error: 'Failed to generate CSRF token' });
  }
});

// ============================================================
//  SOCKET.IO
// ============================================================
io.use((socket, next) => {
  const token = socket.handshake.auth.token;
  if (!token) {
    socket.customerId = null;
    return next();
  }
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    socket.customerId = decoded.userId;
    socket.role = decoded.role;
    next();
  } catch (err) {
    next(new Error('Invalid token'));
  }
});

io.on('connection', (socket) => {
  console.log('Client connected:', socket.id, 'Customer ID:', socket.customerId);

  if (socket.customerId) {
    socket.join(`customer_${socket.customerId}`);
  }

  socket.on('chat-message', async (data) => {
    try {
      const { message } = data;
      if (!message || !socket.customerId) return;
      const result = await pool.query(
        'INSERT INTO chat_messages (customer_id, message, from_user) VALUES ($1, $2, $3) RETURNING *',
        [socket.customerId, message, 'Customer']
      );
      const newMsg = result.rows[0];
      const customerResult = await pool.query('SELECT name FROM customers WHERE id = $1', [socket.customerId]);
      const customerName = customerResult.rows[0]?.name || 'Customer';
      io.emit('new-chat-message', { ...newMsg, customer_name: customerName });
    } catch (err) {
      console.error(err);
      logError(err, 'Socket chat');
    }
  });

  socket.on('seller-chat-message', async (data) => {
    try {
      const { message } = data;
      if (!message) return;
      const result = await pool.query(
        'INSERT INTO chat_messages (from_user, message) VALUES ($1, $2) RETURNING *',
        ['Seller', message]
      );
      const newMsg = result.rows[0];
      io.emit('new-chat-message', { ...newMsg, customer_name: 'Seller' });
    } catch (err) {
      console.error(err);
      logError(err, 'Socket seller chat');
    }
  });

  socket.on('request-chat-history', async () => {
    try {
      const result = await pool.query(
        'SELECT cm.*, c.name AS customer_name FROM chat_messages cm LEFT JOIN customers c ON cm.customer_id = c.id ORDER BY timestamp ASC'
      );
      const history = result.rows.map(row => ({
        from: row.from_user,
        message: row.message,
        timestamp: row.timestamp,
        customer_name: row.customer_name
      }));
      socket.emit('chat-history', history);
    } catch (err) {
      console.error('Error fetching chat history:', err);
      logError(err, 'Socket chat history');
      socket.emit('chat-history', []);
    }
  });

  socket.on('customer-location', (data) => {
    socket.broadcast.emit('customer-update', {
      socketId: socket.id,
      lat: data.lat,
      lng: data.lng,
      name: data.name || 'Customer'
    });
  });

  socket.on('get-customers', () => {
    socket.emit('customer-list', []);
  });

  socket.on('join-order-room', (orderId) => {
    socket.join(`order_${orderId}`);
  });
  
  socket.on('leave-order-room', (orderId) => {
    socket.leave(`order_${orderId}`);
  });

  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
    socket.broadcast.emit('customer-left', socket.id);
  });
});

// ---------- Global Error Handler ----------
app.use((err, req, res, next) => {
  console.error('❌ Unhandled error:', err);
  logError(err, 'Global error handler');
  res.status(500).json({ error: 'Internal server error' });
});

// ---------- Create password_resets table if not exists ----------
async function initDatabase() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS password_resets (
        email VARCHAR(255) PRIMARY KEY,
        token VARCHAR(255) NOT NULL,
        expires_at TIMESTAMP NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('✅ Password resets table ready');
    
    // Create logs directory
    const logDir = path.join(__dirname, 'logs');
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
      console.log('✅ Logs directory created');
    }
  } catch (err) {
    console.error('❌ Error creating password_resets table:', err);
    logError(err, 'Database init');
  }
}

// ---------- Start Server ----------
initDatabase();
server.listen(PORT, () => {
  console.log(`🚀 Server running at http://localhost:${PORT}`);
  console.log(`☁️ Cloudinary ready`);
  console.log(`📦 PostgreSQL connected`);
  console.log(`💰 M-Pesa integration ready`);
  console.log(`📱 Airtel Money integration ready`);
  console.log(`💳 PayPal integration ready`);
  console.log(`📧 Email system ready`);
  console.log(`🔒 Security features enabled`);
  console.log(`⏰ Auto-cancel job scheduled`);
  console.log(`📊 Redis caching ${process.env.REDIS_URL ? 'enabled' : 'disabled (memory cache)'}`);
});