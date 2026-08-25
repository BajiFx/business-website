const jwt = require('jsonwebtoken');

function generateToken(userId, role = 'customer') {
  return jwt.sign({ userId, role }, process.env.JWT_SECRET, { expiresIn: '7d' });
}

function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.userId = decoded.userId;
    req.role = decoded.role || 'customer';
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

function adminOnly(req, res, next) {
  if (req.role !== 'admin') {
    return res.status(403).json({ error: 'Admin only' });
  }
  next();
}

function customerOnly(req, res, next) {
  if (req.role !== 'customer') {
    return res.status(403).json({ error: 'Customer only' });
  }
  next();
}

module.exports = { generateToken, authMiddleware, adminOnly, customerOnly };