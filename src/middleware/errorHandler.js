const { logError } = require('../config/database');

function globalErrorHandler(err, req, res, next) {
  console.error('❌ Unhandled error:', err);
  logError(err, 'Global error handler');
  res.status(500).json({ error: 'Internal server error' });
}

module.exports = { globalErrorHandler };
