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
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

if (!JWT_SECRET || !ADMIN_PASSWORD) {
  console.error('❌ Missing JWT_SECRET or ADMIN_PASSWORD in .env');
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
  ssl: {
    rejectUnauthorized: false,
  },
});

pool.connect((err) => {
  if (err) {
    console.error('❌ Database connection error:', err);
    process.exit(1);
  }
  console.log('✅ Neon PostgreSQL connected');
});

// ---------- Security ----------
app.use(helmet());
app.use(cors({ origin: process.env.CLIENT_URL || '*' }));
app.use(express.json());
app.use(express.static('public'));

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { error: 'Too many requests, please try again later.' }
});
app.use('/api', limiter);

// ---------- File Upload (Multer) ----------
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

// ---------- Upload to Cloudinary ----------
async function uploadToCloudinary(filePath, options = {}) {
  try {
    // Default options for images
    const defaultOptions = {
      folder: 'business_shop',
      transformation: [
        { width: 800, height: 800, crop: 'limit' },
        { quality: 'auto:good' },
        { fetch_format: 'auto' }
      ]
    };
    const mergedOptions = { ...defaultOptions, ...options };
    const result = await cloudinary.uploader.upload(filePath, mergedOptions);
    return result.secure_url;
  } catch (err) {
    console.error('Cloudinary upload error:', err);
    return null;
  }
}

// ---------- JWT Auth ----------
function generateToken() {
  return jwt.sign({ role: 'admin' }, JWT_SECRET, { expiresIn: '1d' });
}

function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const token = authHeader.split(' ')[1];
  try {
    jwt.verify(token, JWT_SECRET);
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

// ---------- API Routes ----------

// Admin login
app.post('/api/auth/login', async (req, res) => {
  const { password } = req.body;
  if (!password) {
    return res.status(400).json({ error: 'Password required' });
  }
  const hash = await bcrypt.hash(ADMIN_PASSWORD, 10);
  const match = await bcrypt.compare(password, hash);
  if (match) {
    const token = generateToken();
    res.json({ success: true, token });
  } else {
    res.status(401).json({ error: 'Invalid password' });
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
        logo: '', heroImage: '', whatsapp: '', tiktok: '', instagram: '', facebook: '', phone: ''
      });
    }
    res.json(result.rows[0]);
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

    // Upload logo to Cloudinary
    if (req.files['logo']) {
      const file = req.files['logo'][0];
      logo = await uploadToCloudinary(file.path);
      // Delete local file after upload
      fs.unlink(file.path, (err) => { if (err) console.error('Failed to delete local file:', err); });
    }

    if (req.files['heroImage']) {
      const file = req.files['heroImage'][0];
      heroImage = await uploadToCloudinary(file.path);
      fs.unlink(file.path, (err) => { if (err) console.error('Failed to delete local file:', err); });
    }

    const existing = await pool.query('SELECT * FROM shop LIMIT 1');
    if (existing.rows.length === 0) {
      await pool.query(`
        INSERT INTO shop (
          name, location, address, latitude, longitude, description, mission, vision,
          logo, heroImage, whatsapp, tiktok, instagram, facebook, phone
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
      `, [name, location, address, latitude, longitude, description, mission, vision,
          logo, heroImage, whatsapp, tiktok, instagram, facebook, phone]);
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
      await pool.query(`UPDATE shop SET ${setClause} WHERE id = 1`, params);
    }
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ---- Products ----
app.get('/api/products', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM products ORDER BY created_at DESC');
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/products', authMiddleware, upload.fields([{ name: 'image' }, { name: 'video' }]), async (req, res) => {
  try {
    const { name, price, contact, rating, badge1, badge2, shipping, isFlashSale, isNewArrival } = req.body;
    let image = null, video = null;

    // Upload image to Cloudinary
    if (req.files['image']) {
      const file = req.files['image'][0];
      image = await uploadToCloudinary(file.path);
      fs.unlink(file.path, (err) => { if (err) console.error('Failed to delete local file:', err); });
    }

    // Upload video to Cloudinary
    if (req.files['video']) {
      const file = req.files['video'][0];
      // For videos, we want to keep the original format and use auto quality
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
        // Fallback: keep local file path if Cloudinary fails
        video = '/uploads/' + file.filename;
      }
      // Delete local file regardless
      fs.unlink(file.path, (err) => { if (err) console.error('Failed to delete local file:', err); });
    }

    const result = await pool.query(`
      INSERT INTO products (name, price, contact, rating, badge1, badge2, shipping, isFlashSale, isNewArrival, image, video)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *
    `, [name, price, contact, rating, badge1, badge2, shipping, isFlashSale === 'true', isNewArrival === 'true', image, video]);
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

// ---- Chat Messages ----
app.get('/api/chat', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM chat_messages ORDER BY timestamp ASC');
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ---------- Socket.IO ----------
io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);

  socket.on('chat-message', async (data) => {
    try {
      const { from, message } = data;
      const result = await pool.query(
        'INSERT INTO chat_messages (from_user, message) VALUES ($1, $2) RETURNING *',
        [from, message]
      );
      io.emit('new-chat-message', result.rows[0]);
    } catch (err) {
      console.error(err);
    }
  });

  socket.on('customer-location', (data) => {
    io.emit('customer-update', { socketId: socket.id, ...data });
  });

  socket.on('disconnect', () => {
    io.emit('customer-left', socket.id);
  });
});

// ---------- Start Server ----------
server.listen(PORT, () => {
  console.log(`🚀 Server running at http://localhost:${PORT}`);
  console.log(`🔐 Admin login: use password from .env`);
  console.log(`📦 Connected to Neon PostgreSQL`);
  console.log(`☁️ Cloudinary ready`);
});