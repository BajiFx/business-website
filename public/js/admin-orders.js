// ============================================================
//  ADMIN ORDERS JAVASCRIPT - Complete Fixed Version
//  Location: D:\my-business-website\public\js\admin-orders.js
// ============================================================

const adminToken = localStorage.getItem('token');
if (!adminToken) {
  alert('Please login as admin.');
  window.location.href = '/admin.html';
}
let socket = null;
let ordersData = [];

function logoutAdmin() {
  localStorage.removeItem('token');
  window.location.href = '/admin.html';
}

const urlParams = new URLSearchParams(window.location.search);
const initialStatus = urlParams.get('status');

function getFilters() {
  return {
    status: document.getElementById('filterStatus').value,
    search: document.getElementById('filterSearch').value.trim(),
    startDate: document.getElementById('filterStart').value,
    endDate: document.getElementById('filterEnd').value
  };
}

function applyFilters() { loadOrders(); }
function resetFilters() {
  document.getElementById('filterStatus').value = 'all';
  document.getElementById('filterSearch').value = '';
  document.getElementById('filterStart').value = '';
  document.getElementById('filterEnd').value = '';
  loadOrders();
}

function loadOrders() {
  const container = document.getElementById('ordersContainer');
  container.innerHTML = '<p style="text-align:center; padding:20px; color:#94a3b8;">Loading...</p>';
  const filters = getFilters();

  if (filters.status === 'returns') {
    loadReturns();
    return;
  }

  let url = '/api/admin/orders?';
  const params = new URLSearchParams();
  if (filters.status && filters.status !== 'all') params.append('status', filters.status);
  if (filters.search) params.append('search', filters.search);
  if (filters.startDate) params.append('startDate', filters.startDate);
  if (filters.endDate) params.append('endDate', filters.endDate);
  url += params.toString();

  fetch(url, { headers: { 'Authorization': `Bearer ${adminToken}` } })
    .then(res => {
      if (res.status === 401) { logoutAdmin(); throw new Error('Unauthorized'); }
      return res.json();
    })
    .then(orders => {
      ordersData = orders;
      let filtered = orders;
      if (filters.status === 'replacements') {
        filtered = orders.filter(o => o.replacement_status && o.replacement_status !== 'none' && o.replacement_status !== 'approved' && o.replacement_status !== 'rejected');
      } else if (filters.status === 'refunds') {
        filtered = orders.filter(o => o.refund_status === 'pending');
      } else if (filters.status === 'urgent') {
        filtered = orders.filter(o => o.urgent_delivery === true && o.status !== 'received' && o.status !== 'cancelled');
      }
      if (!filtered || filtered.length === 0) {
        container.innerHTML = '<p style="color:#94a3b8; text-align:center;">No orders match your filters.</p>';
        return;
      }
      filtered.sort((a, b) => {
        const order = { pending: 0, pending_payment: 1, confirmed: 2, shipped: 3, delivered: 4, received: 5, cancelled: 6 };
        return (order[a.status] || 0) - (order[b.status] || 0);
      });
      container.innerHTML = filtered.map(order => renderOrderCard(order)).join('');
      if (!socket) initSocket();
    })
    .catch(err => {
      console.error(err);
      container.innerHTML = `<p style="color:#ef4444;">❌ Error loading orders: ${err.message}</p>`;
    });
}

