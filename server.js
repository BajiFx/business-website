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
const csrf = require('csurf');
const PDFDocument = require('pdfkit');
require('dotenv').config();

// Increase max listeners to avoid warnings
process.setMaxListeners(20);

// ---- Email templates ----
let orderConfirmationEmail, statusUpdateEmail, receivedEmail;
try {
  const email = require('./email');
  orderConfirmationEmail = email.orderConfirmationEmail;
  statusUpdateEmail = email.statusUpdateEmail;
  receivedEmail = email.receivedEmail;
} catch (e) {
  console.warn('⚠️ Email module not loaded – email features disabled.');
  orderConfirmationEmail = () => ({ subject: '', html: '', text: '' });
  statusUpdateEmail = () => ({ subject: '', html: '', text: '' });
  receivedEmail = () => ({ subject: '', html: '', text: '' });
}

// ---- Nodemailer ----
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: process.env.SMTP_PORT,
  secure: process.env.SMTP_SECURE === 'true',
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

async function sendEmail({ to, subject, html, text }) {
  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
    console.warn('SMTP credentials not set, email not sent.');
    return;
  }
  try {
    await transporter.sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      to,
      subject,
      html,
      text,
    });
    console.log(`📧 Email sent to ${to}`);
  } catch (err) {
    console.error('❌ Email send error:', err);
  }
}

// ---- Express app ----
const app = express();
const server = http.createServer(app);
const io = socketIo(server);

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET;

if (!JWT_SECRET) {
  console.error('❌ Missing JWT_SECRET in .env');
  process.exit(1);
}

// ---------- Cloudinary ----------
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});
console.log('✅ Cloudinary configured');

// ---------- PostgreSQL (Improved Connection) ----------
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }, // still works, ignores SSL warning
  max: 20,
  idleTimeoutMillis: 10000,           // shorter idle timeout
  connectionTimeoutMillis: 5000,
  keepAlive: true,                    // important to prevent disconnections
});

// Handle pool errors globally
pool.on('error', (err) => {
  console.error('⚠️ PostgreSQL pool error:', err);
  console.log('🔄 Attempting to reconnect...');
  // The pool will automatically attempt to reconnect, but we can also manually retry
});

