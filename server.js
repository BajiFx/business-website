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
require('dotenv').config();

// ---- Optional email ----
let sendEmail, orderConfirmationEmail, statusUpdateEmail, receivedEmail;
try {
  const email = require('./email');
  sendEmail = email.sendEmail;
  orderConfirmationEmail = email.orderConfirmationEmail;
  statusUpdateEmail = email.statusUpdateEmail;
  receivedEmail = email.receivedEmail;
} catch (e) {
  console.warn('⚠️ Email module not loaded – email features disabled.');
  sendEmail = async () => {};
  orderConfirmationEmail = () => ({ subject: '', html: '', text: '' });
  statusUpdateEmail = () => ({ subject: '', html: '', text: '' });
  receivedEmail = () => ({ subject: '', html: '', text: '' });
}

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

// ---------- PostgreSQL (Neon) with improved settings ----------
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 20000,
  keepAlive: true,
});

pool.on('error', (err) => {
  console.error('⚠️ PostgreSQL pool error:', err);
  console.log('🔄 Attempting to reconnect in 3 seconds...');
  setTimeout(() => {
    pool.connect().then(() => console.log('✅ Reconnected to PostgreSQL')).catch(e => console.error('Reconnection failed:', e));
  }, 3000);
});

const originalConnect = pool.connect.bind(pool);
pool.connect = function(callback) {
  return originalConnect((err, client, done) => {
    if (err) {
      console.error('❌ Pool connect error:', err);
      if (callback) callback(err);
      return;
    }
    client.on('error', (clientErr) => {
      console.error('⚠️ Client error:', clientErr);
    });
    if (callback) callback(null, client, done);
  });
};

pool.connect((err) => {
  if (err) {
    console.error('❌ Database connection error:', err);
  } else {
    console.log('✅ Neon PostgreSQL connected');
  }
});

// Global error handlers
process.on('uncaughtException', (err) => {
  console.error('❌ Uncaught Exception:', err);
});
process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Unhandled Rejection:', reason);
});

// ---------- Security ----------
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: [
        "'self'",
        "'unsafe-inline'",
        "'unsafe-eval'",
        "https://unpkg.com",
        "https://cdnjs.cloudflare.com",
        "https://cdn.jsdelivr.net",
        "https://localhost:3000",
      ],
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc: [
        "'self'",
        "'unsafe-inline'",
        "https://unpkg.com",
        "https://cdnjs.cloudflare.com",
        "https://cdn.jsdelivr.net",
        "https://fonts.googleapis.com",
      ],
      styleSrcElem: [
        "'self'",
        "'unsafe-inline'",
        "https://fonts.googleapis.com",
        "https://unpkg.com",
        "https://cdnjs.cloudflare.com",
        "https://cdn.jsdelivr.net",
      ],
      fontSrc: [
        "'self'",
        "https://cdnjs.cloudflare.com",
        "https://cdn.jsdelivr.net",
        "https://fonts.gstatic.com",
        "data:",
      ],
      imgSrc: [
        "'self'",
        "data:",
        "https://res.cloudinary.com",
        "https://*.tile.openstreetmap.org",
        "https://*.openstreetmap.org",
        "https://unpkg.com",
      ],
      connectSrc: [
        "'self'",
        "ws://localhost:3000",
        "wss://*.onrender.com",
        "https://unpkg.com",
      ],
      objectSrc: ["'none'"],
    },
  },
  crossOriginEmbedderPolicy: false,
}));

app.use(cors({ origin: process.env.CLIENT_URL || '*' }));
app.use(express.json());
app.use(express.static('public'));

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { error: 'Too many requests, please try again later.' }
});
app.use('/api', limiter);

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

// ---------- Order Reference Generator (15 chars) ----------
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

