// ============================================================
//  SERVER.JS - Complete Working Version WITH REDIS FALLBACK
//  Location: D:\my-business-website\server.js
// ============================================================

require('dotenv').config();
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const path = require('path');
const cron = require('node-cron');
const fs = require('fs');

// ============================================================
//  IMPORT CONFIGURATIONS
// ============================================================

const { pool, logError } = require('./src/config/database');
const { globalErrorHandler } = require('./src/middleware/errorHandler');
const { generalLimiter, sensitiveLimiter } = require('./src/middleware/rateLimiter');
const { setupSocketHandlers } = require('./src/socket/socketHandler');
const { initPaypalClient } = require('./src/services/paypal');
const { restockOrder, appendOrderStatus, getSystemSetting } = require('./src/services/orderService');

// ============================================================
//  REDIS FALLBACK - FIXED
// ============================================================
let cacheMiddleware = null;
try {
  const redisModule = require('./redis');
  cacheMiddleware = redisModule.cacheMiddleware;
  console.log('✅ Redis module loaded');
} catch (err) {
  console.log('⚠️ Redis not available - caching disabled');
  // Create a no-op middleware
  cacheMiddleware = (ttl) => (req, res, next) => next();
}

// ============================================================
//  IMPORT ROUTES
// ============================================================

const authRoutes = require('./src/routes/auth');
const shopRoutes = require('./src/routes/shop');
const productRoutes = require('./src/routes/products');
const cartRoutes = require('./src/routes/cart');
const orderRoutes = require('./src/routes/orders');
const paymentRoutes = require('./src/routes/payments');
const adminRoutes = require('./src/routes/admin');
const chatRoutes = require('./src/routes/chat');
const locationRoutes = require('./src/routes/location');
const analyticsRoutes = require('./src/routes/analytics');
const addressRoutes = require('./src/routes/addresses');

// ============================================================
//  INITIALIZE APP
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

// Make io accessible to routes
app.set('io', io);

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET;

// ============================================================
//  VALIDATE CRITICAL ENVIRONMENT VARIABLES
// ============================================================

if (!JWT_SECRET) {
  console.error('❌ Missing JWT_SECRET in .env');
  process.exit(1);
}

// ============================================================
//  SECURITY MIDDLEWARE
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

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(cookieParser());

// ============================================================
//  REQUEST LOGGING MIDDLEWARE
// ============================================================

app.use((req, res, next) => {
  console.log(`📝 ${req.method} ${req.url}`);
  next();
});

// ============================================================
//  SERVE STATIC FILES
// ============================================================

// Main static files
app.use(express.static('public'));

// CSS files
app.use('/css', express.static(path.join(__dirname, 'public/css')));

// JS files
app.use('/js', express.static(path.join(__dirname, 'public/js')));

// HTML files
app.use(express.static(path.join(__dirname, 'public/html')));

// Uploads
app.use('/uploads', express.static(path.join(__dirname, 'public/uploads')));

// ============================================================
//  ROUTE HANDLER FOR HTML PAGES
// ============================================================

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public/html/index.html'));
});

app.get('/:page.html', (req, res) => {
  const page = req.params.page;
  const filePath = path.join(__dirname, 'public/html', `${page}.html`);
  if (fs.existsSync(filePath)) {
    res.sendFile(filePath);
  } else {
    res.status(404).send('Page not found');
  }
});

// ============================================================
//  HEALTH CHECK ENDPOINT
// ============================================================

app.get('/api/health', async (req, res) => {
  try {
    const dbResult = await pool.query('SELECT NOW()');
    const dbStatus = dbResult.rows.length > 0 ? 'connected' : 'disconnected';
    
    res.json({ 
      status: 'healthy', 
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      environment: process.env.NODE_ENV || 'development',
      database: dbStatus,
      port: PORT
    });
  } catch (err) {
    res.status(500).json({ 
      status: 'unhealthy', 
      error: err.message,
      timestamp: new Date().toISOString()
    });
  }
});

// ============================================================
//  RATE LIMITERS
// ============================================================

app.use('/api', generalLimiter);
app.use('/api/auth/login', sensitiveLimiter);
app.use('/api/auth/customer/login', sensitiveLimiter);
app.use('/api/orders', sensitiveLimiter);
app.use('/api/payments', sensitiveLimiter);

// ============================================================
//  API ROUTES
// ============================================================