// Test connection on startup
pool.connect((err, client, release) => {
  if (err) {
    console.error('❌ Database connection failed:', err);
    // Retry after 5 seconds
    setTimeout(() => {
      console.log('🔄 Retrying database connection...');
      pool.connect((err2, client2, release2) => {
        if (err2) {
          console.error('❌ Database still unreachable:', err2);
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

// ---- Graceful shutdown: close pool ----
process.on('SIGINT', () => {
  pool.end(() => {
    console.log('🔌 Database pool closed');
    process.exit(0);
  });
});

process.on('uncaughtException', (err) => {
  console.error('❌ Uncaught Exception:', err);
  // Don't exit, just log – keep server running
});

process.on('unhandledRejection', (reason) => {
  console.error('❌ Unhandled Rejection:', reason);
});

// ---------- Security ----------
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
      connectSrc: ["'self'", "ws://localhost:3000", "wss://*.onrender.com", "https://unpkg.com"],
      objectSrc: ["'none'"],
    },
  },
  crossOriginEmbedderPolicy: false,
}));

app.use(cors({ origin: process.env.CLIENT_URL || '*' }));
app.use(express.json());
app.use(express.static('public'));

// ---------- Rate Limiter ----------
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

// ---------- File Upload ----------
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

// ---------- Cloudinary upload helper ----------
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
    const localPath = '/uploads/' + path.basename(filePath);
    console.log('⚠️ Using local fallback:', localPath);
    return localPath;
  }
}

function getHeroImage(row) {
  if (!row) return null;
  return row.heroImage || row.heroimage || null;
}

// ---------- JWT Auth ----------
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

// ---------- Admin Activity Logger ----------
async function logAdminActivity(adminId, action, details = {}) {
  try {
    await pool.query(
      'INSERT INTO admin_logs (admin_id, action, details, created_at) VALUES ($1, $2, $3, NOW())',
      [adminId, action, JSON.stringify(details)]
    );
  } catch (err) {
    console.error('Error logging admin activity:', err);
  }
}

// ---------- Order Reference Generator ----------
function generateOrderRef() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let ref = '';
  for (let i = 0; i < 15; i++) {
    ref += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return ref;
}

// ---------- Helper: append status history ----------
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

// ---- Distance calculation ----
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

// ---- Helper: get system setting ----
async function getSetting(key, defaultValue) {
  const result = await pool.query('SELECT value FROM system_settings WHERE key = $1', [key]);
  if (result.rows.length === 0) return defaultValue;
  return result.rows[0].value;
}

// ============================================================
// API ROUTES
// ============================================================

// ---- CSRF Token ----
app.get('/api/csrf-token', csrf({ cookie: true }), (req, res) => {
  res.json({ csrfToken: req.csrfToken() });
});

// ---- SHOP profile ----
app.get('/api/shop', async (req, res) => {
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
        paypal_enabled: false, paypal_email: ''
      });
    }
    const row = result.rows[0];
    const heroImage = getHeroImage(row);
    res.json({ ...row, heroImage });
  } catch (err) {
    console.error(err);
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
      paypal_enabled, paypal_email
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
          paypal_enabled, paypal_email
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)
        RETURNING *
      `, [name, location, address, latitude, longitude, description, mission, vision,
          logo, heroImage, whatsapp, tiktok, instagram, facebook, phone,
          mpesa_enabled === 'true', mpesa_number,
          airtel_enabled === 'true', airtel_number,
          bank_enabled === 'true', bank_name, bank_account, bank_account_name,
          paypal_enabled === 'true', paypal_email]);
      updatedRow = insertResult.rows[0];
    } else {
      const fields = ['name','location','address','latitude','longitude','description','mission','vision',
                      'whatsapp','tiktok','instagram','facebook','phone',
                      'mpesa_enabled','mpesa_number',
                      'airtel_enabled','airtel_number',
                      'bank_enabled','bank_name','bank_account','bank_account_name',
                      'paypal_enabled','paypal_email'];
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
    res.status(500).json({ error: err.message });
  }
});

// ---- Products ----
app.get('/api/products', async (req, res) => {
  try {
    const { search, limit } = req.query;
    let query = 'SELECT * FROM products';
    let params = [];
    if (search) {
      query += ' WHERE name ILIKE $1';
      params.push(`%${search}%`);
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
      return { ...product, variants, image: firstImage };
    }));
    res.json(products);
  } catch (err) {
    console.error(err);
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
    res.status(500).json({ error: err.message });
  }
});

// ---- Product CRUD ----
app.post('/api/products', authMiddleware, upload.fields([{ name: 'image' }, { name: 'variantImages' }]), async (req, res) => {
  try {
    const { name, price, contact, rating, badge1, badge2, shipping, isFlashSale, isNewArrival, description,
            shipping_fee, free_shipping_eligible, return_enabled, return_window_days, restocking_fee_percent,
            return_shipping_paid_by, return_condition, variants } = req.body;

    let mainImage = null;
    if (req.files['image']) {
      const file = req.files['image'][0];
      mainImage = await uploadToCloudinary(file.path);
      fs.unlink(file.path, (err) => { if (err) console.error('Failed to delete local file:', err); });
    }

    const result = await pool.query(`
      INSERT INTO products (name, price, contact, rating, badge1, badge2, shipping, isFlashSale, isNewArrival,
        image, description, shipping_fee, free_shipping_eligible, return_enabled, return_window_days,
        restocking_fee_percent, return_shipping_paid_by, return_condition)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING *
    `, [name, price, contact, rating, badge1, badge2, shipping, isFlashSale === 'true', isNewArrival === 'true',
        mainImage, description, shipping_fee, free_shipping_eligible === 'true', return_enabled !== 'false',
        return_window_days || 14, restocking_fee_percent || 0, return_shipping_paid_by || 'buyer',
        return_condition || 'unopened']);

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
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/products/:id', authMiddleware, upload.fields([{ name: 'image' }, { name: 'variantImages' }]), async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { name, price, contact, rating, badge1, badge2, shipping, isFlashSale, isNewArrival, description,
            shipping_fee, free_shipping_eligible, return_enabled, return_window_days, restocking_fee_percent,
            return_shipping_paid_by, return_condition, variants } = req.body;

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
      SET name = $1, price = $2, contact = $3, rating = $4, badge1 = $5, badge2 = $6,
          shipping = $7, isFlashSale = $8, isNewArrival = $9, image = $10,
          description = $11, shipping_fee = $12, free_shipping_eligible = $13,
          return_enabled = $14, return_window_days = $15, restocking_fee_percent = $16,
          return_shipping_paid_by = $17, return_condition = $18
      WHERE id = $19 RETURNING *
    `, [name, price, contact, rating, badge1, badge2, shipping, isFlashSale === 'true', isNewArrival === 'true',
        image, description, shipping_fee, free_shipping_eligible === 'true', return_enabled !== 'false',
        return_window_days || 14, restocking_fee_percent || 0, return_shipping_paid_by || 'buyer',
        return_condition || 'unopened', id]);

    const product = result.rows[0];

    await pool.query('DELETE FROM product_variants WHERE product_id = $1', [id]);

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
    res.status(500).json({ error: err.message });
  }
});

