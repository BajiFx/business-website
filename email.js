function orderConfirmationEmail(order, customerName) {
  const ref = order.order_ref || `#${order.id}`;
  let itemsHtml = '';
  (order.items || []).forEach(item => {
    const priceNum = parseFloat(item.price.replace(/[^0-9.]/g,'')) || 0;
    const subtotal = priceNum * item.quantity;
    const uniqueId = item.unique_id || '—';
    itemsHtml += `<tr>
      <td>${item.product_name}</td>
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
        <tr style="background:#f1f5f9;"><th>Product</th><th>Qty</th><th>Unit Price</th><th>Subtotal</th><th>Product ID</th></tr>
        ${itemsHtml}
        <tr><td colspan="3" align="right"><strong>Total</strong></td><td><strong>Ksh ${total}</strong></td><td></td></tr>
      </table>
      <p>We will notify you when your order ships.</p>
      <p>Thank you for shopping with us!</p>
    `,
    text: `Order ${ref} Confirmed!\nTotal: Ksh ${total}\nThank you.`
  };
}