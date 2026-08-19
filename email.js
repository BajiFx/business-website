// email.js
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
    subject: `Order ${ref} Confirmed!`,
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

// ---- Auto Social Messages ----
function getAutoSocialMessage(product) {
  const productName = product.name || 'this product';
  const productPrice = product.price || '';
  const productDesc = product.description || '';
  const productImage = product.image || '';

  // WhatsApp default message
  const whatsappMessage = `Hi, I'm interested in "${productName}" (${productPrice}). Could I get more information about this product? ${productDesc ? `\n\nDescription: ${productDesc}` : ''}`;

  // Instagram default message (shorter for DM)
  const instagramMessage = `Hi! I'm interested in "${productName}". Can you tell me more about it?`;

  // Facebook Messenger default message
  const messengerMessage = `Hi there! I came across "${productName}" on your shop. Could you share more details?`;

  return {
    whatsapp: whatsappMessage,
    instagram: instagramMessage,
    messenger: messengerMessage,
    productName,
    productPrice,
    productDesc,
    productImage
  };
}

module.exports = {
  orderConfirmationEmail,
  statusUpdateEmail,
  receivedEmail,
  getAutoSocialMessage
};