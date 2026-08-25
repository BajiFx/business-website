// ================================================================
//  email.js - Complete with fallback support & better error handling
// ================================================================

const nodemailer = require('nodemailer');

// ---- Email Queue ----
class EmailQueue {
  constructor() {
    this.queue = [];
    this.processing = false;
  }

  async add(email) {
    this.queue.push(email);
    if (!this.processing) {
      return this.process();
    }
  }

  async process() {
    if (this.processing || this.queue.length === 0) return;
    this.processing = true;
    
    while (this.queue.length > 0) {
      const email = this.queue.shift();
      try {
        await sendEmail(email);
      } catch (err) {
        console.error('❌ Email failed:', err.message);
      }
    }
    
    this.processing = false;
  }
}

const emailQueue = new EmailQueue();

// ---- Primary Email Configuration ----
const primaryTransporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: process.env.SMTP_PORT,
  secure: process.env.SMTP_SECURE === 'true',
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

// ---- Fallback Email Configuration (SendGrid) ----
const fallbackTransporter = nodemailer.createTransport({
  host: 'smtp.sendgrid.net',
  port: 587,
  secure: false,
  auth: {
    user: 'apikey',
    pass: process.env.SENDGRID_API_KEY,
  },
});

// ---- Validate Email Configuration ----
function validateEmailConfig() {
  const errors = [];
  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
    errors.push('SMTP not configured');
  }
  if (!process.env.SENDGRID_API_KEY || 
      process.env.SENDGRID_API_KEY === 'your_sendgrid_api_key_here') {
    errors.push('SendGrid not configured');
  }
  if (errors.length === 2) {
    console.error('❌ No email provider configured!');
    console.log('📧 Email notifications will be disabled.');
    return false;
  }
  return true;
}

// ---- Send email with fallback ----
async function sendEmail({ to, subject, html, text }) {
  if (!validateEmailConfig()) {
    console.warn('⚠️ Email disabled - no configuration found');
    return { messageId: 'disabled', accepted: [] };
  }

  // Try primary first
  if (process.env.SMTP_USER && process.env.SMTP_PASS) {
    try {
      const info = await primaryTransporter.sendMail({
        from: process.env.SMTP_FROM || process.env.SMTP_USER,
        to,
        subject,
        html,
        text,
      });
      console.log(`📧 Email sent via primary to ${to}: ${info.messageId}`);
      return info;
    } catch (err) {
      console.error('❌ Primary email error:', err.message);
      console.log('🔄 Trying fallback email provider...');
      return sendEmailFallback({ to, subject, html, text });
    }
  }
  
  return sendEmailFallback({ to, subject, html, text });
}

// ---- Send email with queue ----
async function sendEmailQueued({ to, subject, html, text }) {
  return emailQueue.add({ to, subject, html, text });
}

// ---- Fallback email sending ----
async function sendEmailFallback({ to, subject, html, text }) {
  if (!process.env.SENDGRID_API_KEY || process.env.SENDGRID_API_KEY === 'your_sendgrid_api_key_here') {
    console.error('❌ No fallback email configured');
    throw new Error('No email provider configured');
  }

  try {
    const info = await fallbackTransporter.sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      to,
      subject,
      html,
      text,
    });
    console.log(`📧 Email sent via fallback to ${to}: ${info.messageId}`);
    return info;
  } catch (err) {
    console.error('❌ Fallback email error:', err.message);
    throw err;
  }
}

// ---- Order Confirmation Email ----
function orderConfirmationEmail(order, customerName) {
  const ref = order.order_ref || `#${order.id}`;
  let itemsHtml = '';
  (order.items || []).forEach(item => {
    const priceNum = parseFloat(item.price.replace(/[^0-9.]/g,'')) || 0;
    const subtotal = priceNum * item.quantity;
    const uniqueId = item.unique_id || '—';
    const variantName = item.variant_name || 'Default';
    itemsHtml += `<tr>
      <td>${item.product_name}</td>
      <td>${variantName}</td>
      <td>${item.quantity}</td>
      <td>Ksh ${priceNum.toFixed(2)}</td>
      <td>Ksh ${subtotal.toFixed(2)}</td>
      <td style="font-family:monospace;">${uniqueId}</td>
    </tr>`;
  });
  const total = Number(order.total).toFixed(2);
  return {
    subject: `Order ${ref} Confirmed! ✅`,
    html: `
      <h2>Order Confirmed ✅</h2>
      <p>Dear ${customerName},</p>
      <p>Your order has been confirmed. Here are the details:</p>
      <table border="1" cellpadding="5" style="border-collapse:collapse; width:100%; font-family:Arial;">
        <tr style="background:#f1f5f9;"><th>Product</th><th>Variant</th><th>Qty</th><th>Unit Price</th><th>Subtotal</th><th>Product ID</th></tr>
        ${itemsHtml}
        <tr><td colspan="4" align="right"><strong>Total</strong></td><td><strong>Ksh ${total}</strong></td><td></td></tr>
      </table>
      <p>We will notify you when your order ships.</p>
      <p>Thank you for shopping with us!</p>
    `,
    text: `Order ${ref} Confirmed!\nTotal: Ksh ${total}\nThank you.`
  };
}

// ---- Status Update Email ----
function statusUpdateEmail(order, newStatus, customerName) {
  const ref = order.order_ref || `#${order.id}`;
  const tracking = order.tracking_number ? `Tracking: ${order.tracking_number}` : '';
  return {
    subject: `Order ${ref} Updated to ${newStatus}`,
    html: `
      <h2>Order ${ref} ${newStatus.toUpperCase()}</h2>
      <p>Dear ${customerName},</p>
      <p>Your order has been updated to: <strong>${newStatus.toUpperCase()}</strong></p>
      ${tracking ? `<p>Tracking number: ${tracking}</p>` : ''}
      <p>Thank you for shopping with us!</p>
    `,
    text: `Order ${ref} ${newStatus.toUpperCase()}\n${tracking}\nThank you.`
  };
}

// ---- Received Email ----
function receivedEmail(order, customerName) {
  const ref = order.order_ref || `#${order.id}`;
  return {
    subject: `Order ${ref} Received Confirmation`,
    html: `
      <h2>✅ Order ${ref} Received</h2>
      <p>Dear ${customerName},</p>
      <p>You have confirmed receipt of your order. Thank you for your trust!</p>
      <p>We hope you enjoy your products.</p>
    `,
    text: `Order ${ref} Received. Thank you!`
  };
}

// ---- Export ----
module.exports = {
  sendEmail,
  sendEmailQueued,
  orderConfirmationEmail,
  statusUpdateEmail,
  receivedEmail,
  validateEmailConfig
};