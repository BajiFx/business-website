// ================================================================
//  SOCKET HANDLER - Complete Fixed Version
//  Location: D:\my-business-website\src\socket\socketHandler.js
// ================================================================

const { pool, logError } = require('../config/database');
const jwt = require('jsonwebtoken');

function setupSocketHandlers(io) {
  // Authentication middleware
  io.use((socket, next) => {
    const token = socket.handshake.auth.token;
    if (!token) {
      socket.customerId = null;
      socket.role = null;
      return next();
    }
    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      socket.customerId = decoded.userId;
      socket.role = decoded.role || 'customer';
      next();
    } catch (err) {
      console.error('Socket auth error:', err.message);
      socket.customerId = null;
      socket.role = null;
      next(); // Allow connection but without auth
    }
  });

  io.on('connection', (socket) => {
    console.log('Client connected:', socket.id, 'Customer ID:', socket.customerId);

    if (socket.customerId) {
      socket.join(`customer_${socket.customerId}`);
    }

    // ---- Chat Message ----
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
        console.error('Chat error:', err);
        logError(err, 'Socket chat');
      }
    });

    // ---- Seller Chat ----
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
        console.error('Seller chat error:', err);
        logError(err, 'Socket seller chat');
      }
    });

    // ---- Chat History ----
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
        console.error('Chat history error:', err);
        logError(err, 'Socket chat history');
        socket.emit('chat-history', []);
      }
    });

    // ---- Customer Location ----
    socket.on('customer-location', (data) => {
      socket.broadcast.emit('customer-update', {
        socketId: socket.id,
        lat: data.lat,
        lng: data.lng,
        name: data.name || 'Customer'
      });
    });

    // ---- Get Customers ----
    socket.on('get-customers', () => {
      socket.emit('customer-list', []);
    });

    // ---- Join Order Room ----
    socket.on('join-order-room', (orderId) => {
      socket.join(`order_${orderId}`);
      console.log(`Socket ${socket.id} joined order room: ${orderId}`);
    });
    
    // ---- Leave Order Room ----
    socket.on('leave-order-room', (orderId) => {
      socket.leave(`order_${orderId}`);
      console.log(`Socket ${socket.id} left order room: ${orderId}`);
    });

    // ---- Admin Location Update ----
    socket.on('admin-location-update', (data) => {
      const { lat, lng } = data;
      if (lat && lng) {
        socket.broadcast.emit('admin_location', { lat, lng });
      }
    });

    // ---- Disconnect ----
    socket.on('disconnect', () => {
      console.log('Client disconnected:', socket.id);
      socket.broadcast.emit('customer-left', socket.id);
    });
  });
}

module.exports = { setupSocketHandlers };