function loadReturns() {
  const container = document.getElementById('ordersContainer');
  container.innerHTML = '<p style="text-align:center; padding:20px; color:#94a3b8;">Loading returns...</p>';
  fetch('/api/admin/returns', { headers: { 'Authorization': `Bearer ${adminToken}` } })
    .then(res => res.json())
    .then(returns => {
      if (!returns || returns.length === 0) {
        container.innerHTML = '<p style="color:#94a3b8; text-align:center;">No returns found.</p>';
        return;
      }
      let html = '';
      returns.forEach(r => {
        html += `
          <div class="order-card">
            <div class="order-header">
              <span class="id">Return #${r.id} (Order ${r.order_ref})</span>
              <span>${r.customer_name}</span>
              <span class="status status-${r.status}">${r.status.toUpperCase()}</span>
              <span>${new Date(r.requested_at).toLocaleString()}</span>
              <button class="btn btn-primary btn-sm" onclick="toggleReturnDetails(${r.id})">Details</button>
            </div>
            <div class="order-detail" id="return-detail-${r.id}">
              <div><strong>Product ID:</strong> ${r.product_id}</div>
              <div><strong>Reason:</strong> ${r.reason}</div>
              <div><strong>Refund Amount:</strong> Ksh ${parseFloat(r.refund_amount || 0).toFixed(2)}</div>
              <div style="margin-top:6px; display:flex; gap:6px;">
                ${r.status === 'pending' ? `
                  <button class="btn btn-success btn-sm" onclick="handleReturn(${r.id},'approve')">Approve</button>
                  <button class="btn btn-danger btn-sm" onclick="handleReturn(${r.id},'reject')">Reject</button>
                ` : `<span style="font-size:0.7rem; color:#94a3b8;">Processed</span>`}
              </div>
            </div>
          </div>
        `;
      });
      container.innerHTML = html;
    })
    .catch(err => {
      console.error(err);
      container.innerHTML = `<p style="color:#ef4444;">❌ Error loading returns: ${err.message}</p>`;
    });
}

function toggleReturnDetails(id) {
  const detail = document.getElementById(`return-detail-${id}`);
  if (detail) detail.classList.toggle('active');
}

function handleReturn(returnId, action) {
  if (!confirm(`${action === 'approve' ? 'Approve' : 'Reject'} this return?`)) return;
  fetch(`/api/admin/returns/${returnId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${adminToken}` },
    body: JSON.stringify({ action })
  })
    .then(res => res.json())
    .then(data => {
      if (data.success) {
        alert(`Return ${action}d.`);
        loadOrders();
      } else {
        alert('Failed: ' + (data.error || 'Unknown error'));
      }
    })
    .catch(() => alert('Network error.'));
}