// ---- Product Reviews ----
app.post('/api/products/:id/review', authMiddleware, [
  body('rating').isInt({ min: 1, max: 5 }).withMessage('Rating must be 1-5'),
  body('review_text').isLength({ min: 3 }).withMessage('Review must be at least 3 characters')
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
    res.json({ success: true, token, message: 'Admin account created successfully!' });
  } catch (err) {
    console.error(err);
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
  body('password').isLength({ min: 6 }).withMessage('Password must be at least 6 characters')
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  try {
    const { name, email, password } = req.body;
    const existing = await pool.query('SELECT * FROM customers WHERE email = $1', [email]);
    if (existing.rows.length > 0) return res.status(409).json({ error: 'Email already registered.' });
    const hashedPassword = await bcrypt.hash(password, 10);
    const result = await pool.query(
      'INSERT INTO customers (name, email, password) VALUES ($1, $2, $3) RETURNING id, name, email',
      [name, email, hashedPassword]
    );
    const customer = result.rows[0];
    await pool.query('INSERT INTO carts (customer_id, items) VALUES ($1, $2)', [customer.id, '[]']);
    const token = generateToken(customer.id, 'customer');
    res.json({ success: true, token, customer });
  } catch (err) {
    console.error(err);
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
    await pool.query(
      'INSERT INTO carts (customer_id, items) VALUES ($1, $2) ON CONFLICT (customer_id) DO NOTHING',
      [customer.id, '[]']
    );
    const token = generateToken(customer.id, 'customer');
    res.json({ success: true, token, customer: { id: customer.id, name: customer.name, email: customer.email } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/auth/customer/verify', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query('SELECT id, name, email, created_at FROM customers WHERE id = $1', [req.userId]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'User not found' });
    res.json({ user: result.rows[0] });
  } catch (err) {
    console.error(err);
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
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/addresses', authMiddleware, [
  body('label').notEmpty().withMessage('Label required'),
  body('address').notEmpty().withMessage('Address required')
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  const { label, address, lat, lng, location_name } = req.body;
  try {
    const countResult = await pool.query('SELECT COUNT(*) FROM customer_addresses WHERE customer_id = $1', [req.userId]);
    const isDefault = parseInt(countResult.rows[0].count) === 0;
    await pool.query(
      `INSERT INTO customer_addresses (customer_id, label, address, lat, lng, location_name, is_default)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [req.userId, label, address, lat || null, lng || null, location_name || null, isDefault]
    );
    res.json({ success: true });
  } catch (err) {
    console.error(err);
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
    res.json({ valid: true, discount, message: 'Promo applied!' });
  } catch (err) {
    console.error(err);
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
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/customer/chat', authMiddleware, async (req, res) => {
  if (req.role !== 'customer') return res.status(403).json({ error: 'Customer only' });
  try {
    const result = await pool.query(
      `SELECT cm.*, c.name AS customer_name
       FROM chat_messages cm
       LEFT JOIN customers c ON cm.customer_id = c.id
       WHERE cm.customer_id = $1
       ORDER BY timestamp DESC LIMIT 20`,
      [req.userId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
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
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// PAYMENT ROUTES
// ============================================================

async function initiateMpesaPayment(phone, amount, orderId, accountRef) {
  try {
    const consumerKey = process.env.MPESA_CONSUMER_KEY;
    const consumerSecret = process.env.MPESA_CONSUMER_SECRET;
    const passkey = process.env.MPESA_PASSKEY;
    const shortcode = process.env.MPESA_SHORTCODE;

    if (!consumerKey || !consumerSecret) {
      console.warn('⚠️ M-Pesa credentials not set. Using simulation.');
      return {
        success: true,
        transactionId: `SIM-${Date.now()}`,
        message: 'M-Pesa payment simulated successfully'
      };
    }

    const auth = Buffer.from(`${consumerKey}:${consumerSecret}`).toString('base64');
    const tokenRes = await fetch('https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials', {
      headers: { Authorization: `Basic ${auth}` }
    });
    const tokenData = await tokenRes.json();
    const accessToken = tokenData.access_token;

    let formattedPhone = phone.replace(/^0/, '254').replace(/^\+/, '');
    const timestamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
    const password = Buffer.from(`${shortcode}${passkey}${timestamp}`).toString('base64');

    const stkRes = await fetch('https://sandbox.safaricom.co.ke/mpesa/stkpush/v1/processrequest', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        BusinessShortCode: shortcode,
        Password: password,
        Timestamp: timestamp,
        TransactionType: 'CustomerPayBillOnline',
        Amount: Math.round(amount),
        PartyA: formattedPhone,
        PartyB: shortcode,
        PhoneNumber: formattedPhone,
        CallBackURL: `${process.env.CLIENT_URL}/api/payments/mpesa-callback`,
        AccountReference: accountRef || `ORD-${orderId}`,
        TransactionDesc: 'Payment for order'
      })
    });

    const stkData = await stkRes.json();

    if (stkData.ResponseCode === '0') {
      return {
        success: true,
        transactionId: stkData.CheckoutRequestID,
        message: 'STK Push sent successfully'
      };
    } else {
      return {
        success: false,
        message: stkData.ResponseDescription || 'STK Push failed'
      };
    }
  } catch (err) {
    console.error('M-Pesa error:', err);
    return {
      success: false,
      message: err.message || 'M-Pesa payment failed'
    };
  }
}

app.post('/api/payments/mpesa-callback', async (req, res) => {
  try {
    const body = req.body;
    console.log('M-Pesa Callback:', JSON.stringify(body));

    const resultCode = body?.Body?.stkCallback?.ResultCode;
    const resultDesc = body?.Body?.stkCallback?.ResultDesc;
    const checkoutRequestID = body?.Body?.stkCallback?.CheckoutRequestID;
    const transactionId = body?.Body?.stkCallback?.CallbackMetadata?.Item?.find(i => i.Name === 'MpesaReceiptNumber')?.Value;
    const amount = body?.Body?.stkCallback?.CallbackMetadata?.Item?.find(i => i.Name === 'Amount')?.Value;

    const isSuccess = resultCode === '0';

    const paymentResult = await pool.query(
      'SELECT id, order_id FROM payments WHERE transaction_id = $1 AND method = $2 ORDER BY created_at DESC LIMIT 1',
      [checkoutRequestID, 'mpesa']
    );

    if (paymentResult.rows.length > 0) {
      const payment = paymentResult.rows[0];
      const orderId = payment.order_id;

      await pool.query(
        'UPDATE payments SET status = $1, transaction_id = $2, updated_at = NOW() WHERE id = $3',
        [isSuccess ? 'success' : 'failed', transactionId || checkoutRequestID, payment.id]
      );

      if (isSuccess && orderId) {
        await pool.query('UPDATE orders SET payment_status = $1 WHERE id = $2', ['paid', orderId]);
        await pool.query(
          `UPDATE orders SET status = 'pending' WHERE id = $1 AND status = 'pending_payment'`,
          [orderId]
        );
        await appendOrderStatus(orderId, 'pending', 'Payment successful. Order confirmed.');

        const orderResult = await pool.query('SELECT * FROM orders WHERE id = $1', [orderId]);
        const customerResult = await pool.query('SELECT name, email FROM customers WHERE id = $1', [orderResult.rows[0].customer_id]);
        if (orderResult.rows.length > 0 && customerResult.rows.length > 0) {
          try {
            const mailData = orderConfirmationEmail(orderResult.rows[0], customerResult.rows[0].name);
            await sendEmail({ to: customerResult.rows[0].email, ...mailData });
          } catch (emailErr) {
            console.error('⚠️ Email send failed:', emailErr.message);
          }
        }

        io.emit('new-order', { orderId });
        io.to(`order_${orderId}`).emit('payment-updated', { orderId, paymentStatus: 'paid' });
      }
    }

    res.json({ ResultCode: 0, ResultDesc: 'Success' });
  } catch (err) {
    console.error('M-Pesa callback error:', err);
    res.status(500).json({ ResultCode: 1, ResultDesc: 'Error processing callback' });
  }
});

app.post('/api/payments/mpesa', authMiddleware, [
  body('phone').isMobilePhone().withMessage('Invalid phone number'),
  body('amount').isNumeric().withMessage('Amount must be a number'),
  body('orderId').isInt().withMessage('Order ID required')
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  try {
    const { phone, amount, orderId } = req.body;
    const accountRef = `ORD-${orderId}`;

    const paymentResult = await pool.query(
      `INSERT INTO payments (customer_id, order_id, amount, method, status, transaction_id, payment_details)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [req.userId, orderId, amount, 'mpesa', 'pending', null, JSON.stringify({ phone })]
    );

    const payment = paymentResult.rows[0];

    const result = await initiateMpesaPayment(phone, amount, orderId, accountRef);

    if (result.success) {
      await pool.query(
        'UPDATE payments SET transaction_id = $1 WHERE id = $2',
        [result.transactionId, payment.id]
      );
      res.json({
        success: true,
        message: 'STK Push sent to your phone. Please enter PIN to complete payment.',
        transactionId: result.transactionId
      });
    } else {
      await pool.query(
        'UPDATE payments SET status = $1 WHERE id = $2',
        ['failed', payment.id]
      );
      res.json({
        success: false,
        message: result.message || 'M-Pesa payment failed. Please try again.'
      });
    }
  } catch (err) {
    console.error('M-Pesa initiation error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/payments/airtel', authMiddleware, [
  body('phone').isMobilePhone().withMessage('Invalid phone number'),
  body('amount').isNumeric().withMessage('Amount must be a number'),
  body('orderId').isInt().withMessage('Order ID required')
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  try {
    const { phone, amount, orderId } = req.body;

    if (!process.env.AIRTEL_API_KEY || !process.env.AIRTEL_API_SECRET) {
      const transactionId = `AIRTEL-SIM-${Date.now()}`;
      await pool.query(
        `INSERT INTO payments (customer_id, order_id, amount, method, status, transaction_id, payment_details)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [req.userId, orderId, amount, 'airtel', 'success', transactionId, JSON.stringify({ phone })]
      );

      await pool.query('UPDATE orders SET payment_status = $1 WHERE id = $2', ['paid', orderId]);
      await pool.query(
        `UPDATE orders SET status = 'pending' WHERE id = $1 AND status = 'pending_payment'`,
        [orderId]
      );
      await appendOrderStatus(orderId, 'pending', 'Payment successful (simulated). Order confirmed.');

      io.emit('new-order', { orderId });
      io.to(`order_${orderId}`).emit('payment-updated', { orderId, paymentStatus: 'paid' });

      return res.json({
        success: true,
        message: 'Airtel Money payment simulated successfully. Order confirmed.',
        transactionId
      });
    }

    const airtelResponse = await fetch('https://api.airtel.ke/payments', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.AIRTEL_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ phone, amount, orderId })
    });

    const result = await airtelResponse.json();

    if (result.success) {
      await pool.query(
        `INSERT INTO payments (customer_id, order_id, amount, method, status, transaction_id, payment_details)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [req.userId, orderId, amount, 'airtel', 'success', result.transactionId, JSON.stringify({ phone })]
      );

      await pool.query('UPDATE orders SET payment_status = $1 WHERE id = $2', ['paid', orderId]);
      await pool.query(
        `UPDATE orders SET status = 'pending' WHERE id = $1 AND status = 'pending_payment'`,
        [orderId]
      );
      await appendOrderStatus(orderId, 'pending', 'Payment successful. Order confirmed.');

      io.emit('new-order', { orderId });
      io.to(`order_${orderId}`).emit('payment-updated', { orderId, paymentStatus: 'paid' });

      res.json({ success: true, message: 'Airtel Money payment successful!', transactionId: result.transactionId });
    } else {
      res.json({ success: false, message: result.message || 'Airtel Money payment failed' });
    }
  } catch (err) {
    console.error('Airtel error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/payments/bank', authMiddleware, [
  body('reference').notEmpty().withMessage('Transaction reference required'),
  body('amount').isNumeric().withMessage('Amount must be a number'),
  body('orderId').isInt().withMessage('Order ID required')
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  try {
    const { reference, amount, orderId } = req.body;

    await pool.query(
      `INSERT INTO payments (customer_id, order_id, amount, method, status, transaction_id, payment_details)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [req.userId, orderId, amount, 'bank', 'pending', reference, JSON.stringify({ reference })]
    );

    io.emit('bank-transfer-pending', { orderId, reference, amount });

    res.json({
      success: true,
      message: 'Bank transfer recorded. Awaiting admin confirmation.',
      status: 'pending'
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/admin/payments/bank/:paymentId/confirm', authMiddleware, async (req, res) => {
  if (req.role !== 'admin') return res.status(403).json({ error: 'Admin only.' });
  const paymentId = parseInt(req.params.id);
  const { action } = req.body;

  try {
    const paymentResult = await pool.query(
      'SELECT order_id, amount FROM payments WHERE id = $1 AND method = $2',
      [paymentId, 'bank']
    );
    if (paymentResult.rows.length === 0) return res.status(404).json({ error: 'Payment not found' });

    const payment = paymentResult.rows[0];

    if (action === 'confirm') {
      await pool.query(
        'UPDATE payments SET status = $1, updated_at = NOW() WHERE id = $2',
        ['success', paymentId]
      );
      await pool.query('UPDATE orders SET payment_status = $1 WHERE id = $2', ['paid', payment.order_id]);
      await pool.query(
        `UPDATE orders SET status = 'pending' WHERE id = $1 AND status = 'pending_payment'`,
        [payment.order_id]
      );
      await appendOrderStatus(payment.order_id, 'pending', 'Bank payment confirmed. Order confirmed.');
      io.emit('new-order', { orderId: payment.order_id });
      io.to(`order_${payment.order_id}`).emit('payment-updated', { orderId: payment.order_id, paymentStatus: 'paid' });
      await logAdminActivity(req.userId, 'CONFIRM_BANK_PAYMENT', { paymentId, orderId: payment.order_id });
      res.json({ success: true, message: 'Bank transfer confirmed.' });
    } else {
      await pool.query(
        'UPDATE payments SET status = $1, updated_at = NOW() WHERE id = $2',
        ['failed', paymentId]
      );
      res.json({ success: true, message: 'Bank transfer rejected.' });
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
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
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// ORDERS
// ============================================================

app.post('/api/orders', authMiddleware, [
  body('items').isArray().withMessage('Items must be an array'),
  body('total').isNumeric().withMessage('Total must be a number'),
  body('address_id').isInt().withMessage('Address required')
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  if (req.role !== 'customer') {
    return res.status(403).json({ error: 'Only customers can place orders.' });
  }

  const customerId = req.userId;
  const { items, total, shipping_tier, shipping_cost, order_notes, address_id, promo_code, discount } = req.body;

  try {
    const addrCheck = await pool.query(
      'SELECT id, address, location_name FROM customer_addresses WHERE id = $1 AND customer_id = $2',
      [address_id, customerId]
    );
    if (addrCheck.rows.length === 0) return res.status(400).json({ error: 'Invalid address.' });
    const addressData = addrCheck.rows[0];

    let orderRef;
    let unique = false;
    while (!unique) {
      orderRef = generateOrderRef();
      const check = await pool.query('SELECT id FROM orders WHERE order_ref = $1', [orderRef]);
      if (check.rows.length === 0) unique = true;
    }

    let appliedDiscount = discount || 0;
    if (promo_code) {
      const promoResult = await pool.query(
        'SELECT * FROM promo_codes WHERE code = $1 AND active = true AND (expires_at IS NULL OR expires_at > NOW()) AND (usage_limit IS NULL OR used_count < usage_limit)',
        [promo_code.toUpperCase()]
      );
      if (promoResult.rows.length > 0) {
        const promo = promoResult.rows[0];
        await pool.query('UPDATE promo_codes SET used_count = used_count + 1 WHERE id = $1', [promo.id]);
      } else {
        appliedDiscount = 0;
      }
    }

    const urgent = shipping_tier === 'overnight';

    await pool.query('BEGIN');
    const orderResult = await pool.query(`
      INSERT INTO orders (customer_id, total, status, order_ref, status_history, shipping_tier, shipping_cost,
        order_notes, address_id, promo_code, discount_applied, delivery_location_name, urgent_delivery, payment_status)
      VALUES ($1, $2, 'pending_payment', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'pending') RETURNING *
    `, [customerId, total, orderRef, JSON.stringify([{ status: 'pending_payment', timestamp: new Date().toISOString() }]),
        shipping_tier || 'standard', shipping_cost || 0, order_notes || null, address_id || null,
        promo_code || null, appliedDiscount, addressData.location_name || addressData.address, urgent]);

    const order = orderResult.rows[0];

    for (const item of items) {
      const uniqueId = generateOrderRef();
      await pool.query(`
        INSERT INTO order_items (order_id, product_id, product_name, price, quantity, image, unique_id, variant_name, variant_id)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      `, [order.id, item.productId || 0, item.name, item.price, item.quantity, item.image || '',
          uniqueId, item.variant_name || 'Default', item.variant_id || null]);
    }

    await pool.query('UPDATE carts SET items = $1, reserved_until = NULL WHERE customer_id = $2', ['[]', customerId]);

    await pool.query('COMMIT');

    io.emit('new-order', { orderId: order.id });

    res.status(201).json({ success: true, order, requiresPayment: true });

  } catch (err) {
    await pool.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/orders', authMiddleware, async (req, res) => {
  try {
    let query = `
      SELECT o.*, c.name AS customer_name, c.email AS customer_email
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
      const { status, search, startDate, endDate } = req.query;
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
    const result = await pool.query(query, params);
    const ordersWithItems = await Promise.all(result.rows.map(async (order) => {
      const itemsResult = await pool.query('SELECT * FROM order_items WHERE order_id = $1', [order.id]);
      return { ...order, items: itemsResult.rows };
    }));
    res.json(ordersWithItems);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

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
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/orders/:id/location', authMiddleware, async (req, res) => {
  const orderId = parseInt(req.params.id);
  const { lat, lng, address, location_name } = req.body;
  if (!lat || !lng) return res.status(400).json({ error: 'Location coordinates required.' });
  try {
    const orderCheck = await pool.query('SELECT customer_id, order_ref FROM orders WHERE id = $1', [orderId]);
    if (orderCheck.rows.length === 0) return res.status(404).json({ error: 'Order not found' });
    if (orderCheck.rows[0].customer_id !== req.userId) return res.status(403).json({ error: 'Forbidden' });
    const shopResult = await pool.query('SELECT latitude, longitude FROM shop LIMIT 1');
    const shop = shopResult.rows[0];
    if (!shop || !shop.latitude || !shop.longitude) {
      return res.status(400).json({ error: 'Shop location not set. Contact admin.' });
    }
    const distance = getDistance(parseFloat(shop.latitude), parseFloat(shop.longitude), parseFloat(lat), parseFloat(lng));
    const days = estimateDeliveryDays(distance);
    const locationData = { lat, lng, address: address || '', location_name: location_name || address || '' };
    await pool.query(
      `UPDATE orders SET delivery_location = $1, estimated_delivery_days = $2, delivery_location_name = $3 WHERE id = $4`,
      [JSON.stringify(locationData), days, locationData.location_name, orderId]
    );
    const customerResult = await pool.query('SELECT name FROM customers WHERE id = $1', [req.userId]);
    const customerName = customerResult.rows[0]?.name || 'Customer';
    const ref = orderCheck.rows[0].order_ref || `#${orderId}`;
    const msg = `Hello ${customerName}, your order ${ref} will be delivered to: ${locationData.location_name}. Estimated delivery in ${days} days.`;
    await pool.query(
      `INSERT INTO order_chat_messages (order_id, from_user, message) VALUES ($1, 'System', $2)`,
      [orderId, msg]
    );
    io.to(`order_${orderId}`).emit('new-order-chat-message', { order_id: orderId, from_user: 'System', message: msg, timestamp: new Date() });
    res.json({ success: true, estimated_days: days, distance: distance.toFixed(2) + ' km', location_name: locationData.location_name });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

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
      case 'pending_payment': statusMessage = 'Awaiting payment confirmation.'; break;
      case 'pending': statusMessage = 'Your order is being reviewed.'; break;
      case 'confirmed': statusMessage = 'Your order is confirmed and being prepared.'; break;
      case 'shipped': statusMessage = 'Your order is on the way.'; break;
      case 'delivered': statusMessage = 'Please collect within 7 working days.'; break;
      case 'received': statusMessage = 'You have confirmed receipt. Thank you!'; break;
      case 'cancelled': statusMessage = 'This order has been cancelled.'; break;
      default: statusMessage = 'Status unknown.';
    }
    res.json({ ...order, statusMessage });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

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
    res.status(500).json({ error: err.message });
  }
});

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
    if (orderCheck.rows[0].status === 'cancelled' || orderCheck.rows[0].status === 'received') {
      return res.status(400).json({ error: 'This order cannot be refunded.' });
    }
    await pool.query(`UPDATE orders SET refund_request = $1, refund_status = 'pending' WHERE id = $2`, [reason, orderId]);
    const msg = `💰 Refund requested for order #${orderId}. Reason: ${reason}`;
    await pool.query('INSERT INTO order_chat_messages (order_id, from_user, message) VALUES ($1, $2, $3)', [orderId, 'System', msg]);
    io.to(`order_${orderId}`).emit('new-order-chat-message', { order_id: orderId, from_user: 'System', message: msg, timestamp: new Date() });
    res.json({ success: true, message: 'Refund request submitted.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

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
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/orders/:id/replace', authMiddleware, async (req, res) => {
  if (req.role !== 'customer') return res.status(403).json({ error: 'Customer only.' });
  const orderId = parseInt(req.params.id);
  const { oldProductIds, newProductIds } = req.body;
  try {
    const orderCheck = await pool.query('SELECT customer_id, status, created_at FROM orders WHERE id = $1', [orderId]);
    if (orderCheck.rows.length === 0) return res.status(404).json({ error: 'Order not found' });
    const order = orderCheck.rows[0];
    if (order.customer_id !== req.userId) return res.status(403).json({ error: 'Forbidden' });
    const hoursSinceOrder = (Date.now() - new Date(order.created_at).getTime()) / (1000 * 60 * 60);
    const maxHours = parseInt(await getSetting('replacement_hours', '6'));
    if (hoursSinceOrder > maxHours) {
      return res.status(400).json({ error: `Replacement only allowed within ${maxHours} hours of order placement.` });
    }
    const oldItemsResult = await pool.query(
      'SELECT product_id, product_name, price, quantity FROM order_items WHERE order_id = $1 AND product_id = ANY($2::int[])',
      [orderId, oldProductIds]
    );
    if (oldItemsResult.rows.length === 0) return res.status(400).json({ error: 'No matching items found in order.' });
    let oldTotal = 0;
    oldItemsResult.rows.forEach(item => {
      const priceNum = parseFloat(item.price.replace(/[^0-9.]/g,'')) || 0;
      oldTotal += priceNum * item.quantity;
    });
    const newProductsResult = await pool.query(
      'SELECT id, name, price FROM products WHERE id = ANY($1::int[])',
      [newProductIds]
    );
    if (newProductsResult.rows.length === 0) return res.status(400).json({ error: 'No valid replacement products found.' });
    let newTotal = 0;
    newProductsResult.rows.forEach(item => {
      const priceNum = parseFloat(item.price.replace(/[^0-9.]/g,'')) || 0;
      newTotal += priceNum;
    });
    const diff = newTotal - oldTotal;
    const replacementData = {
      old_items: oldItemsResult.rows,
      new_items: newProductsResult.rows,
      old_total: oldTotal,
      new_total: newTotal,
      diff: diff,
      status: diff === 0 ? 'approved' : (diff > 0 ? 'pending_payment' : 'pending_refund')
    };
    let paymentStatus = 'none';
    let refundStatus = 'none';
    if (diff > 0) paymentStatus = 'pending';
    else if (diff < 0) refundStatus = 'pending';
    else { paymentStatus = 'approved'; refundStatus = 'approved'; }

    await pool.query(
      `UPDATE orders SET replacement_request = $1, replacement_status = $2, replacement_diff = $3,
       replacement_payment_status = $4, replacement_refund_status = $5 WHERE id = $6`,
      [JSON.stringify(replacementData), replacementData.status, diff, paymentStatus, refundStatus, orderId]
    );
    let msg = `🔄 Replacement requested: ${oldItemsResult.rows.map(i => i.product_name).join(', ')} → ${newProductsResult.rows.map(i => i.name).join(', ')}. `;
    if (diff > 0) msg += `You need to pay Ksh ${diff.toFixed(2)} extra.`;
    else if (diff < 0) msg += `You will get a refund of Ksh ${Math.abs(diff).toFixed(2)}.`;
    else msg += `Prices are equal.`;
    await pool.query('INSERT INTO order_chat_messages (order_id, from_user, message) VALUES ($1, $2, $3)', [orderId, 'System', msg]);
    io.to(`order_${orderId}`).emit('new-order-chat-message', { order_id: orderId, from_user: 'System', message: msg, timestamp: new Date() });
    io.emit('replacement-requested', { orderId });
    res.json({ success: true, replacement: replacementData, payment_status: paymentStatus, refund_status: refundStatus });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

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
    const transactionId = `REP-${Date.now()}-${Math.random().toString(36).substr(2,6).toUpperCase()}`;

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
    res.status(500).json({ error: err.message });
  }
});

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
    res.status(500).json({ error: err.message });
  }
});

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
    if (!['delivered', 'received'].includes(orderCheck.rows[0].status)) {
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
    res.status(500).json({ error: err.message });
  }
});

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
    res.status(500).json({ error: err.message });
  }
});

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
    res.status(500).json({ error: err.message });
  }
});

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
    let message = `<h2>✅ Order ${ref} Confirmed!</h2>`;
    message += `<p>Dear ${order.customer_name},</p>`;
    message += `<p>Your order has been confirmed. Here are the details:</p>`;
    message += `<table border="1" cellpadding="5" style="border-collapse:collapse; width:100%; font-family:Arial, sans-serif;">`;
    message += `<tr style="background:#f1f5f9;"><th>Product</th><th>Variant</th><th>Qty</th><th>Unit Price</th><th>Subtotal</th><th>Product ID</th><th>Status</th></tr>`;
    let total = 0;
    items.forEach(item => {
      const priceNum = parseFloat(item.price.replace(/[^0-9.]/g, '')) || 0;
      const subtotal = priceNum * item.quantity;
      total += subtotal;
      const uniqueId = item.unique_id || '—';
      const variantName = item.variant_name || 'Default';
      message += `<tr>
        <td>${item.product_name}</td>
        <td>${variantName}</td>
        <td>${item.quantity}</td>
        <td>Ksh ${priceNum.toFixed(2)}</td>
        <td>Ksh ${subtotal.toFixed(2)}</td>
        <td style="font-family:monospace; font-size:0.8rem;">${uniqueId}</td>
        <td>✅</td>
      </tr>`;
    });
    message += `</table>`;
    message += `<p><strong>Total: Ksh ${Number(order.total).toFixed(2)}</strong></p>`;
    message += `<p>📦 Order Date: ${new Date(order.created_at).toLocaleString()}</p>`;
    message += `<p>🆔 Order Reference: ${ref}</p>`;
    if (order.estimated_delivery_days) {
      message += `<p>🚚 Estimated delivery: ${order.estimated_delivery_days} days.</p>`;
    }
    if (order.delivery_location_name) {
      message += `<p>📍 Delivery destination: ${order.delivery_location_name}</p>`;
    }
    message += `<p>Thank you for shopping with us!</p>`;

    await pool.query('INSERT INTO order_chat_messages (order_id, from_user, message) VALUES ($1, $2, $3)',
      [orderId, 'Seller', message]);
    io.to(`order_${orderId}`).emit('new-order-chat-message', { order_id: orderId, from_user: 'Seller', message: message, timestamp: new Date() });

    if (order.customer_email) {
      try {
        const mailData = orderConfirmationEmail(order, order.customer_name);
        await sendEmail({ to: order.customer_email, ...mailData });
      } catch (emailErr) {
        console.error('⚠️ Email send failed:', emailErr.message);
      }
    }
    res.json({ success: true, message: 'Order confirmed.' });
  } catch (err) {
    console.error('Confirm error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/orders/:id/status', authMiddleware, async (req, res) => {
  if (req.role !== 'admin') return res.status(403).json({ error: 'Admin only.' });
  const orderId = parseInt(req.params.id);
  const { status, tracking_number } = req.body;
  try {
    const current = await pool.query('SELECT status, customer_id, order_ref FROM orders WHERE id = $1', [orderId]);
    if (current.rows.length === 0) return res.status(404).json({ error: 'Order not found' });
    const currentStatus = current.rows[0].status;
    if (currentStatus === 'pending') return res.status(400).json({ error: 'Order must be confirmed first.' });
    if (currentStatus === 'received' || currentStatus === 'cancelled') {
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
      } catch (emailErr) {
        console.error('⚠️ Email send failed:', emailErr.message);
      }
    }
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

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
      }
    }
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

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
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/dashboard', authMiddleware, async (req, res) => {
  if (req.role !== 'admin') return res.status(403).json({ error: 'Admin only.' });
  try {
    const stats = {};
    const statuses = ['pending', 'confirmed', 'shipped', 'delivered', 'received', 'cancelled', 'pending_payment'];
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
      `SELECT COUNT(*) FROM orders WHERE urgent_delivery = true AND status NOT IN ('received', 'cancelled')`
    );
    stats.urgent = parseInt(urgent.rows[0].count);
    const total = await pool.query('SELECT COUNT(*) FROM orders');
    stats.total_orders = parseInt(total.rows[0].count);
    const revenue = await pool.query(
      `SELECT SUM(total) FROM orders WHERE status IN ('confirmed', 'shipped', 'delivered', 'received')`
    );
    stats.total_revenue = parseFloat(revenue.rows[0].sum) || 0;
    const returnsPending = await pool.query(`SELECT COUNT(*) FROM returns WHERE status = 'pending'`);
    stats.returns_pending = parseInt(returnsPending.rows[0].count);
    res.json(stats);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

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
    res.status(500).json({ error: err.message });
  }
});

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
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/orders/:id/remind', authMiddleware, async (req, res) => {
  if (req.role !== 'admin') return res.status(403).json({ error: 'Admin only.' });
  const orderId = parseInt(req.params.id);
  try {
    const orderResult = await pool.query('SELECT customer_id, order_ref FROM orders WHERE id = $1 AND status = $1',
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
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/logs', authMiddleware, async (req, res) => {
  if (req.role !== 'admin') return res.status(403).json({ error: 'Admin only.' });
  try {
    const result = await pool.query(
      'SELECT * FROM admin_logs ORDER BY created_at DESC LIMIT 100'
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ---- Bulk shipping rules ----
app.get('/api/admin/bulk-rules', authMiddleware, async (req, res) => {
  if (req.role !== 'admin') return res.status(403).json({ error: 'Admin only.' });
  try {
    const result = await pool.query('SELECT * FROM bulk_shipping_rules ORDER BY created_at DESC');
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/bulk-rules', authMiddleware, async (req, res) => {
  if (req.role !== 'admin') return res.status(403).json({ error: 'Admin only.' });
  const { trigger_type, trigger_value, bulk_calculation, bulk_rate, discount_percent, tier, applicable_to, product_id } = req.body;
  try {
    await pool.query(`
      INSERT INTO bulk_shipping_rules (trigger_type, trigger_value, bulk_calculation, bulk_rate, discount_percent, tier, applicable_to, product_id)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    `, [trigger_type, trigger_value, bulk_calculation, bulk_rate || null, discount_percent || null,
        tier || 'standard', applicable_to || 'all', product_id || null]);
    await logAdminActivity(req.userId, 'CREATE_BULK_RULE', { trigger_type });
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/admin/bulk-rules/:id', authMiddleware, async (req, res) => {
  if (req.role !== 'admin') return res.status(403).json({ error: 'Admin only.' });
  const id = parseInt(req.params.id);
  try {
    await pool.query('DELETE FROM bulk_shipping_rules WHERE id = $1', [id]);
    await logAdminActivity(req.userId, 'DELETE_BULK_RULE', { id });
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ---- PDF Receipt ----
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

    doc.fontSize(20).text('RECEIPT', { align: 'center' });
    doc.moveDown();
    doc.fontSize(12).text(`Order #: ${order.order_ref || order.id}`, { align: 'center' });
    doc.text(`Date: ${new Date(order.created_at).toLocaleString()}`, { align: 'center' });
    doc.text(`Status: ${order.status.toUpperCase()}`, { align: 'center' });
    doc.moveDown();

    doc.fontSize(14).text('Customer Details:');
    doc.fontSize(12).text(`Name: ${order.customer_name}`);
    doc.text(`Email: ${order.customer_email}`);
    doc.moveDown();

    doc.fontSize(14).text('Order Items:');
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
    doc.fontSize(10).text('Thank you for your purchase!', { align: 'center' });
    doc.text('This is a system-generated receipt.', { align: 'center' });

    doc.end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ---------- Socket.IO ----------
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
  res.status(500).json({ error: 'Internal server error' });
});

// ---------- Start Server ----------
server.listen(PORT, () => {
  console.log(`🚀 Server running at http://localhost:${PORT}`);
  console.log(`☁️ Cloudinary ready`);
  console.log(`📦 Neon PostgreSQL connected`);
});