// ---- SHOP profile ----
app.get('/api/shop', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM shop LIMIT 1');
    if (result.rows.length === 0) {
      return res.json({
        name: 'My Shop', location: 'Nairobi, Kenya', address: '',
        latitude: '', longitude: '', description: '', mission: '', vision: '',
        logo: '', heroImage: '', whatsapp: '', tiktok: '', instagram: '', facebook: '', phone: '',
        location_sharing_enabled: false, admin_lat: '', admin_lng: ''
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
      whatsapp, tiktok, instagram, facebook, phone
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
          logo, heroImage, whatsapp, tiktok, instagram, facebook, phone
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
        RETURNING *
      `, [name, location, address, latitude, longitude, description, mission, vision,
          logo, heroImage, whatsapp, tiktok, instagram, facebook, phone]);
      updatedRow = insertResult.rows[0];
    } else {
      const fields = ['name','location','address','latitude','longitude','description','mission','vision',
                      'whatsapp','tiktok','instagram','facebook','phone'];
      const values = fields.map(f => req.body[f] || null);
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

// ---- Products (CRUD) ----
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
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/products/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const result = await pool.query('SELECT * FROM products WHERE id = $1', [id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Product not found' });
    res.json(result.rows[0]);
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
    const reviewsResult = await pool.query('SELECT * FROM product_reviews WHERE product_id = $1 ORDER BY created_at DESC', [id]);
    const relatedResult = await pool.query('SELECT * FROM products WHERE id != $1 ORDER BY created_at DESC LIMIT 6', [id]);
    res.json({ product, reviews: reviewsResult.rows, related: relatedResult.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/products/:id/review', authMiddleware, async (req, res) => {
  if (req.role !== 'customer') return res.status(403).json({ error: 'Customer only' });
  const productId = parseInt(req.params.id);
  const { rating, review_text } = req.body;
  if (!rating || rating < 1 || rating > 5) return res.status(400).json({ error: 'Invalid rating' });
  try {
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

app.post('/api/products', authMiddleware, upload.fields([{ name: 'image' }, { name: 'video' }]), async (req, res) => {
  try {
    const { name, price, contact, rating, badge1, badge2, shipping, isFlashSale, isNewArrival, description, shipping_fee, free_shipping_eligible, return_enabled, return_window_days, restocking_fee_percent, return_shipping_paid_by, return_condition } = req.body;
    let image = null, video = null;
    if (req.files['image']) {
      const file = req.files['image'][0];
      image = await uploadToCloudinary(file.path);
      fs.unlink(file.path, (err) => { if (err) console.error('Failed to delete local file:', err); });
    }
    if (req.files['video']) {
      const file = req.files['video'][0];
      try {
        const result = await cloudinary.uploader.upload(file.path, { resource_type: 'video', folder: 'business_shop_videos' });
        video = result.secure_url;
      } catch (err) {
        video = '/uploads/' + file.filename;
      }
      fs.unlink(file.path, (err) => { if (err) console.error('Failed to delete local file:', err); });
    }
    const result = await pool.query(`
      INSERT INTO products (name, price, contact, rating, badge1, badge2, shipping, isFlashSale, isNewArrival, image, video, description, shipping_fee, free_shipping_eligible, return_enabled, return_window_days, restocking_fee_percent, return_shipping_paid_by, return_condition)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) RETURNING *
    `, [name, price, contact, rating, badge1, badge2, shipping, isFlashSale === 'true', isNewArrival === 'true', image, video, description, shipping_fee, free_shipping_eligible === 'true', return_enabled !== 'false', return_window_days || 14, restocking_fee_percent || 0, return_shipping_paid_by || 'buyer', return_condition || 'unopened']);
    res.json({ success: true, product: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/products/:id', authMiddleware, upload.fields([{ name: 'image' }, { name: 'video' }]), async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { name, price, contact, rating, badge1, badge2, shipping, isFlashSale, isNewArrival, description, shipping_fee, free_shipping_eligible, return_enabled, return_window_days, restocking_fee_percent, return_shipping_paid_by, return_condition } = req.body;
    const existing = await pool.query('SELECT * FROM products WHERE id = $1', [id]);
    if (existing.rows.length === 0) return res.status(404).json({ error: 'Product not found' });
    const oldProduct = existing.rows[0];
    let image = oldProduct.image, video = oldProduct.video;
    if (req.files['image']) {
      const file = req.files['image'][0];
      image = await uploadToCloudinary(file.path);
      fs.unlink(file.path, (err) => { if (err) console.error('Failed to delete local file:', err); });
    }
    if (req.files['video']) {
      const file = req.files['video'][0];
      try {
        const result = await cloudinary.uploader.upload(file.path, { resource_type: 'video', folder: 'business_shop_videos' });
        video = result.secure_url;
      } catch (err) {
        video = '/uploads/' + file.filename;
      }
      fs.unlink(file.path, (err) => { if (err) console.error('Failed to delete local file:', err); });
    }
    const result = await pool.query(`
      UPDATE products 
      SET name = $1, price = $2, contact = $3, rating = $4, badge1 = $5, badge2 = $6, 
          shipping = $7, isFlashSale = $8, isNewArrival = $9, image = $10, video = $11, 
          description = $12, shipping_fee = $13, free_shipping_eligible = $14, 
          return_enabled = $15, return_window_days = $16, restocking_fee_percent = $17, 
          return_shipping_paid_by = $18, return_condition = $19
      WHERE id = $20 RETURNING *
    `, [name, price, contact, rating, badge1, badge2, shipping, isFlashSale === 'true', isNewArrival === 'true', image, video, description, shipping_fee, free_shipping_eligible === 'true', return_enabled !== 'false', return_window_days || 14, restocking_fee_percent || 0, return_shipping_paid_by || 'buyer', return_condition || 'unopened', id]);
    res.json({ success: true, product: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/products/:id', authMiddleware, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    await pool.query('DELETE FROM products WHERE id = $1', [id]);
    res.json({ success: true });
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

app.post('/api/auth/register', async (req, res) => {
  try {
    const { email, password } = req.body;
    const existsResult = await pool.query('SELECT COUNT(*) FROM admin_users');
    const count = parseInt(existsResult.rows[0].count);
    if (count > 0) return res.status(403).json({ error: 'An admin account already exists.' });
    if (!email || !password) return res.status(400).json({ error: 'Email and password are required.' });
    if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });
    const hashedPassword = await bcrypt.hash(password, 10);
    await pool.query('INSERT INTO admin_users (email, password) VALUES ($1, $2)', [email, hashedPassword]);
    const token = generateToken(email, 'admin');
    res.json({ success: true, token, message: 'Admin account created successfully!' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password are required.' });
    const result = await pool.query('SELECT * FROM admin_users WHERE email = $1', [email]);
    if (result.rows.length === 0) return res.status(401).json({ error: 'Invalid credentials' });
    const user = result.rows[0];
    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(401).json({ error: 'Invalid credentials' });
    const token = generateToken(email, 'admin');
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
app.post('/api/auth/customer/register', async (req, res) => {
  try {
    const { name, email, password } = req.body;
    if (!name || !email || !password) return res.status(400).json({ error: 'All fields are required.' });
    if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });
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

app.post('/api/auth/customer/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password are required.' });
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

// ---- Address Book (with location_name) ----
app.get('/api/addresses', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, label, address, lat, lng, location_name, is_default FROM customer_addresses WHERE customer_id = $1 ORDER BY is_default DESC, created_at ASC',
      [req.userId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/addresses', authMiddleware, async (req, res) => {
  const { label, address, lat, lng, location_name } = req.body;
  if (!label || !address) return res.status(400).json({ error: 'Label and address required' });
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

// ---- Cart with reservation ----
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

// ---- Promo code validation ----
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

// ---- General Chat ----
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
// ORDERS (full enhanced)
// ============================================================

app.post('/api/orders', authMiddleware, async (req, res) => {
  if (req.role !== 'customer') {
    return res.status(403).json({ error: 'Only customers can place orders.' });
  }
  const customerId = req.userId;
  const { items, total, shipping_tier, shipping_cost, order_notes, address_id, promo_code, discount } = req.body;
  if (!items || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'Order must contain at least one item.' });
  }
  if (!total || isNaN(total) || total <= 0) {
    return res.status(400).json({ error: 'Invalid total amount.' });
  }

  try {
    if (address_id) {
      const addrCheck = await pool.query('SELECT id, address, location_name FROM customer_addresses WHERE id = $1 AND customer_id = $2', [address_id, customerId]);
      if (addrCheck.rows.length === 0) return res.status(400).json({ error: 'Invalid address.' });
      // Store the address details for the order
      var addressData = addrCheck.rows[0];
    }

    let orderRef;
    let unique = false;
    while (!unique) {
      orderRef = generateOrderRef();
      const check = await pool.query('SELECT id FROM orders WHERE order_ref = $1', [orderRef]);
      if (check.rows.length === 0) unique = true;
    }

    let appliedDiscount = discount || 0;
    if (promo_code) {
      const promoResult = await pool.query('SELECT * FROM promo_codes WHERE code = $1 AND active = true AND (expires_at IS NULL OR expires_at > NOW()) AND (usage_limit IS NULL OR used_count < usage_limit)', [promo_code.toUpperCase()]);
      if (promoResult.rows.length > 0) {
        const promo = promoResult.rows[0];
        await pool.query('UPDATE promo_codes SET used_count = used_count + 1 WHERE id = $1', [promo.id]);
      } else {
        appliedDiscount = 0;
      }
    }

    await pool.query('BEGIN');
    const orderResult = await pool.query(`
      INSERT INTO orders (customer_id, total, status, order_ref, status_history, shipping_tier, shipping_cost, order_notes, address_id, promo_code, discount_applied, delivery_location_name)
      VALUES ($1, $2, 'pending', $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *
    `, [customerId, total, orderRef, JSON.stringify([{ status: 'pending', timestamp: new Date().toISOString() }]), shipping_tier || 'standard', shipping_cost || 0, order_notes || null, address_id || null, promo_code || null, appliedDiscount, addressData ? addressData.location_name || addressData.address : null]);
    const order = orderResult.rows[0];
    for (const item of items) {
      const uniqueId = generateOrderRef();
      await pool.query(`
        INSERT INTO order_items (order_id, product_id, product_name, price, quantity, image, unique_id)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
      `, [order.id, item.productId || 0, item.name, item.price, item.quantity, item.image || '', uniqueId]);
    }
    await pool.query('UPDATE carts SET items = $1, reserved_until = NULL WHERE customer_id = $2', ['[]', customerId]);
    await pool.query('COMMIT');

    const customerResult = await pool.query('SELECT name, email FROM customers WHERE id = $1', [customerId]);
    const customer = customerResult.rows[0];
    if (customer && customer.email) {
      try {
        const mailData = orderConfirmationEmail(order, customer.name);
        await sendEmail({ to: customer.email, ...mailData });
      } catch (emailErr) {
        console.error('⚠️ Email send failed, but order placed:', emailErr.message);
      }
    }

    res.status(201).json({ success: true, order });
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

// ---- Order location (with location_name) ----
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
      case 'pending': statusMessage = 'Your orders are still being reviewed and packed for delivery.'; break;
      case 'confirmed': statusMessage = 'Your order has been confirmed and is being prepared.'; break;
      case 'shipped': statusMessage = 'Your orders are on the way to your destination.'; break;
      case 'delivered': statusMessage = 'Please your products/orders are already delivered, go with your ID to pick them please in the next 7 working days.'; break;
      case 'received': statusMessage = 'You have confirmed receipt of your order. Thank you!'; break;
      case 'cancelled': statusMessage = 'This order has been cancelled.'; break;
      default: statusMessage = 'Status unknown.';
    }
    res.json({ ...order, statusMessage });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/orders/:id/cancel', authMiddleware, async (req, res) => {
  const orderId = parseInt(req.params.id);
  const { reason } = req.body;
  if (!reason) return res.status(400).json({ error: 'Please select a cancellation reason.' });
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
    if (!['pending', 'confirmed'].includes(order.status)) {
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

app.put('/api/orders/:id/refund', authMiddleware, async (req, res) => {
  if (req.role !== 'customer') return res.status(403).json({ error: 'Customer only.' });
  const orderId = parseInt(req.params.id);
  const { reason } = req.body;
  if (!reason) return res.status(400).json({ error: 'Please provide a reason.' });
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
  if (!oldProductIds || !Array.isArray(oldProductIds) || oldProductIds.length === 0) {
    return res.status(400).json({ error: 'Select at least one product to replace.' });
  }
  if (!newProductIds || !Array.isArray(newProductIds) || newProductIds.length === 0) {
    return res.status(400).json({ error: 'Select at least one replacement product.' });
  }
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
    await pool.query(
      `UPDATE orders SET replacement_request = $1, replacement_status = $2, replacement_diff = $3 WHERE id = $4`,
      [JSON.stringify(replacementData), replacementData.status, diff, orderId]
    );
    let msg = `🔄 Replacement requested: ${oldItemsResult.rows.map(i => i.product_name).join(', ')} → ${newProductsResult.rows.map(i => i.name).join(', ')}. `;
    if (diff > 0) msg += `You need to pay Ksh ${diff.toFixed(2)} extra.`;
    else if (diff < 0) msg += `You will get a refund of Ksh ${Math.abs(diff).toFixed(2)}.`;
    else msg += `Prices are equal.`;
    await pool.query('INSERT INTO order_chat_messages (order_id, from_user, message) VALUES ($1, $2, $3)', [orderId, 'System', msg]);
    io.to(`order_${orderId}`).emit('new-order-chat-message', { order_id: orderId, from_user: 'System', message: msg, timestamp: new Date() });
    res.json({ success: true, replacement: replacementData });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/admin/orders/:id/replace', authMiddleware, async (req, res) => {
  if (req.role !== 'admin') return res.status(403).json({ error: 'Admin only.' });
  const orderId = parseInt(req.params.id);
  const { action } = req.body;
  if (!['approve', 'reject'].includes(action)) return res.status(400).json({ error: 'Invalid action.' });
  try {
    const orderResult = await pool.query('SELECT replacement_status FROM orders WHERE id = $1', [orderId]);
    if (orderResult.rows.length === 0) return res.status(404).json({ error: 'Order not found' });
    if (orderResult.rows[0].replacement_status === 'none' || orderResult.rows[0].replacement_status === 'approved' || orderResult.rows[0].replacement_status === 'rejected') {
      return res.status(400).json({ error: 'No pending replacement request.' });
    }
    const newStatus = action === 'approve' ? 'approved' : 'rejected';
    await pool.query(`UPDATE orders SET replacement_status = $1 WHERE id = $2`, [newStatus, orderId]);
    const msg = action === 'approve' ? '✅ Replacement approved.' : '❌ Replacement rejected.';
    await pool.query('INSERT INTO order_chat_messages (order_id, from_user, message) VALUES ($1, $2, $3)', [orderId, 'System', msg]);
    io.to(`order_${orderId}`).emit('new-order-chat-message', { order_id: orderId, from_user: 'System', message: msg, timestamp: new Date() });
    res.json({ success: true, message: `Replacement ${action}d.` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/orders/:id/return', authMiddleware, async (req, res) => {
  if (req.role !== 'customer') return res.status(403).json({ error: 'Customer only.' });
  const orderId = parseInt(req.params.id);
  const { product_id, reason, photos } = req.body;
  if (!product_id || !reason) return res.status(400).json({ error: 'Product ID and reason required.' });
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
    const existingReturn = await pool.query('SELECT id FROM returns WHERE order_id = $1 AND product_id = $2 AND status IN ($3,$4)', [orderId, product_id, 'pending', 'approved']);
    if (existingReturn.rows.length > 0) return res.status(400).json({ error: 'Return already requested for this product.' });
    await pool.query(
      'INSERT INTO returns (order_id, customer_id, product_id, reason, photos, status) VALUES ($1, $2, $3, $4, $5, $6)',
      [orderId, req.userId, product_id, reason, photos || null, 'pending']
    );
    const msg = `📦 Return requested for product #${product_id}. Reason: ${reason}`;
    await pool.query('INSERT INTO order_chat_messages (order_id, from_user, message) VALUES ($1, $2, $3)', [orderId, 'System', msg]);
    io.to(`order_${orderId}`).emit('new-order-chat-message', { order_id: orderId, from_user: 'System', message: msg, timestamp: new Date() });
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
  if (!['approve', 'reject'].includes(action)) return res.status(400).json({ error: 'Invalid action.' });
  try {
    const returnResult = await pool.query('SELECT * FROM returns WHERE id = $1', [returnId]);
    if (returnResult.rows.length === 0) return res.status(404).json({ error: 'Return not found.' });
    const ret = returnResult.rows[0];
    if (ret.status !== 'pending') return res.status(400).json({ error: 'Return already processed.' });
    const newStatus = action === 'approve' ? 'approved' : 'rejected';
    await pool.query(`UPDATE returns SET status = $1, approved_at = NOW(), admin_notes = $2 WHERE id = $3`, [newStatus, admin_notes || null, returnId]);
    const msg = action === 'approve' ? '✅ Return approved.' : '❌ Return rejected.';
    await pool.query('INSERT INTO order_chat_messages (order_id, from_user, message) VALUES ($1, $2, $3)', [ret.order_id, 'System', msg]);
    io.to(`order_${ret.order_id}`).emit('new-order-chat-message', { order_id: ret.order_id, from_user: 'System', message: msg, timestamp: new Date() });
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
    const itemsResult = await pool.query('SELECT product_id, product_name, price, image FROM order_items WHERE order_id = $1', [orderId]);
    if (itemsResult.rows.length === 0) return res.status(400).json({ error: 'No items to reorder.' });
    const cartItems = itemsResult.rows.map(item => ({
      id: item.product_id,
      name: item.product_name,
      price: item.price,
      image: item.image || '',
      quantity: 1
    }));
    await pool.query('UPDATE carts SET items = $1, updated_at = NOW() WHERE customer_id = $2', [JSON.stringify(cartItems), req.userId]);
    res.json({ success: true, items: cartItems });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// CONFIRM ORDER – with beautiful HTML table
// ============================================================
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
      let msg = `Order already processed (current status: ${order.status}).`;
      if (order.status === 'confirmed') msg = 'Order is already confirmed.';
      else if (order.status === 'shipped') msg = 'Order has already been shipped.';
      else if (order.status === 'delivered') msg = 'Order has already been delivered.';
      else if (order.status === 'received') msg = 'Order has already been received.';
      else if (order.status === 'cancelled') msg = 'Order has been cancelled.';
      return res.status(400).json({ error: msg });
    }
    await pool.query(`UPDATE orders SET status = 'confirmed', updated_at = NOW() WHERE id = $1`, [orderId]);
    await appendOrderStatus(orderId, 'confirmed');
    const itemsResult = await pool.query('SELECT * FROM order_items WHERE order_id = $1', [orderId]);
    const items = itemsResult.rows;

    // ---- Build HTML table ----
    const ref = order.order_ref || `#${order.id}`;
    let message = `<h2>✅ Order ${ref} Confirmed!</h2>`;
    message += `<p>Dear ${order.customer_name},</p>`;
    message += `<p>Your order has been confirmed. Here are the details:</p>`;
    message += `<table border="1" cellpadding="5" style="border-collapse:collapse; width:100%; font-family:Arial, sans-serif;">`;
    message += `<tr style="background:#f1f5f9;"><th>Product</th><th>Qty</th><th>Unit Price</th><th>Subtotal</th><th>Product ID</th><th>Status</th></tr>`;
    let total = 0;
    items.forEach(item => {
      const priceNum = parseFloat(item.price.replace(/[^0-9.]/g, '')) || 0;
      const subtotal = priceNum * item.quantity;
      total += subtotal;
      const uniqueId = item.unique_id || '—';
      message += `<tr>
        <td>${item.product_name}</td>
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

    await pool.query('INSERT INTO order_chat_messages (order_id, from_user, message) VALUES ($1, $2, $3)', [orderId, 'Seller', message]);
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

// ---- Update status (admin) ----
app.put('/api/orders/:id/status', authMiddleware, async (req, res) => {
  if (req.role !== 'admin') return res.status(403).json({ error: 'Admin only.' });
  const orderId = parseInt(req.params.id);
  const { status, tracking_number } = req.body;
  const allowedStatuses = ['shipped', 'delivered'];
  if (!allowedStatuses.includes(status)) {
    return res.status(400).json({ error: 'Invalid status. Allowed: shipped, delivered' });
  }
  try {
    const current = await pool.query('SELECT status, customer_id, order_ref FROM orders WHERE id = $1', [orderId]);
    if (current.rows.length === 0) return res.status(404).json({ error: 'Order not found' });
    const currentStatus = current.rows[0].status;
    if (currentStatus === 'pending') return res.status(400).json({ error: 'Order must be confirmed first.' });
    if (currentStatus === 'received' || currentStatus === 'cancelled') return res.status(400).json({ error: 'Order already processed.' });
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
    const orderRef = current.rows[0].order_ref || `#${orderId}`;
    const msg = `📦 Order ${orderRef} status updated to: ${status.toUpperCase()}`;
    await pool.query('INSERT INTO order_chat_messages (order_id, from_user, message) VALUES ($1, $2, $3)', [orderId, 'Seller', msg]);
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

// ---- Mark received (customer) ----
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
    await pool.query('INSERT INTO order_chat_messages (order_id, from_user, message) VALUES ($1, $2, $3)', [orderId, 'Customer', msg]);
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

// ---- Order chat ----
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

// ---- Admin bulk shipping rules CRUD ----
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
    `, [trigger_type, trigger_value, bulk_calculation, bulk_rate || null, discount_percent || null, tier || 'standard', applicable_to || 'all', product_id || null]);
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
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ---- Socket.IO ----
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

  socket.on('join-order-room', (orderId) => {
    socket.join(`order_${orderId}`);
  });
  socket.on('leave-order-room', (orderId) => {
    socket.leave(`order_${orderId}`);
  });

  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
  });
});

// ---------- Start Server ----------
server.listen(PORT, () => {
  console.log(`🚀 Server running at http://localhost:${PORT}`);
  console.log(`☁️ Cloudinary ready`);
  console.log(`📦 Neon PostgreSQL connected`);
});