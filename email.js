// email.js - Complete production version

function orderConfirmationEmail(order, customerName) {
  const ref = order.order_ref || `#${order.id}`;
  let itemsHtml = '';

  (order.items || []).forEach(item => {
    const priceNum = parseFloat(String(item.price).replace(/[^0-9.]/g, '')) || 0;
    const subtotal = priceNum * (item.quantity || 1);
    const uniqueId = item.unique_id || '—';
    const variantName = item.variant_name || 'Default';

    itemsHtml += `
      <tr>
        <td style="padding:8px;border:1px solid #e2e8f0;">${item.product_name || item.name || 'Product'}</td>
        <td style="padding:8px;border:1px solid #e2e8f0;">${variantName}</td>
        <td style="padding:8px;border:1px solid #e2e8f0;text-align:center;">${item.quantity || 1}</td>
        <td style="padding:8px;border:1px solid #e2e8f0;">Ksh ${priceNum.toFixed(2)}</td>
        <td style="padding:8px;border:1px solid #e2e8f0;">Ksh ${subtotal.toFixed(2)}</td>
        <td style="padding:8px;border:1px solid #e2e8f0;font-family:monospace;font-size:12px;">${uniqueId}</td>
      </tr>`;
  });

  const total = Number(order.total || 0).toFixed(2);
  const shipping = Number(order.shipping_cost || 0).toFixed(2);
  const discount = Number(order.discount_applied || 0).toFixed(2);

  return {
    subject: `Order ${ref} Confirmed - Doreen Household Fabrics`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#1e293b;">
        <h2 style="color:#2563eb;">Order Confirmed ✅</h2>
        <p>Dear ${customerName || 'Customer'},</p>
        <p>Thank you for your order! Your order has been confirmed. Here are the details:</p>

        <table style="width:100%;border-collapse:collapse;margin:20px 0;font-size:14px;">
          <thead>
            <tr style="background:#f1f5f9;">
              <th style="padding:10px;border:1px solid #e2e8f0;text-align:left;">Product</th>
              <th style="padding:10px;border:1px solid #e2e8f0;text-align:left;">Variant</th>
              <th style="padding:10px;border:1px solid #e2e8f0;text-align:center;">Qty</th>
              <th style="padding:10px;border:1px solid #e2e8f0;text-align:left;">Unit Price</th>
              <th style="padding:10px;border:1px solid #e2e8f0;text-align:left;">Subtotal</th>
              <th style="padding:10px;border:1px solid #e2e8f0;text-align:left;">Product ID</th>
            </tr>
          </thead>
          <tbody>
            ${itemsHtml}
            <tr>
              <td colspan="4" style="padding:10px;border:1px solid #e2e8f0;text-align:right;"><strong>Shipping</strong></td>
              <td style="padding:10px;border:1px solid #e2e8f0;"><strong>Ksh ${shipping}</strong></td>
              <td style="padding:10px;border:1px solid #e2e8f0;"></td>
            </tr>
            ${Number(discount) > 0 ? `
            <tr>
              <td colspan="4" style="padding:10px;border:1px solid #e2e8f0;text-align:right;"><strong>Discount</strong></td>
              <td style="padding:10px;border:1px solid #e2e8f0;"><strong>-Ksh ${discount}</strong></td>
              <td style="padding:10px;border:1px solid #e2e8f0;"></td>
            </tr>` : ''}
            <tr style="background:#f8fafc;">
              <td colspan="4" style="padding:10px;border:1px solid #e2e8f0;text-align:right;"><strong>Total</strong></td>
              <td style="padding:10px;border:1px solid #e2e8f0;"><strong>Ksh ${total}</strong></td>
              <td style="padding:10px;border:1px solid #e2e8f0;"></td>
            </tr>
          </tbody>
        </table>

        <p><strong>Delivery Address:</strong><br>
        ${order.delivery_address || 'Not provided'}<br>
        ${order.recipient_name ? `Recipient: ${order.recipient_name}` : ''}
        ${order.recipient_phone ? ` (${order.recipient_phone})` : ''}</p>

        ${order.delivery_instructions ? `<p><strong>Instructions:</strong> ${order.delivery_instructions}</p>` : ''}

        <p>We will notify you when your order ships.</p>
        <p>Thank you for shopping with <strong>Doreen Household Fabrics</strong>!</p>
      </div>
    `,
    text: `Order ${ref} Confirmed!\nTotal: Ksh ${total}\nThank you for shopping with Doreen Household Fabrics.`
  };
}

function statusUpdateEmail(order, newStatus, customerName) {
  const ref = order.order_ref || `#${order.id}`;
  const tracking = order.tracking_number ? `Tracking Number: ${order.tracking_number}` : '';

  const statusMessages = {
    confirmed: 'Your order has been confirmed and is being prepared.',
    shipped: 'Your order has been shipped!',
    delivered: 'Your order has been delivered. Please confirm receipt in your account.',
    received: 'Thank you for confirming receipt of your order.',
    cancelled: 'Your order has been cancelled.'
  };

  const message = statusMessages[newStatus] || `Your order status has been updated to: ${newStatus.toUpperCase()}`;

  return {
    subject: `Order ${ref} - ${newStatus.toUpperCase()}`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#1e293b;">
        <h2 style="color:#2563eb;">Order ${ref} ${newStatus.toUpperCase()}</h2>
        <p>Dear ${customerName || 'Customer'},</p>
        <p>${message}</p>
        ${tracking ? `<p><strong>${tracking}</strong></p>` : ''}
        <p>You can track your order anytime in your account.</p>
        <p>Thank you for shopping with <strong>Doreen Household Fabrics</strong>!</p>
      </div>
    `,
    text: `Order ${ref} ${newStatus.toUpperCase()}\n${tracking}\nThank you.`
  };
}

function receivedEmail(order, customerName) {
  const ref = order.order_ref || `#${order.id}`;
  return {
    subject: `Order ${ref} Received - Thank You!`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#1e293b;">
        <h2 style="color:#16a34a;">✅ Order ${ref} Received</h2>
        <p>Dear ${customerName || 'Customer'},</p>
        <p>You have confirmed receipt of your order. Thank you for your trust!</p>
        <p>We hope you enjoy your products. If you have any issues, please contact us.</p>
        <p>Thank you for shopping with <strong>Doreen Household Fabrics</strong>!</p>
      </div>
    `,
    text: `Order ${ref} Received. Thank you for shopping with us!`
  };
}

function passwordResetEmail(resetLink, customerName) {
  return {
    subject: 'Password Reset - Doreen Household Fabrics',
    html: `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#1e293b;">
        <h2 style="color:#2563eb;">Password Reset Request</h2>
        <p>Dear ${customerName || 'Customer'},</p>
        <p>We received a request to reset your password. Click the button below to set a new password:</p>
        <p style="text-align:center;margin:30px 0;">
          <a href="${resetLink}" style="background:#2563eb;color:white;padding:12px 28px;text-decoration:none;border-radius:8px;font-weight:bold;">Reset Password</a>
        </p>
        <p>This link will expire in 1 hour.</p>
        <p>If you did not request this, you can safely ignore this email.</p>
        <p>Thank you,<br><strong>Doreen Household Fabrics</strong></p>
      </div>
    `,
    text: `Password Reset\nClick this link to reset your password: ${resetLink}\nThis link expires in 1 hour.`
  };
}

function getAutoSocialMessage(product) {
  const productName = product.name || 'this product';
  const productPrice = product.price || '';
  const productDesc = product.description || '';

  const whatsappMessage = `Hi, I'm interested in "${productName}" (${productPrice}). Could I get more information about this product?${productDesc ? `\n\nDescription: ${productDesc}` : ''}`;
  const instagramMessage = `Hi! I'm interested in "${productName}". Can you tell me more about it?`;
  const messengerMessage = `Hi there! I came across "${productName}" on your shop. Could you share more details?`;

  return {
    whatsapp: whatsappMessage,
    instagram: instagramMessage,
    messenger: messengerMessage,
    productName,
    productPrice,
    productDesc,
    productImage: product.image || ''
  };
}

module.exports = {
  orderConfirmationEmail,
  statusUpdateEmail,
  receivedEmail,
  passwordResetEmail,
  getAutoSocialMessage
};