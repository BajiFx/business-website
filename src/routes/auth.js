// ============================================================
//  AUTH ROUTES - Complete Fixed Version
//  Location: D:\my-business-website\src\routes\auth.js
// ============================================================

const express = require('express');
const { body, validationResult } = require('express-validator');
const bcrypt = require('bcrypt');
const { pool } = require('../config/database');
const { generateToken, authMiddleware } = require('../middleware/auth');
const { loginLimiter } = require('../middleware/rateLimiter');
const { validateKenyanPhone, generateResetToken } = require('../utils/helpers');
const { sendEmail, forgotPasswordEmail } = require('../services/email');
const { logAdminActivity } = require('../services/orderService');
const router = express.Router();

// ============================================================
//  ADMIN AUTH
// ============================================================

// Check if admin exists
router.get('/admin-exists', async (req, res) => {
  try {
    const result = await pool.query('SELECT COUNT(*) FROM admin_users');
    const count = parseInt(result.rows[0].count);
    console.log('👤 Admin exists check:', count > 0 ? '✅ Yes' : '❌ No');
    res.json({ exists: count > 0 });
  } catch (err) {
    console.error('❌ Admin exists error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Register admin (first-time setup)
router.post('/register', [
  body('email').isEmail().withMessage('Invalid email'),
  body('password').isLength({ min: 6 }).withMessage('Password must be at least 6 characters')
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  try {
    const { email, password } = req.body;
    
    // Check if admin already exists
    const existsResult = await pool.query('SELECT COUNT(*) FROM admin_users');
    const count = parseInt(existsResult.rows[0].count);
    
    if (count > 0) {
      return res.status(403).json({ error: 'An admin account already exists.' });
    }
    
    const hashedPassword = await bcrypt.hash(password, 10);
    const result = await pool.query(
      'INSERT INTO admin_users (email, password) VALUES ($1, $2) RETURNING id',
      [email, hashedPassword]
    );
    
    const token = generateToken(email, 'admin');
    await logAdminActivity(result.rows[0].id, 'REGISTER', { email });
    
    console.log('✅ Admin account created for:', email);
    res.json({ success: true, token, message: '✅ Admin account created successfully!' });
    
  } catch (err) {
    console.error('❌ Register error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Admin login
router.post('/login', loginLimiter, [
  body('email').isEmail().withMessage('Invalid email'),
  body('password').notEmpty().withMessage('Password required')
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  try {
    const { email, password } = req.body;
    console.log('🔑 Admin login attempt for:', email);
    
    const result = await pool.query('SELECT * FROM admin_users WHERE email = $1', [email]);
    
    if (result.rows.length === 0) {
      console.log('❌ Admin not found:', email);
      return res.status(401).json({ error: 'Invalid credentials - Admin not found' });
    }
    
    const user = result.rows[0];
    const match = await bcrypt.compare(password, user.password);
    
    if (!match) {
      console.log('❌ Invalid password for:', email);
      return res.status(401).json({ error: 'Invalid credentials - Wrong password' });
    }
    
    const token = generateToken(email, 'admin');
    await logAdminActivity(user.id, 'LOGIN', { email });
    
    console.log('✅ Admin login successful for:', email);
    res.json({ success: true, token });
    
  } catch (err) {
    console.error('❌ Login error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Verify token
router.get('/verify', authMiddleware, (req, res) => {
  res.json({ authenticated: true, role: req.role });
});

// ============================================================
//  CUSTOMER AUTH
// ============================================================

// Customer register
router.post('/customer/register', [
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
    console.error('❌ Customer register error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Customer login
router.post('/customer/login', loginLimiter, [
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
    
    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    
    const customer = result.rows[0];
    const match = await bcrypt.compare(password, customer.password);
    
    if (!match) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    
    await pool.query('UPDATE customers SET last_login_at = NOW() WHERE id = $1', [customer.id]);
    await pool.query(
      'INSERT INTO carts (customer_id, items) VALUES ($1, $2) ON CONFLICT (customer_id) DO NOTHING',
      [customer.id, '[]']
    );
    
    const token = generateToken(customer.id, 'customer');
    res.json({ 
      success: true, 
      token, 
      customer: { 
        id: customer.id, 
        name: customer.name, 
        email: customer.email, 
        phone: customer.phone || '' 
      } 
    });
    
  } catch (err) {
    console.error('❌ Customer login error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Verify customer
router.get('/customer/verify', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query('SELECT id, name, email, phone, created_at FROM customers WHERE id = $1', [req.userId]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    res.json({ user: result.rows[0] });
  } catch (err) {
    console.error('❌ Customer verify error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Update customer profile
router.put('/customer/profile', authMiddleware, async (req, res) => {
  const { name, phone, email } = req.body;
  try {
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
    console.error('❌ Profile update error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Customer logout
router.post('/customer/logout', authMiddleware, (req, res) => {
  res.json({ success: true });
});

// Check email exists
router.post('/customer/check-email', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email required' });
  try {
    const result = await pool.query('SELECT id FROM customers WHERE email = $1', [email]);
    res.json({ exists: result.rows.length > 0 });
  } catch (err) {
    console.error('❌ Check email error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Delete customer account
router.delete('/customer/delete', authMiddleware, async (req, res) => {
  try {
    const customerId = req.userId;
    await pool.query('BEGIN');
    await pool.query(`DELETE FROM order_items WHERE order_id IN (SELECT id FROM orders WHERE customer_id = $1)`, [customerId]);
    await pool.query(`DELETE FROM order_chat_messages WHERE order_id IN (SELECT id FROM orders WHERE customer_id = $1)`, [customerId]);
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
    console.error('❌ Delete account error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
//  PASSWORD RESET
// ============================================================

// Forgot password
router.post('/forgot-password', [
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
    const mailData = forgotPasswordEmail(email, resetLink);
    await sendEmail({
      to: email,
      subject: mailData.subject,
      html: mailData.html,
      text: mailData.text
    });

    res.json({ success: true, message: 'If your email is registered, you will receive a reset link.' });
  } catch (err) {
    console.error('❌ Forgot password error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Reset password
router.post('/reset-password', [
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
    console.error('❌ Reset password error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;