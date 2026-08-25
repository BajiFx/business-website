const { Pool } = require('pg');
const path = require('path');
const fs = require('fs');

// Logging function
function logError(error, context = '') {
  const logEntry = {
    timestamp: new Date().toISOString(),
    context,
    message: error.message || error,
    stack: error.stack,
    ...error
  };
  
  const logDir = path.join(__dirname, '../../logs');
  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
  }
  
  fs.appendFileSync(
    path.join(logDir, 'error.log'),
    JSON.stringify(logEntry) + '\n'
  );
  console.error('❌ Error:', error.message || error);
}

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

module.exports = { pool, logError };