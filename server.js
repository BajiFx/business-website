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

// ---------- PostgreSQL (Neon) ----------
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

pool.connect((err) => {
  if (err) {
    console.error('❌ Database connection error:', err);
    process.exit(1);
  }
  console.log('✅ Neon PostgreSQL connected');
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
        "https://localhost:3000",
      ],
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc: [
        "'self'",
        "'unsafe-inline'",
        "https://unpkg.com",
        "https://cdnjs.cloudflare.com",
        "https://fonts.googleapis.com",
      ],
      styleSrcElem: [
        "'self'",
        "'unsafe-inline'",
        "https://fonts.googleapis.com",
        "https://unpkg.com",
        "https://cdnjs.cloudflare.com",
      ],
      fontSrc: [
        "'self'",
        "https://cdnjs.cloudflare.com",
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

// ---------- Upload to Cloudinary ----------
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

// ---------- API Routes ----------

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
    if (count > 0) {
      return res.status(403).json({ error: 'An admin account already exists. Registration is closed.' });
    }
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required.' });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters.' });
    }
    const hashedPassword = await bcrypt.hash(password, 10);
    await pool.query(
      'INSERT INTO admin_users (email, password) VALUES ($1, $2)',
      [email, hashedPassword]
    );
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
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required.' });
    }
    const result = await pool.query('SELECT * FROM admin_users WHERE email = $1', [email]);
    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    const user = result.rows[0];
    const match = await bcrypt.compare(password, user.password);
    if (!match) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
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
    if (!name || !email || !password) {
      return res.status(400).json({ error: 'All fields are required.' });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters.' });
    }
    const existing = await pool.query('SELECT * FROM customers WHERE email = $1', [email]);
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'Email already registered.' });
    }
    const hashedPassword = await bcrypt.hash(password, 10);
    const result = await pool.query(
      'INSERT INTO customers (name, email, password) VALUES ($1, $2, $3) RETURNING id, name, email',
      [name, email, hashedPassword]
    );
    const customer = result.rows[0];
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
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required.' });
    }
    const result = await pool.query('SELECT * FROM customers WHERE email = $1', [email]);
    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    const customer = result.rows[0];
    const match = await bcrypt.compare(password, customer.password);
    if (!match) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
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
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    res.json({ user: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ---- Shop Profile ----
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
    console.log('📦 Shop data fetched:', heroImage ? '✅ heroImage present' : '❌ heroImage missing');
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
      if (logo) {
        fs.unlink(file.path, (err) => { if (err) console.error('Failed to delete local file:', err); });
      }
    }

    if (req.files['heroImage']) {
      const file = req.files['heroImage'][0];
      heroImage = await uploadToCloudinary(file.path, { folder: 'business_shop/hero', width: 1920, height: 600 });
      console.log('📸 Hero image uploaded:', heroImage);
      if (heroImage) {
        fs.unlink(file.path, (err) => { if (err) console.error('Failed to delete local file:', err); });
      }
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
        console.log('📸 Saving heroImage to DB:', heroImage);
      }
      const updateResult = await pool.query(
        `UPDATE shop SET ${setClause} WHERE id = 1 RETURNING *`,
        params
      );
      updatedRow = updateResult.rows[0];
      console.log('✅ Shop profile updated with heroImage:', getHeroImage(updatedRow) || '(no new image)');
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
    const result = await pool.query('SELECT * FROM products ORDER BY created_at DESC');
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
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Product not found' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Related products
app.get('/api/products/:id/related', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const productResult = await pool.query('SELECT name FROM products WHERE id = $1', [id]);
    if (productResult.rows.length === 0) {
      return res.status(404).json({ error: 'Product not found' });
    }
    const productName = productResult.rows[0].name;
    const commonWords = ['the', 'a', 'an', 'and', 'or', 'but', 'for', 'on', 'at', 'to', 'by', 'in', 'of', 'with', 'without'];
    const words = productName.toLowerCase().split(/\s+/).filter(w => w.length > 2 && !commonWords.includes(w));
    let query = 'SELECT * FROM products WHERE id != $1';
    const params = [id];
    let paramIndex = 2;
    if (words.length > 0) {
      const conditions = words.map((w, i) => `LOWER(name) LIKE $${paramIndex + i}`);
      query += ' AND (' + conditions.join(' OR ') + ')';
      params.push(...words.map(w => `%${w}%`));
      paramIndex += words.length;
    }
    query += ' ORDER BY created_at DESC LIMIT 6';
    const result = await pool.query(query, params);
    if (result.rows.length === 0) {
      const fallback = await pool.query(
        'SELECT * FROM products WHERE id != $1 ORDER BY created_at DESC LIMIT 6',
        [id]
      );
      return res.json(fallback.rows);
    }
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/products', authMiddleware, upload.fields([{ name: 'image' }, { name: 'video' }]), async (req, res) => {
  try {
    const { name, price, contact, rating, badge1, badge2, shipping, isFlashSale, isNewArrival, description } = req.body;
    let image = null, video = null;

    if (req.files['image']) {
      const file = req.files['image'][0];
      image = await uploadToCloudinary(file.path);
      fs.unlink(file.path, (err) => { if (err) console.error('Failed to delete local file:', err); });
    }

    if (req.files['video']) {
      const file = req.files['video'][0];
      try {
        const result = await cloudinary.uploader.upload(file.path, {
          resource_type: 'video',
          folder: 'business_shop_videos',
          transformation: [
            { quality: 'auto:good' },
            { fetch_format: 'auto' }
          ]
        });
        video = result.secure_url;
      } catch (err) {
        console.error('Video upload error:', err);
        video = '/uploads/' + file.filename;
      }
      fs.unlink(file.path, (err) => { if (err) console.error('Failed to delete local file:', err); });
    }

    const result = await pool.query(`
      INSERT INTO products (name, price, contact, rating, badge1, badge2, shipping, isFlashSale, isNewArrival, image, video, description)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *
    `, [name, price, contact, rating, badge1, badge2, shipping, isFlashSale === 'true', isNewArrival === 'true', image, video, description]);
    res.json({ success: true, product: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/products/:id', authMiddleware, upload.fields([{ name: 'image' }, { name: 'video' }]), async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { name, price, contact, rating, badge1, badge2, shipping, isFlashSale, isNewArrival, description } = req.body;
    
    const existing = await pool.query('SELECT * FROM products WHERE id = $1', [id]);
    if (existing.rows.length === 0) {
      return res.status(404).json({ error: 'Product not found' });
    }
    const oldProduct = existing.rows[0];
    let image = oldProduct.image;
    let video = oldProduct.video;

    if (req.files['image']) {
      const file = req.files['image'][0];
      image = await uploadToCloudinary(file.path);
      fs.unlink(file.path, (err) => { if (err) console.error('Failed to delete local file:', err); });
    }
    if (req.files['video']) {
      const file = req.files['video'][0];
      try {
        const result = await cloudinary.uploader.upload(file.path, {
          resource_type: 'video',
          folder: 'business_shop_videos',
          transformation: [
            { quality: 'auto:good' },
            { fetch_format: 'auto' }
          ]
        });
        video = result.secure_url;
      } catch (err) {
        console.error('Video upload error:', err);
        video = '/uploads/' + file.filename;
      }
      fs.unlink(file.path, (err) => { if (err) console.error('Failed to delete local file:', err); });
    }

    const result = await pool.query(`
      UPDATE products 
      SET name = $1, price = $2, contact = $3, rating = $4, badge1 = $5, badge2 = $6, 
          shipping = $7, isFlashSale = $8, isNewArrival = $9, image = $10, video = $11, description = $12
      WHERE id = $13
      RETURNING *
    `, [name, price, contact, rating, badge1, badge2, shipping, isFlashSale === 'true', isNewArrival === 'true', image, video, description, id]);
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

// ---- General Chat (Public) ----
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

// ---- Customer's own chat messages ----
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

// ---- Location Sharing (unchanged) ----
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
    if (customerId) {
      io.to(`customer_${customerId}`).emit('location_request_approved');
    }
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
    if (existing.rows.length > 0) {
      return res.status(400).json({ error: 'You already have a pending request.' });
    }
    const approved = await pool.query(
      'SELECT * FROM location_requests WHERE customer_id = $1 AND status = $2',
      [customerId, 'approved']
    );
    if (approved.rows.length > 0) {
      return res.json({ success: true, alreadyApproved: true });
    }
    await pool.query(
      'INSERT INTO location_requests (customer_id, status) VALUES ($1, $2)',
      [customerId, 'pending']
    );
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
      const customers = await pool.query(
        'SELECT customer_id FROM location_requests WHERE status = $1',
        ['approved']
      );
      customers.rows.forEach(row => {
        io.to(`customer_${row.customer_id}`).emit('admin_location', { lat, lng });
      });
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
    const customers = await pool.query(
      'SELECT customer_id FROM location_requests WHERE status = $1',
      ['approved']
    );
    customers.rows.forEach(row => {
      io.to(`customer_${row.customer_id}`).emit('admin_location', { lat, lng });
    });
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
//  ORDERS (unchanged)
// ============================================================

// Create an order (customer only)
app.post('/api/orders', authMiddleware, async (req, res) => {
  if (req.role !== 'customer') {
    return res.status(403).json({ error: 'Only customers can place orders.' });
  }
  const customerId = req.userId;
  const { items, total } = req.body;
  if (!items || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'Order must contain at least one item.' });
  }
  if (!total || isNaN(total) || total <= 0) {
    return res.status(400).json({ error: 'Invalid total amount.' });
  }

  try {
    await pool.query('BEGIN');
    const orderResult = await pool.query(
      `INSERT INTO orders (customer_id, total, status) VALUES ($1, $2, 'pending') RETURNING *`,
      [customerId, total]
    );
    const order = orderResult.rows[0];
    for (const item of items) {
      await pool.query(
        `INSERT INTO order_items (order_id, product_id, product_name, price, quantity, image)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [order.id, item.productId || 0, item.name, item.price, item.quantity, item.image || '']
      );
    }
    await pool.query('COMMIT');
    res.status(201).json({ success: true, order });
  } catch (err) {
    await pool.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Get orders (admin sees all, customer sees their own)
app.get('/api/orders', authMiddleware, async (req, res) => {
  try {
    let query = `
      SELECT o.*, c.name AS customer_name, c.email AS customer_email
      FROM orders o
      JOIN customers c ON o.customer_id = c.id
    `;
    const params = [];
    if (req.role === 'customer') {
      query += ' WHERE o.customer_id = $1';
      params.push(req.userId);
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

// Get a specific order (admin or owner)
app.get('/api/orders/:id', authMiddleware, async (req, res) => {
  const orderId = parseInt(req.params.id);
  try {
    const result = await pool.query(
      `SELECT o.*, c.name AS customer_name, c.email AS customer_email
       FROM orders o
       JOIN customers c ON o.customer_id = c.id
       WHERE o.id = $1`,
      [orderId]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Order not found' });
    }
    const order = result.rows[0];
    if (req.role !== 'admin' && order.customer_id !== req.userId) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const itemsResult = await pool.query('SELECT * FROM order_items WHERE order_id = $1', [orderId]);
    res.json({ ...order, items: itemsResult.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Admin: Confirm an order
app.put('/api/orders/:id/confirm', authMiddleware, async (req, res) => {
  if (req.role !== 'admin') return res.status(403).json({ error: 'Admin only.' });
  const orderId = parseInt(req.params.id);
  try {
    const orderResult = await pool.query(
      `SELECT o.*, c.name AS customer_name 
       FROM orders o
       JOIN customers c ON o.customer_id = c.id
       WHERE o.id = $1`,
      [orderId]
    );
    if (orderResult.rows.length === 0) return res.status(404).json({ error: 'Order not found' });
    const order = orderResult.rows[0];
    if (order.status !== 'pending') return res.status(400).json({ error: 'Order already processed.' });

    await pool.query(`UPDATE orders SET status = 'confirmed', updated_at = NOW() WHERE id = $1`, [orderId]);

    const itemsResult = await pool.query('SELECT * FROM order_items WHERE order_id = $1', [orderId]);
    const items = itemsResult.rows;

    let message = `✅ Order #${order.id} Confirmed!\n\n`;
    message += `Dear ${order.customer_name},\n\n`;
    message += `Your order has been confirmed. Here are the details:\n\n`;
    message += `--------------------------------------------------\n`;
    message += `Product                Qty    Price      Subtotal\n`;
    message += `--------------------------------------------------\n`;
    let total = 0;
    items.forEach(item => {
      const priceNum = parseFloat(item.price.replace(/[^0-9.]/g, '')) || 0;
      const subtotal = priceNum * item.quantity;
      total += subtotal;
      const namePad = (item.product_name.length > 20) ? item.product_name.slice(0, 18) + '..' : item.product_name.padEnd(20);
      message += `${namePad}  ${item.quantity.toString().padStart(4)}  ${priceNum.toFixed(2).padStart(8)}  ${subtotal.toFixed(2).padStart(10)}\n`;
    });
    message += `--------------------------------------------------\n`;
    message += `Total: Ksh ${order.total.toFixed(2)}\n`;
    message += `--------------------------------------------------\n\n`;
    message += `Thank you for shopping with us!`;

    const chatResult = await pool.query(
      `INSERT INTO order_chat_messages (order_id, from_user, message)
       VALUES ($1, 'Seller', $2) RETURNING *`,
      [orderId, message]
    );
    const newMsg = chatResult.rows[0];
    io.to(`order_${orderId}`).emit('new-order-chat-message', {
      ...newMsg,
      from_user: 'Seller'
    });

    res.json({ success: true, message: 'Order confirmed.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Admin: Update order status (shipped, delivered)
app.put('/api/orders/:id/status', authMiddleware, async (req, res) => {
  if (req.role !== 'admin') return res.status(403).json({ error: 'Admin only.' });
  const orderId = parseInt(req.params.id);
  const { status, tracking_number } = req.body;
  const allowedStatuses = ['shipped', 'delivered'];
  if (!allowedStatuses.includes(status)) {
    return res.status(400).json({ error: 'Invalid status. Allowed: shipped, delivered' });
  }
  try {
    const current = await pool.query('SELECT status FROM orders WHERE id = $1', [orderId]);
    if (current.rows.length === 0) return res.status(404).json({ error: 'Order not found' });
    const currentStatus = current.rows[0].status;
    if (currentStatus === 'pending') return res.status(400).json({ error: 'Order must be confirmed first.' });
    if (currentStatus === 'received') return res.status(400).json({ error: 'Order already received.' });

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

    const orderResult = await pool.query(`SELECT customer_id FROM orders WHERE id = $1`, [orderId]);
    const customerId = orderResult.rows[0].customer_id;

    const msg = `📦 Order #${orderId} status updated to: ${status.toUpperCase()}`;
    const chatResult = await pool.query(
      `INSERT INTO order_chat_messages (order_id, from_user, message)
       VALUES ($1, 'Seller', $2) RETURNING *`,
      [orderId, msg]
    );
    io.to(`order_${orderId}`).emit('new-order-chat-message', chatResult.rows[0]);

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Customer: Mark order as received
app.put('/api/orders/:id/receive', authMiddleware, async (req, res) => {
  if (req.role !== 'customer') return res.status(403).json({ error: 'Customer only.' });
  const orderId = parseInt(req.params.id);
  try {
    const orderResult = await pool.query(
      `SELECT customer_id, status FROM orders WHERE id = $1`,
      [orderId]
    );
    if (orderResult.rows.length === 0) return res.status(404).json({ error: 'Order not found' });
    const order = orderResult.rows[0];
    if (order.customer_id !== req.userId) return res.status(403).json({ error: 'Not your order.' });
    if (order.status !== 'delivered') {
      return res.status(400).json({ error: 'Order must be delivered before you can mark it as received.' });
    }
    await pool.query(
      `UPDATE orders SET status = 'received', received_at = NOW(), updated_at = NOW() WHERE id = $1`,
      [orderId]
    );
    const msg = `✅ Order #${orderId} has been received by the customer.`;
    const chatResult = await pool.query(
      `INSERT INTO order_chat_messages (order_id, from_user, message)
       VALUES ($1, 'Customer', $2) RETURNING *`,
      [orderId, msg]
    );
    io.to(`order_${orderId}`).emit('new-order-chat-message', chatResult.rows[0]);

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Order chat: Get messages
app.get('/api/orders/:id/chat', authMiddleware, async (req, res) => {
  const orderId = parseInt(req.params.id);
  try {
    const orderResult = await pool.query(
      `SELECT customer_id FROM orders WHERE id = $1`,
      [orderId]
    );
    if (orderResult.rows.length === 0) return res.status(404).json({ error: 'Order not found' });
    const order = orderResult.rows[0];
    if (req.role !== 'admin' && order.customer_id !== req.userId) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const result = await pool.query(
      `SELECT * FROM order_chat_messages WHERE order_id = $1 ORDER BY timestamp ASC`,
      [orderId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Order chat: Send message
app.post('/api/orders/:id/chat', authMiddleware, async (req, res) => {
  const orderId = parseInt(req.params.id);
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: 'Message is required.' });
  try {
    const orderResult = await pool.query(
      `SELECT customer_id FROM orders WHERE id = $1`,
      [orderId]
    );
    if (orderResult.rows.length === 0) return res.status(404).json({ error: 'Order not found' });
    const order = orderResult.rows[0];
    const from = (req.role === 'admin') ? 'Seller' : 'Customer';
    if (req.role !== 'admin' && order.customer_id !== req.userId) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const result = await pool.query(
      `INSERT INTO order_chat_messages (order_id, from_user, message)
       VALUES ($1, $2, $3) RETURNING *`,
      [orderId, from, message]
    );
    io.to(`order_${orderId}`).emit('new-order-chat-message', result.rows[0]);
    res.json({ success: true, msg: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ---------- Socket.IO (with order chat rooms) ----------
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

  // General chat
  socket.on('chat-message', async (data) => {
    try {
      const { message } = data;
      if (!message || !socket.customerId) return;
      const result = await pool.query(
        `INSERT INTO chat_messages (customer_id, message, from_user) 
         VALUES ($1, $2, $3) RETURNING *`,
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

  // Order chat rooms
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