function renderOrderCard(order) {
  const ref = order.order_ref || `#${order.id}`;
  const isUrgent = order.urgent_delivery === true;
  const urgentClass = isUrgent ? 'urgent' : '';
  let history = order.status_history || [];
  if (typeof history === 'string') history = JSON.parse(history);
  const statusesList = ['pending_payment', 'pending', 'confirmed', 'shipped', 'delivered', 'received', 'cancelled', 'completed'];
  let timelineHtml = '<div class="timeline">';
  statusesList.forEach(s => {
    const entry = history.find(h => h.status === s);
    const active = order.status === s ? 'active' : '';
    const time = entry ? new Date(entry.timestamp).toLocaleString() : '';
    const icon = s === 'pending_payment' ? '⏳' : s === 'pending' ? '🕐' : s === 'confirmed' ? '✅' : s === 'shipped' ? '🚚' : s === 'delivered' ? '📦' : s === 'received' ? '✔️' : s === 'cancelled' ? '❌' : '🎉';
    if (entry || order.status === s) {
      timelineHtml += `<div class="step ${active}"><i>${icon}</i> ${s.charAt(0).toUpperCase()+s.slice(1)} ${time ? `<span class="time">${time}</span>` : ''}</div>`;
    }
  });
  timelineHtml += '</div>';

  let indicators = '';
  if (order.replacement_status && order.replacement_status !== 'none' && order.replacement_status !== 'approved' && order.replacement_status !== 'rejected') {
    indicators += `<span class="icon-indicator"><span class="blink-dot red"></span> Replacement</span>`;
  }
  if (order.refund_status && order.refund_status === 'pending') {
    indicators += `<span class="icon-indicator"><span class="blink-dot green"></span> Refund</span>`;
  }
  if (isUrgent) {
    indicators += `<span class="icon-indicator"><span class="blink-dot blue"></span> Urgent</span>`;
  }

  let locationHtml = '';
  if (order.delivery_address || order.customer_lat) {
    locationHtml = `
      <div class="location-box">
        <strong>📍 Delivery Location</strong>
        <div style="margin-top:2px;">
          ${order.delivery_address ? `<div><strong>Address:</strong> ${order.delivery_address}</div>` : ''}
          ${order.recipient_name ? `<div><strong>Recipient:</strong> ${order.recipient_name} (${order.recipient_phone || 'N/A'})</div>` : ''}
          ${order.delivery_instructions ? `<div><strong>Instructions:</strong> ${order.delivery_instructions}</div>` : ''}
          ${order.customer_lat && order.customer_lng ? `
            <div><strong>GPS:</strong> ${order.customer_lat}, ${order.customer_lng}</div>
            <div><a href="https://www.google.com/maps?q=${order.customer_lat},${order.customer_lng}" target="_blank">📌 View on Map</a></div>
          ` : ''}
          ${order.location_detected_at ? `<div style="font-size:0.65rem; color:#94a3b8;">📍 Detected: ${new Date(order.location_detected_at).toLocaleString()}</div>` : ''}
        </div>
      </div>
    `;
  }

  let actionsHtml = '';
  let statusOptions = '';
  if (order.status === 'pending') {
    statusOptions = `<option value="confirmed">Confirm</option><option value="shipped">Ship</option>`;
  } else if (order.status === 'confirmed') {
    statusOptions = `<option value="shipped">Ship</option>`;
  } else if (order.status === 'shipped') {
    statusOptions = `<option value="delivered">Deliver</option>`;
  } else if (order.status === 'delivered') {
    statusOptions = `<option value="received">Mark Received</option>`;
  }
  if (statusOptions) {
    actionsHtml += `
      <select id="statusSelect-${order.id}" style="padding:4px; border:1px solid #d1d5db; border-radius:4px; font-size:0.7rem;">
        <option value="">Update...</option>
        ${statusOptions}
      </select>
      <input type="text" id="trackingInput-${order.id}" placeholder="Tracking #" style="width:80px;">
      <button class="btn btn-primary btn-sm" onclick="updateOrderStatus(${order.id})">Update</button>
    `;
  }
  if (order.status === 'pending') {
    actionsHtml += `<button class="btn btn-success btn-sm" onclick="confirmOrder(${order.id})">Confirm</button>`;
  }
  if (order.status === 'delivered') {
    actionsHtml += `<button class="btn btn-warning btn-sm" onclick="remindCustomer(${order.id})"><i class="fas fa-bell"></i> Remind</button>`;
  }
  if (order.refund_status === 'pending') {
    actionsHtml += `
      <button class="btn btn-success btn-sm" onclick="handleRefund(${order.id},'approve')">Approve Refund</button>
      <button class="btn btn-danger btn-sm" onclick="handleRefund(${order.id},'reject')">Reject</button>
    `;
  }
  if (['pending_payment','pending_refund'].includes(order.replacement_status)) {
    actionsHtml += `
      <button class="btn btn-success btn-sm" onclick="handleReplacement(${order.id},'approve')">Approve Replacement</button>
      <button class="btn btn-danger btn-sm" onclick="handleReplacement(${order.id},'reject')">Reject</button>
    `;
  }
  if (order.status === 'delivered') {
    actionsHtml += `<button class="btn btn-success btn-sm" onclick="markReceived(${order.id})">Mark Received</button>`;
  }
  if (['pending','confirmed','pending_payment'].includes(order.status)) {
    actionsHtml += `<button class="btn btn-danger btn-sm" onclick="cancelOrder(${order.id})">Cancel</button>`;
  }
  if (order.status === 'confirmed' || order.status === 'pending') {
    actionsHtml += `
      <button class="btn btn-success btn-sm" onclick="sendOrderConfirmation(${order.id})">
        <i class="fas fa-check-circle"></i> Send Confirmation
      </button>
    `;
  }
  actionsHtml += ` <button class="btn btn-info btn-sm" onclick="togglePayments(${order.id})">Payments</button>`;

  return `
    <div class="order-card ${urgentClass}">
      <div class="order-header">
        <span class="id">Order ${ref}</span>
        <span>${order.customer_name}</span>
        <span class="status status-${order.status}">${order.status.toUpperCase()}</span>
        <span>${new Date(order.created_at).toLocaleString()}</span>
        ${order.shipping_tier ? `<span style="font-size:0.7rem;">🚚 ${order.shipping_tier}</span>` : ''}
        <button class="btn btn-primary btn-sm" onclick="toggleDetails(${order.id})">Details</button>
      </div>
      ${indicators}
      ${timelineHtml}
      <div class="order-detail" id="detail-${order.id}">
        <div><strong>Items:</strong></div>
        ${order.items && order.items.length > 0 ? order.items.map(item => `
          <div style="display:flex; justify-content:space-between; padding:2px 0; font-size:0.75rem; border-bottom:1px solid #f1f4f8;">
            <span>${item.product_name} (${item.variant_name||'Default'}) x${item.quantity}</span>
            <span>${item.price} ${item.unique_id ? `<span style="font-family:monospace; font-size:0.6rem;">${item.unique_id}</span>` : ''}</span>
          </div>
        `).join('') : '<div>No items</div>'}
        <div style="font-weight:700; margin-top:6px;">Total: Ksh ${parseFloat(order.total).toFixed(2)}</div>
        ${locationHtml}
        <div style="margin-top:6px; display:flex; gap:6px; flex-wrap:wrap;">
          ${actionsHtml}
        </div>
        <div id="payments-${order.id}" class="payments-container" style="display:none;"></div>
        <div style="margin-top:8px;">
          <strong>Chat:</strong>
          <div class="chat-box" id="chatMessages-${order.id}">Loading...</div>
          <div style="display:flex; margin-top:4px;">
            <input type="text" id="chatInput-${order.id}" placeholder="Type..." style="flex:1; padding:4px 8px; border:1px solid #d1d5db; border-radius:4px; font-size:0.75rem;">
            <button onclick="sendOrderChat(${order.id})" style="margin-left:4px; padding:4px 12px; background:#2563eb; color:white; border:none; border-radius:4px; font-size:0.7rem;">Send</button>
          </div>
        </div>
      </div>
    </div>
  `;
}