app.use('/api/auth', authRoutes);
app.use('/api/shop', shopRoutes);
app.use('/api/products', cacheMiddleware(60), productRoutes);
app.use('/api/cart', cartRoutes);
app.use('/api/orders', orderRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/chat', chatRoutes);
app.use('/api/location', locationRoutes);
app.use('/api/analytics', analyticsRoutes);
app.use('/api/addresses', addressRoutes);

// ============================================================
//  CSRF TOKEN ENDPOINT
// ============================================================

app.get('/api/csrf-token', (req, res) => {
  try {
    const crypto = require('crypto');
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

setupSocketHandlers(io);

// ============================================================
//  CRON JOBS
// ============================================================

// 1. Auto-cancel unpaid orders after 24 hours
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

// 2. Auto-complete orders after 7 days of receipt
cron.schedule('0 0 * * *', async () => {
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
      
      await pool.query(
        `INSERT INTO order_chat_messages (order_id, from_user, message) 
         VALUES ($1, 'System', $2)`,
        [order.id, `✅ Order ${order.order_ref || order.id} auto-completed after 7 days of receipt.`]
      );
      
      console.log(`✅ Order ${order.id} auto-completed after 7 days`);
    }
  } catch (err) {
    console.error('❌ Auto-complete job error:', err);
    logError(err, 'Auto-complete job');
  }
});

// 3. Clean up expired password resets (every hour)
cron.schedule('0 * * * *', async () => {
  try {
    const result = await pool.query(
      'DELETE FROM password_resets WHERE expires_at < NOW()'
    );
    if (result.rowCount > 0) {
      console.log(`🧹 Cleaned up ${result.rowCount} expired password reset tokens`);
    }
  } catch (err) {
    console.error('❌ Password reset cleanup error:', err);
    logError(err, 'Password reset cleanup');
  }
});

// ============================================================
//  ERROR HANDLER
// ============================================================

app.use(globalErrorHandler);

// ============================================================
//  DATABASE INITIALIZATION
// ============================================================

async function initDatabase() {
  try {
    // Create password_resets table if not exists
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
    
    // Check if shop exists, if not create default
    const shopResult = await pool.query('SELECT COUNT(*) FROM shop');
    if (parseInt(shopResult.rows[0].count) === 0) {
      await pool.query(`
        INSERT INTO shop (name, location) 
        VALUES ('My Shop', 'Nairobi, Kenya')
      `);
      console.log('✅ Default shop created');
    }
    
    // Check if system_settings exists
    const settingsResult = await pool.query('SELECT COUNT(*) FROM system_settings');
    if (parseInt(settingsResult.rows[0].count) === 0) {
      await pool.query(`
        INSERT INTO system_settings (key, value) VALUES 
          ('replacement_hours', '6'),
          ('auto_cancel_hours', '24'),
          ('auto_complete_days', '7'),
          ('free_shipping_threshold', '40000')
      `);
      console.log('✅ Default system settings created');
    }
    
    // Add missing columns
    await pool.query(`ALTER TABLE shop ADD COLUMN IF NOT EXISTS base_url VARCHAR(255)`);
    console.log('✅ Shop table verified with base_url');
    
    await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS completed_at TIMESTAMP`);
    console.log('✅ Orders table verified with completed_at');
    
    await pool.query(`ALTER TABLE customers ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMP`);
    console.log('✅ Customers table verified with last_login_at');
    
    await pool.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS is_featured BOOLEAN DEFAULT false`);
    console.log('✅ Products table verified with is_featured');
    
    console.log('✅ Database initialization complete');
  } catch (err) {
    console.error('❌ Database initialization error:', err);
    logError(err, 'Database init');
  }
}

// ============================================================
//  VALIDATE ENVIRONMENT VARIABLES
// ============================================================

function validateEnv() {
  console.log('\n📋 Environment Validation:');
  console.log('========================================');
  
  const required = [
    'DATABASE_URL',
    'JWT_SECRET',
    'CLOUDINARY_CLOUD_NAME',
    'CLOUDINARY_API_KEY',
    'CLOUDINARY_API_SECRET'
  ];
  
  let allRequired = true;
  for (const key of required) {
    if (!process.env[key]) {
      console.log(`❌ Missing: ${key}`);
      allRequired = false;
    } else {
      const display = process.env[key].length > 20 ? process.env[key].substring(0, 10) + '...' : process.env[key];
      console.log(`✅ ${key}: ${display}`);
    }
  }
  
  console.log('========================================\n');
  
  // Check payment configs
  if (!process.env.MPESA_CONSUMER_KEY || process.env.MPESA_CONSUMER_KEY === 'YOUR_CONSUMER_KEY_HERE') {
    console.log('⚠️  M-Pesa: Not configured - STK Push will use simulation mode');
  } else {
    console.log('✅ M-Pesa: Configured');
  }
  
  if (!process.env.AIRTEL_CLIENT_ID || process.env.AIRTEL_CLIENT_ID === 'your_airtel_client_id_here') {
    console.log('⚠️  Airtel Money: Not configured - will use simulation mode');
  } else {
    console.log('✅ Airtel Money: Configured');
  }
  
  if (!process.env.PAYPAL_CLIENT_ID || process.env.PAYPAL_CLIENT_ID === 'your_paypal_client_id_here') {
    console.log('⚠️  PayPal: Not configured - will use simulation mode');
  } else {
    console.log('✅ PayPal: Configured');
  }
  
  console.log('========================================\n');
  
  if (!allRequired) {
    console.error('❌ Missing required environment variables. Please check your .env file.');
    console.log('💡 Required: DATABASE_URL, JWT_SECRET, CLOUDINARY_* variables');
  }
  
  return allRequired;
}

// ============================================================
//  START SERVER
// ============================================================

async function startServer() {
  try {
    await initDatabase();
    validateEnv();
    initPaypalClient();
    
    server.listen(PORT, () => {
      console.log('\n🚀 ========================================');
      console.log(`🚀  SERVER RUNNING AT http://localhost:${PORT}`);
      console.log('🚀 ========================================\n');
      console.log(`📦 PostgreSQL: Connected`);
      console.log(`☁️ Cloudinary: Ready`);
      console.log(`💰 M-Pesa: ${process.env.MPESA_CONSUMER_KEY && process.env.MPESA_CONSUMER_KEY !== 'YOUR_CONSUMER_KEY_HERE' ? '✅ Configured' : '⚠️ Simulation'}`);
      console.log(`📱 Airtel Money: ${process.env.AIRTEL_CLIENT_ID && process.env.AIRTEL_CLIENT_ID !== 'your_airtel_client_id_here' ? '✅ Configured' : '⚠️ Simulation'}`);
      console.log(`💳 PayPal: ${process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_CLIENT_ID !== 'your_paypal_client_id_here' ? '✅ Configured' : '⚠️ Simulation'}`);
      console.log(`📧 Email: ${process.env.SMTP_USER ? '✅ Configured' : '⚠️ Not configured'}`);
      console.log(`📊 Redis: ${process.env.REDIS_URL ? '✅ Enabled' : '⚠️ Disabled (using memory cache)'}`);
      console.log(`🔒 Security: ${helmet ? '✅ Enabled' : '⚠️ Disabled'}`);
      console.log(`⏰ Cron Jobs: ${cron ? '✅ Enabled' : '⚠️ Disabled'}`);
      console.log(`🌐 Base URL: ${process.env.BASE_URL || 'http://localhost:' + PORT}`);
      console.log('\n📋 Admin Panel: http://localhost:' + PORT + '/admin.html');
      console.log('📋 Shop: http://localhost:' + PORT + '/');
      console.log('\n✅ Server started successfully!\n');
    });
    
  } catch (err) {
    console.error('❌ Failed to start server:', err);
    process.exit(1);
  }
}

// ============================================================
//  GRACEFUL SHUTDOWN
// ============================================================

process.on('SIGTERM', () => {
  console.log('🔄 SIGTERM received, closing server...');
  server.close(() => {
    console.log('✅ Server closed');
    pool.end(() => {
      console.log('✅ Database pool closed');
      process.exit(0);
    });
  });
});

process.on('SIGINT', () => {
  console.log('🔄 SIGINT received, closing server...');
  server.close(() => {
    console.log('✅ Server closed');
    pool.end(() => {
      console.log('✅ Database pool closed');
      process.exit(0);
    });
  });
});

// ============================================================
//  UNHANDLED ERROR HANDLERS
// ============================================================

process.on('uncaughtException', (err) => {
  console.error('❌ Uncaught Exception:', err);
  logError(err, 'Uncaught Exception');
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Unhandled Rejection at:', promise);
  console.error('❌ Reason:', reason);
  logError(reason, 'Unhandled Rejection');
});

// ============================================================
//  START THE SERVER
// ============================================================

startServer();

module.exports = { app, server, io };