function toggleDetails(orderId) {
  const detail = document.getElementById(`detail-${orderId}`);
  if (!detail) return;
  detail.classList.toggle('active');
  if (detail.classList.contains('active')) {
    loadOrderChat(orderId);
    if (socket) socket.emit('join-order-room', orderId);
  } else {
    if (socket) socket.emit('leave-order-room', orderId);
  }
}

function loadOrderChat(orderId) {
  const chatBox = document.getElementById(`chatMessages-${orderId}`);
  if (!chatBox) return;
  chatBox.innerHTML = 'Loading...';
  fetch(`/api/orders/${orderId}/chat`, { headers: { 'Authorization': `Bearer ${adminToken}` } })
    .then(res => res.json())
    .then(messages => {
      chatBox.innerHTML = '';
      if (!messages || messages.length === 0) {
        chatBox.innerHTML = '<div style="color:#94a3b8;">No messages yet.</div>';
        return;
      }
      messages.forEach(msg => {
        const div = document.createElement('div');
        div.className = `chat-msg ${msg.from_user === 'Seller' ? 'seller' : msg.from_user === 'System' ? 'system' : 'customer'}`;
        div.innerHTML = `<strong>${msg.from_user}:</strong> ${msg.message} <span style="float:right; font-size:0.6rem; opacity:0.6;">${new Date(msg.timestamp).toLocaleTimeString()}</span>`;
        chatBox.appendChild(div);
      });
      chatBox.scrollTop = chatBox.scrollHeight;
    })
    .catch(() => { chatBox.innerHTML = 'Error loading messages.'; });
}

function sendOrderChat(orderId) {
  const input = document.getElementById(`chatInput-${orderId}`);
  if (!input) return;
  const msg = input.value.trim();
  if (!msg) return;
  fetch(`/api/orders/${orderId}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${adminToken}` },
    body: JSON.stringify({ message: msg })
  })
    .then(res => res.json())
    .then(data => {
      if (data.success) {
        input.value = '';
        const chatBox = document.getElementById(`chatMessages-${orderId}`);
        const div = document.createElement('div');
        div.className = 'chat-msg seller';
        div.innerHTML = `<strong>Seller:</strong> ${msg} <span style="float:right; font-size:0.6rem; opacity:0.6;">Just now</span>`;
        chatBox.appendChild(div);
        chatBox.scrollTop = chatBox.scrollHeight;
      } else {
        alert('Failed to send message.');
      }
    })
    .catch(() => alert('Network error.'));
}

function togglePayments(orderId) {
  const container = document.getElementById(`payments-${orderId}`);
  if (!container) return;
  if (container.style.display === 'block') {
    container.style.display = 'none';
    return;
  }
  container.style.display = 'block';
  container.innerHTML = 'Loading payments...';
  fetch(`/api/payments/order/${orderId}`, { headers: { 'Authorization': `Bearer ${adminToken}` } })
    .then(res => res.json())
    .then(payments => {
      if (!payments || payments.length === 0) {
        container.innerHTML = '<span style="color:#94a3b8;">No payments recorded.</span>';
        return;
      }
      let html = '';
      payments.forEach(p => {
        const statusColor = p.status === 'success' ? '#16a34a' : '#ef4444';
        html += `
          <div style="display:flex; justify-content:space-between; padding:2px 0; border-bottom:1px solid #f1f4f8;">
            <span><strong>${p.method.toUpperCase()}</strong> ${p.transaction_id || ''}</span>
            <span>Ksh ${parseFloat(p.amount).toFixed(2)}</span>
            <span style="color:${statusColor};">${p.status}</span>
            <span style="font-size:0.6rem; color:#94a3b8;">${new Date(p.created_at).toLocaleString()}</span>
          </div>
        `;
      });
      container.innerHTML = html;
    })
    .catch(() => { container.innerHTML = '<span style="color:#ef4444;">Error loading payments.</span>'; });
}

function sendOrderConfirmation(orderId) {
  if (!confirm('Send order confirmation message to the customer?')) return;
  fetch(`/api/orders/${orderId}/send-confirmation`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${adminToken}` }
  })
    .then(res => res.json())
    .then(data => {
      if (data.success) {
        alert('✅ Confirmation sent to customer via chat.');
        loadOrders();
      } else {
        alert('❌ Failed: ' + (data.error || 'Unknown error'));
      }
    })
    .catch(() => alert('❌ Network error.'));
}

function updateOrderStatus(orderId) {
  const statusSelect = document.getElementById(`statusSelect-${orderId}`);
  const trackingInput = document.getElementById(`trackingInput-${orderId}`);
  if (!statusSelect) return;
  const status = statusSelect.value;
  const tracking = trackingInput?.value?.trim() || '';
  if (!status) return;
  if (!confirm(`Update order to ${status.toUpperCase()}?`)) return;
  fetch(`/api/admin/orders/${orderId}/status`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${adminToken}` },
    body: JSON.stringify({ status, tracking_number: tracking || undefined })
  })
    .then(res => res.json())
    .then(data => {
      if (data.success) { alert('✅ Order status updated.'); loadOrders(); }
      else { alert('❌ Failed: ' + (data.error || 'Unknown error')); }
    })
    .catch(() => alert('❌ Network error.'));
}

function confirmOrder(orderId) {
  if (!confirm('Confirm this order?')) return;
  fetch(`/api/admin/orders/${orderId}/confirm`, { method: 'PUT', headers: { 'Authorization': `Bearer ${adminToken}` } })
    .then(res => res.json())
    .then(data => {
      if (data.success) { alert('✅ Order confirmed.'); loadOrders(); }
      else { alert('❌ Failed: ' + (data.error || 'Unknown error')); }
    })
    .catch(() => alert('❌ Network error.'));
}

function markReceived(orderId) {
  if (!confirm('Mark this order as received by customer?')) return;
  fetch(`/api/orders/${orderId}/receive`, { method: 'PUT', headers: { 'Authorization': `Bearer ${adminToken}` } })
    .then(res => res.json())
    .then(data => {
      if (data.success) { alert('✅ Order marked as received.'); loadOrders(); }
      else { alert('❌ Failed: ' + (data.error || 'Unknown error')); }
    })
    .catch(() => alert('❌ Network error.'));
}

function handleRefund(orderId, action) {
  if (!confirm(`${action === 'approve' ? 'Approve' : 'Reject'} refund?`)) return;
  fetch(`/api/admin/orders/${orderId}/refund`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${adminToken}` },
    body: JSON.stringify({ action })
  })
    .then(res => res.json())
    .then(data => {
      if (data.success) { alert(`✅ Refund ${action}d.`); loadOrders(); }
      else { alert('❌ Failed: ' + (data.error || 'Unknown error')); }
    })
    .catch(() => alert('❌ Network error.'));
}

function handleReplacement(orderId, action) {
  if (!confirm(`${action === 'approve' ? 'Approve' : 'Reject'} replacement?`)) return;
  fetch(`/api/admin/orders/${orderId}/replace`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${adminToken}` },
    body: JSON.stringify({ action })
  })
    .then(res => res.json())
    .then(data => {
      if (data.success) { alert(`✅ Replacement ${action}d.`); loadOrders(); }
      else { alert('❌ Failed: ' + (data.error || 'Unknown error')); }
    })
    .catch(() => alert('❌ Network error.'));
}

function remindCustomer(orderId) {
  if (!confirm('Send reminder to customer?')) return;
  fetch(`/api/admin/orders/${orderId}/remind`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${adminToken}` }
  })
    .then(res => res.json())
    .then(data => {
      if (data.success) { alert('✅ Reminder sent.'); loadOrders(); }
      else { alert('❌ Failed: ' + (data.error || 'Unknown error')); }
    })
    .catch(() => alert('❌ Network error.'));
}

function cancelOrder(orderId) {
  const reason = prompt('Cancellation reason:');
  if (!reason) return;
  if (!confirm('Cancel this order?')) return;
  fetch(`/api/admin/orders/${orderId}/cancel`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${adminToken}` },
    body: JSON.stringify({ reason })
  })
    .then(res => res.json())
    .then(data => {
      if (data.success) { alert('✅ Order cancelled.'); loadOrders(); }
      else { alert('❌ Failed: ' + (data.error || 'Unknown error')); }
    })
    .catch(() => alert('❌ Network error.'));
}

function initSocket() {
  socket = io({ auth: { token: adminToken } });
  socket.on('new-order-chat-message', (msg) => {
    const chatBox = document.getElementById(`chatMessages-${msg.order_id}`);
    if (chatBox) {
      const div = document.createElement('div');
      div.className = `chat-msg ${msg.from_user === 'Seller' ? 'seller' : msg.from_user === 'System' ? 'system' : 'customer'}`;
      div.innerHTML = `<strong>${msg.from_user}:</strong> ${msg.message} <span style="float:right; font-size:0.6rem; opacity:0.6;">${new Date(msg.timestamp).toLocaleTimeString()}</span>`;
      chatBox.appendChild(div);
      chatBox.scrollTop = chatBox.scrollHeight;
    }
  });
  socket.on('order-status-updated', () => { loadOrders(); });
  socket.on('new-order', () => { loadOrders(); });
  socket.on('replacement-requested', () => { loadOrders(); });
  socket.on('return-requested', () => { loadOrders(); });
}

document.addEventListener('DOMContentLoaded', () => {
  if (initialStatus) {
    const statusMap = {
      'pending': 'pending',
      'confirmed': 'confirmed',
      'shipped': 'shipped',
      'delivered': 'delivered',
      'received': 'received',
      'cancelled': 'cancelled',
      'replacements': 'replacements',
      'refunds': 'refunds',
      'urgent': 'urgent',
      'returns': 'returns',
      'all': 'all'
    };
    if (statusMap[initialStatus]) {
      document.getElementById('filterStatus').value = statusMap[initialStatus];
    }
  }
  loadOrders();
});

// Expose globals
window.loadOrders = loadOrders;
window.applyFilters = applyFilters;
window.resetFilters = resetFilters;
window.toggleDetails = toggleDetails;
window.togglePayments = togglePayments;
window.sendOrderChat = sendOrderChat;
window.updateOrderStatus = updateOrderStatus;
window.confirmOrder = confirmOrder;
window.markReceived = markReceived;
window.handleRefund = handleRefund;
window.handleReplacement = handleReplacement;
window.remindCustomer = remindCustomer;
window.cancelOrder = cancelOrder;
window.sendOrderConfirmation = sendOrderConfirmation;
window.handleReturn = handleReturn;
window.toggleReturnDetails = toggleReturnDetails;
window.logoutAdmin = logoutAdmin;