// ============================================================
//  ORDER TRACKING JAVASCRIPT
// ============================================================

const token = localStorage.getItem('customerToken');
if (!token) {
  alert('Please login first.');
  window.location.href = '/';
}

const urlParams = new URLSearchParams(window.location.search);
const orderId = urlParams.get('id');
if (!orderId) {
  document.getElementById('trackCard').innerHTML = '<p style="color:#ef4444; text-align:center; padding:20px;">No order ID provided.</p>';
}

let socket = null;
let currentOrder = null;
let selectedPaymentMethod = '';
let paymentAmount = 0;
let pendingPaymentOrderId = null;

// Replacement state
let replacementStep = 1;
let selectedOldIds = [];
let selectedNewIds = [];
let allProductsForReplacement = [];
let replacementDiff = 0;
let replacementOldTotal = 0;
let replacementNewTotal = 0;

// ============================================================
//  LOAD ORDER
// ============================================================
async function loadOrder() {
  try {
    document.getElementById('loadingState').style.display = 'block';
    document.getElementById('orderContent').style.display = 'none';
    
    const res = await fetch(`/api/orders/${orderId}/tracking`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    if (!res.ok) throw new Error('Failed to load order');
    const order = await res.json();
    currentOrder = order;
    
    document.getElementById('loadingState').style.display = 'none';
    document.getElementById('orderContent').style.display = 'block';
    
    renderOrder(order);
    loadChat(order.id);
    
    if (!socket) {
      socket = io({ auth: { token } });
      socket.on('new-order-chat-message', (msg) => {
        if (msg.order_id == order.id) {
          appendChatMessage(msg);
        }
      });
      socket.on('order-status-updated', () => { loadOrder(); });
      socket.on('payment-updated', () => { loadOrder(); });
    }
    socket.emit('join-order-room', order.id);
    
  } catch (err) {
    console.error(err);
    document.getElementById('loadingState').style.display = 'none';
    document.getElementById('orderContent').innerHTML = `<p style="color:#ef4444; text-align:center; padding:20px;">Error loading order: ${err.message}</p>`;
  }
}

// ============================================================
//  RENDER ORDER
// ============================================================
function renderOrder(order) {
  document.getElementById('trackTitle').textContent = 'Order Details';
  document.getElementById('trackRef').textContent = order.order_ref || `#${order.id}`;
  const statusClass = order.status || 'pending';
  document.getElementById('trackStatus').textContent = statusClass.replace('_', ' ').toUpperCase();
  document.getElementById('trackStatus').className = `track-status status-${statusClass}`;
  document.getElementById('trackStatusMessage').textContent = order.statusMessage || '';
  
  if (order.estimated_delivery_days) {
    document.getElementById('trackDeliveryEstimate').textContent = `🚚 Estimated delivery: ${order.estimated_delivery_days} days`;
  }

  // Timeline
  let history = order.status_history || [];
  if (typeof history === 'string') history = JSON.parse(history);
  const statuses = ['pending_payment', 'pending', 'confirmed', 'shipped', 'delivered', 'received', 'cancelled', 'completed'];
  let timelineHtml = '<div class="timeline-large">';
  statuses.forEach(s => {
    const entry = history.find(h => h.status === s);
    const active = order.status === s ? 'active' : '';
    const time = entry ? new Date(entry.timestamp).toLocaleString() : '';
    const icons = {
      'pending_payment': '⏳', 'pending': '🕐', 'confirmed': '✅',
      'shipped': '🚚', 'delivered': '📦', 'received': '✔️',
      'cancelled': '❌', 'completed': '🎉'
    };
    const icon = icons[s] || '•';
    if (entry || order.status === s) {
      timelineHtml += `
        <div class="timeline-item">
          <div class="icon ${active}">${icon}</div>
          <div class="content">
            <div class="status">${s.replace('_', ' ').charAt(0).toUpperCase() + s.replace('_', ' ').slice(1)}</div>
            <div class="time">${time || '—'}</div>
          </div>
        </div>
        <div class="connector"></div>
      `;
    }
  });
  timelineHtml += '</div>';
  document.getElementById('trackTimeline').innerHTML = timelineHtml;

  // Items
  const tbody = document.getElementById('trackItemsBody');
  let total = 0;
  if (order.items && order.items.length > 0) {
    tbody.innerHTML = order.items.map(item => {
      const priceNum = parseFloat(item.price.replace(/[^0-9.]/g, '')) || 0;
      const subtotal = priceNum * item.quantity;
      total += subtotal;
      const variantName = item.variant_name || 'Default';
      const uniqueId = item.unique_id || '—';
      return `
        <tr>
          <td>${item.product_name}</td>
          <td>${variantName}</td>
          <td>${item.quantity}</td>
          <td>${item.price}</td>
          <td>Ksh ${subtotal.toFixed(2)}</td>
          <td style="font-family:monospace; font-size:0.6rem;">${uniqueId}</td>
        </tr>
      `;
    }).join('');
  } else {
    tbody.innerHTML = '<tr><td colspan="6" style="text-align:center; color:#94a3b8;">No items</td></tr>';
  }
  document.getElementById('trackTotal').textContent = `Total: Ksh ${Number(order.total).toFixed(2)}`;

  // Info Grid
  let infoHtml = '';
  infoHtml += `<div class="info-item"><span class="label">📅 Order Date</span><span class="value">${new Date(order.created_at).toLocaleString()}</span></div>`;
  if (order.shipped_at) {
    infoHtml += `<div class="info-item"><span class="label">🚚 Shipped</span><span class="value">${new Date(order.shipped_at).toLocaleString()}</span></div>`;
  }
  if (order.delivered_at) {
    infoHtml += `<div class="info-item"><span class="label">📦 Delivered</span><span class="value">${new Date(order.delivered_at).toLocaleString()}</span></div>`;
  }
  if (order.received_at) {
    infoHtml += `<div class="info-item"><span class="label">✅ Received</span><span class="value">${new Date(order.received_at).toLocaleString()}</span></div>`;
  }
  if (order.tracking_number) {
    infoHtml += `<div class="info-item"><span class="label">📮 Tracking</span><span class="value">${order.tracking_number}</span></div>`;
  }
  if (order.delivery_address) {
    infoHtml += `<div class="info-item"><span class="label">📍 Delivery</span><span class="value">${order.delivery_address}</span></div>`;
  }
  document.getElementById('trackInfo').innerHTML = infoHtml;

  // Replacement/Refund Status
  let statusHtml = '';
  if (order.replacement_status === 'pending') {
    statusHtml = `<div style="background:#fef3c7; padding:8px 12px; border-radius:6px; border-left:4px solid #f59e0b; font-size:0.8rem;">⏳ Replacement request is pending admin approval.</div>`;
  } else if (order.replacement_status === 'approved') {
    statusHtml = `<div style="background:#dcfce7; padding:8px 12px; border-radius:6px; border-left:4px solid #22c55e; font-size:0.8rem;">✅ Replacement approved! Your order will be updated.</div>`;
  } else if (order.replacement_status === 'rejected') {
    statusHtml = `<div style="background:#fee2e2; padding:8px 12px; border-radius:6px; border-left:4px solid #ef4444; font-size:0.8rem;">❌ Replacement request was rejected.</div>`;
  }
  if (order.refund_status === 'pending') {
    statusHtml += `<div style="background:#dbeafe; padding:8px 12px; border-radius:6px; border-left:4px solid #2563eb; font-size:0.8rem; margin-top:4px;">💰 Refund request is pending admin approval.</div>`;
  } else if (order.refund_status === 'approved') {
    statusHtml += `<div style="background:#dcfce7; padding:8px 12px; border-radius:6px; border-left:4px solid #22c55e; font-size:0.8rem; margin-top:4px;">✅ Refund approved!</div>`;
  }
  document.getElementById('replacementStatus').innerHTML = statusHtml;

  renderActions(order);
}

// ============================================================
//  RENDER ACTIONS
// ============================================================
function renderActions(order) {
  const container = document.getElementById('trackActions');
  container.innerHTML = '<div class="action-label">📋 Available Actions</div>';

  const canCancel = ['pending', 'confirmed', 'pending_payment'].includes(order.status);
  const canReorder = order.status !== 'cancelled';
  const canReplace = !['cancelled', 'received', 'completed'].includes(order.status) && 
                     !['pending', 'approved', 'rejected'].includes(order.replacement_status);
  const canReturn = ['delivered', 'received'].includes(order.status);
  const canRefund = (order.refund_status === 'none' || order.refund_status === 'rejected') && 
                    (order.status === 'cancelled' || 
                     (order.replacement_diff < 0 && order.replacement_status === 'approved'));

  // Reorder
  if (canReorder) {
    const btn = document.createElement('button');
    btn.className = 'btn btn-success';
    btn.innerHTML = '<i class="fas fa-redo"></i> Reorder';
    btn.onclick = () => reorderOrder(order.id);
    container.appendChild(btn);
  }

  // Replace
  if (canReplace) {
    const btn = document.createElement('button');
    btn.className = 'btn btn-info';
    btn.innerHTML = '<i class="fas fa-exchange-alt"></i> Replace';
    btn.onclick = () => openReplacementModal();
    container.appendChild(btn);
  }

  // Cancel
  if (canCancel) {
    const btn = document.createElement('button');
    btn.className = 'btn btn-danger';
    btn.innerHTML = '<i class="fas fa-times"></i> Cancel';
    btn.onclick = () => openCancelModal();
    container.appendChild(btn);
  }

  // Return
  if (canReturn) {
    const btn = document.createElement('button');
    btn.className = 'btn btn-warning';
    btn.innerHTML = '<i class="fas fa-undo"></i> Return';
    btn.onclick = () => openReturnModal();
    container.appendChild(btn);
  }

  // Refund
  if (canRefund) {
    const btn = document.createElement('button');
    btn.className = 'btn btn-primary';
    btn.innerHTML = '<i class="fas fa-hand-holding-usd"></i> Request Refund';
    btn.onclick = () => openRefundModal();
    container.appendChild(btn);
  }

  // Replacement payment
  if (order.replacement_status === 'pending_payment' && order.replacement_diff > 0) {
    const btn = document.createElement('button');
    btn.className = 'btn btn-warning';
    btn.innerHTML = '<i class="fas fa-credit-card"></i> Pay Extra Ksh ' + parseFloat(order.replacement_diff).toFixed(2);
    btn.onclick = () => openPaymentModal(order.replacement_diff, order.id);
    container.appendChild(btn);
  }

  // No actions
  if (container.children.length === 1) {
    const msg = document.createElement('span');
    msg.style.cssText = 'font-size:0.8rem; color:#94a3b8; padding:4px 0;';
    msg.textContent = 'No actions available for this order.';
    container.appendChild(msg);
  }

  // Track button
  const trackBtn = document.createElement('button');
  trackBtn.className = 'btn btn-secondary';
  trackBtn.innerHTML = '<i class="fas fa-map"></i> Track';
  trackBtn.onclick = () => window.open(`/track.html`, '_blank');
  container.appendChild(trackBtn);

  // Receipt button
  const receiptBtn = document.createElement('a');
  receiptBtn.className = 'btn btn-secondary';
  receiptBtn.innerHTML = '<i class="fas fa-file-pdf"></i> Receipt';
  receiptBtn.href = `/api/orders/${order.id}/receipt`;
  receiptBtn.target = '_blank';
  container.appendChild(receiptBtn);

  // Back button
  const backBtn = document.createElement('a');
  backBtn.className = 'btn btn-secondary';
  backBtn.innerHTML = '<i class="fas fa-arrow-left"></i> Back';
  backBtn.href = '/account.html';
  container.appendChild(backBtn);
}

// ============================================================
//  CHAT FUNCTIONS
// ============================================================
function loadChat(orderId) {
  const chatBox = document.getElementById('trackChat');
  chatBox.innerHTML = 'Loading...';
  fetch(`/api/orders/${orderId}/chat`, {
    headers: { 'Authorization': `Bearer ${token}` }
  })
  .then(res => res.json())
  .then(messages => {
    chatBox.innerHTML = '';
    if (!messages || messages.length === 0) {
      chatBox.innerHTML = '<div style="color:#94a3b8; text-align:center; padding:8px;">No messages yet.</div>';
      return;
    }
    messages.forEach(msg => appendChatMessage(msg));
  })
  .catch(() => {
    chatBox.innerHTML = '<div style="color:#ef4444; text-align:center; padding:8px;">Error loading messages.</div>';
  });
}

function appendChatMessage(msg) {
  const chatBox = document.getElementById('trackChat');
  const div = document.createElement('div');
  const cls = msg.from_user === 'Seller' ? 'seller' : msg.from_user === 'System' ? 'system' : 'customer';
  div.className = `chat-msg ${cls}`;
  const senderName = msg.from_user === 'Customer' ? 'You' : msg.from_user;
  div.innerHTML = `<span class="sender">${senderName}:</span> ${msg.message} <span class="time">${new Date(msg.timestamp).toLocaleTimeString()}</span>`;
  chatBox.appendChild(div);
  chatBox.scrollTop = chatBox.scrollHeight;
}

function sendTrackChat() {
  const input = document.getElementById('trackChatInput');
  const msg = input.value.trim();
  if (!msg) return;
  fetch(`/api/orders/${orderId}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body: JSON.stringify({ message: msg })
  })
  .then(res => res.json())
  .then(data => {
    if (data.success) {
      input.value = '';
      appendChatMessage({ from_user: 'Customer', message: msg, timestamp: new Date() });
    } else {
      alert('Failed to send message.');
    }
  })
  .catch(() => alert('Network error.'));
}

// ============================================================
//  REORDER
// ============================================================
async function reorderOrder(id) {
  try {
    const res = await fetch(`/api/orders/${id}/reorder`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const data = await res.json();
    if (data.success) {
      localStorage.setItem('cart', JSON.stringify(data.items));
      alert('✅ Items added to cart! Redirecting to cart...');
      window.location.href = '/cart.html';
    } else {
      alert('Failed: ' + (data.error || 'Unknown error'));
    }
  } catch (err) {
    alert('Network error.');
  }
}

// ============================================================
//  REPLACEMENT MODAL
// ============================================================
function openReplacementModal() {
  selectedOldIds = [];
  selectedNewIds = [];
  replacementStep = 1;
  replacementDiff = 0;
  replacementOldTotal = 0;
  replacementNewTotal = 0;
  
  fetch('/api/products')
    .then(res => res.json())
    .then(products => {
      allProductsForReplacement = products;
      document.getElementById('replacementModal').classList.add('active');
      renderReplacementStep();
    })
    .catch(() => {
      alert('Failed to load products. Please try again.');
    });
}

function closeReplacementModal() {
  document.getElementById('replacementModal').classList.remove('active');
}

function renderReplacementStep() {
  const title = document.getElementById('replacementTitle');
  const body = document.getElementById('replacementBody');
  const nextBtn = document.getElementById('replacementNextBtn');

  if (replacementStep === 1) {
    title.textContent = 'Step 1: Select Products to Replace';
    if (!currentOrder || !currentOrder.items || currentOrder.items.length === 0) {
      body.innerHTML = '<p>No items to replace.</p>';
      nextBtn.style.display = 'none';
      return;
    }
    let html = '<p>Select the products you want to replace:</p>';
    currentOrder.items.forEach(item => {
      const checked = selectedOldIds.includes(item.product_id) ? 'checked' : '';
      html += `
        <div class="product-select-item" onclick="toggleOldItem(${item.product_id})">
          <input type="checkbox" id="old_${item.product_id}" value="${item.product_id}" ${checked} onclick="event.stopPropagation(); toggleOldItem(${item.product_id})">
          <div class="info">
            <div class="name">${item.product_name}</div>
            <div class="price">${item.price} × ${item.quantity}</div>
          </div>
        </div>
      `;
    });
    body.innerHTML = html;
    nextBtn.textContent = 'Continue →';
    nextBtn.style.display = 'inline-block';
    nextBtn.onclick = () => {
      if (selectedOldIds.length === 0) {
        alert('Please select at least one product to replace.');
        return;
      }
      replacementStep = 2;
      renderReplacementStep();
    };
  } else if (replacementStep === 2) {
    title.textContent = 'Step 2: Select Replacement Products';
    let html = `
      <input type="text" id="replacementSearch" class="search-box" placeholder="Search products..." oninput="filterReplacementProducts()" style="width:100%; padding:6px 10px; border:1px solid #d1d5db; border-radius:6px; margin-bottom:8px; font-size:0.85rem;">
      <div class="replacement-products-grid" id="replacementProductGrid">
    `;
    allProductsForReplacement.forEach(p => {
      const selected = selectedNewIds.includes(p.id) ? 'selected' : '';
      const img = p.image ? `<img src="${p.image}" alt="${p.name}" onerror="this.style.display='none'">` : '';
      html += `
        <div class="replacement-product-item ${selected}" data-id="${p.id}" onclick="toggleNewProduct(${p.id})">
          ${img}
          <div class="name">${p.name}</div>
          <div class="price">${p.price}</div>
        </div>
      `;
    });
    html += '</div>';
    body.innerHTML = html;
    nextBtn.textContent = 'Review & Calculate';
    nextBtn.onclick = () => {
      if (selectedNewIds.length === 0) {
        alert('Please select at least one replacement product.');
        return;
      }
      replacementStep = 3;
      renderReplacementStep();
    };
  } else if (replacementStep === 3) {
    title.textContent = 'Step 3: Review & Confirm';
    
    const oldItems = currentOrder.items.filter(i => selectedOldIds.includes(i.product_id));
    let oldTotal = 0;
    let oldNames = [];
    oldItems.forEach(item => {
      const priceNum = parseFloat(item.price.replace(/[^0-9.]/g, '')) || 0;
      oldTotal += priceNum * item.quantity;
      oldNames.push(`${item.product_name} x${item.quantity}`);
    });
    
    const newProducts = allProductsForReplacement.filter(p => selectedNewIds.includes(p.id));
    let newTotal = 0;
    let newNames = [];
    newProducts.forEach(p => {
      const priceNum = parseFloat(p.price.replace(/[^0-9.]/g, '')) || 0;
      newTotal += priceNum;
      newNames.push(p.name);
    });
    
    replacementOldTotal = oldTotal;
    replacementNewTotal = newTotal;
    replacementDiff = newTotal - oldTotal;

    let diffHtml = '';
    if (replacementDiff > 0) {
      diffHtml = `<span class="diff-positive">You need to pay Ksh ${replacementDiff.toFixed(2)} extra</span>`;
    } else if (replacementDiff < 0) {
      diffHtml = `<span class="diff-negative">You have a balance of Ksh ${Math.abs(replacementDiff).toFixed(2)}</span>`;
    } else {
      diffHtml = `<span class="diff-zero">Prices are equal. No payment needed.</span>`;
    }

    let html = `
      <div class="replacement-summary">
        <p><strong>Old products:</strong> ${oldNames.join(', ')}</p>
        <p><strong>Old total:</strong> Ksh ${oldTotal.toFixed(2)}</p>
        <p><strong>New products:</strong> ${newNames.join(', ')}</p>
        <p><strong>New total:</strong> Ksh ${newTotal.toFixed(2)}</p>
        <p><strong>Difference:</strong> ${diffHtml}</p>
      </div>
    `;
    
    if (replacementDiff < 0) {
      html += `<p style="font-size:0.8rem; color:#64748b;">You can request a refund for the balance after replacement is approved.</p>`;
    }
    
    body.innerHTML = html;
    nextBtn.textContent = 'Submit Replacement';
    nextBtn.onclick = () => {
      submitReplacementRequest();
    };
  }
}

function toggleOldItem(id) {
  const idx = selectedOldIds.indexOf(id);
  if (idx > -1) selectedOldIds.splice(idx, 1);
  else selectedOldIds.push(id);
  renderReplacementStep();
}

function toggleNewProduct(id) {
  const idx = selectedNewIds.indexOf(id);
  if (idx > -1) selectedNewIds.splice(idx, 1);
  else selectedNewIds.push(id);
  renderReplacementStep();
}

function filterReplacementProducts() {
  const query = document.getElementById('replacementSearch').value.toLowerCase();
  const items = document.querySelectorAll('#replacementProductGrid .replacement-product-item');
  items.forEach(el => {
    const name = el.querySelector('.name').textContent.toLowerCase();
    el.style.display = name.includes(query) ? '' : 'none';
  });
}

function nextReplacementStep() {
  // Handled in renderReplacementStep
}

function submitReplacementRequest() {
  if (selectedOldIds.length === 0 || selectedNewIds.length === 0) return;
  
  fetch(`/api/orders/${orderId}/replace-simple`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body: JSON.stringify({
      oldProductIds: selectedOldIds,
      newProductIds: selectedNewIds
    })
  })
  .then(res => res.json())
  .then(data => {
    if (data.success) {
      if (data.diff > 0) {
        openPaymentModal(data.diff, orderId);
        alert('✅ Replacement request submitted! Please complete payment.');
      } else if (data.diff < 0) {
        alert('✅ Replacement request submitted! You will get a refund of Ksh ' + Math.abs(data.diff).toFixed(2) + ' after approval.');
      } else {
        alert('✅ Replacement request submitted and approved!');
      }
      closeReplacementModal();
      loadOrder();
    } else {
      alert('Failed: ' + (data.error || 'Unknown error'));
    }
  })
  .catch(() => alert('Network error.'));
}

// ============================================================
//  PAYMENT MODAL
// ============================================================
function openPaymentModal(amount, orderId) {
  paymentAmount = amount;
  pendingPaymentOrderId = orderId || orderId;
  document.getElementById('paymentAmount').textContent = `Ksh ${amount.toFixed(2)}`;
  document.getElementById('paymentModal').classList.add('active');
  document.getElementById('paymentDetails').style.display = 'block';
  document.getElementById('phoneField').style.display = 'block';
  document.getElementById('paypalField').style.display = 'none';
  document.getElementById('paymentStatus').className = 'payment-status';
  document.getElementById('paymentStatus').style.display = 'none';
  
  const user = window.currentUser;
  if (user && user.phone) {
    document.getElementById('paymentPhone').value = user.phone;
  }
  
  selectPaymentMethod('mpesa');
}

function closePaymentModal() {
  document.getElementById('paymentModal').classList.remove('active');
}

function selectPaymentMethod(method) {
  selectedPaymentMethod = method;
  document.querySelectorAll('.method').forEach(el => el.classList.remove('selected'));
  const selectedEl = document.querySelector(`.method[onclick="selectPaymentMethod('${method}')"]`);
  if (selectedEl) selectedEl.classList.add('selected');
  
  document.getElementById('paymentDetails').style.display = 'block';
  document.getElementById('phoneField').style.display = method === 'mpesa' || method === 'airtel' ? 'block' : 'none';
  document.getElementById('paypalField').style.display = method === 'paypal' ? 'block' : 'none';
  
  const payBtn = document.getElementById('payNowBtn');
  if (method === 'mpesa') {
    payBtn.textContent = '📱 Pay with M-Pesa';
  } else if (method === 'airtel') {
    payBtn.textContent = '📱 Pay with Airtel Money';
  } else if (method === 'paypal') {
    payBtn.textContent = '💳 Pay with PayPal';
  }
  payBtn.disabled = false;
  document.getElementById('paymentStatus').style.display = 'none';
}

function processPayment() {
  const method = selectedPaymentMethod;
  if (!method) {
    alert('Please select a payment method.');
    return;
  }
  
  const payBtn = document.getElementById('payNowBtn');
  const statusEl = document.getElementById('paymentStatus');
  statusEl.className = 'payment-status loading';
  statusEl.style.display = 'block';
  statusEl.textContent = '⏳ Processing payment...';
  payBtn.disabled = true;

  if (method === 'mpesa') {
    const phone = document.getElementById('paymentPhone').value.trim();
    if (!phone) {
      statusEl.className = 'payment-status error';
      statusEl.textContent = '❌ Please enter your phone number.';
      payBtn.disabled = false;
      return;
    }
    const cleanPhone = phone.replace(/[^0-9]/g, '');
    if (cleanPhone.length < 10) {
      statusEl.className = 'payment-status error';
      statusEl.textContent = '❌ Please enter a valid phone number.';
      payBtn.disabled = false;
      return;
    }
    
    fetch('/api/payments/mpesa/initiate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({
        phone: cleanPhone,
        amount: paymentAmount,
        orderId: pendingPaymentOrderId
      })
    })
    .then(res => res.json())
    .then(data => {
      if (data.success) {
        statusEl.className = 'payment-status success';
        statusEl.textContent = '📱 STK Push sent! Please check your phone and enter PIN.';
        payBtn.disabled = false;
        pollMpesaStatus(data.checkoutRequestId);
      } else {
        statusEl.className = 'payment-status error';
        statusEl.textContent = '❌ ' + data.message;
        payBtn.disabled = false;
      }
    })
    .catch(err => {
      statusEl.className = 'payment-status error';
      statusEl.textContent = '❌ Network error. Please try again.';
      payBtn.disabled = false;
    });
  } else if (method === 'airtel') {
    const phone = document.getElementById('paymentPhone').value.trim();
    if (!phone) {
      statusEl.className = 'payment-status error';
      statusEl.textContent = '❌ Please enter your phone number.';
      payBtn.disabled = false;
      return;
    }
    const cleanPhone = phone.replace(/[^0-9]/g, '');
    if (cleanPhone.length < 10) {
      statusEl.className = 'payment-status error';
      statusEl.textContent = '❌ Please enter a valid phone number.';
      payBtn.disabled = false;
      return;
    }
    
    fetch('/api/payments/airtel/initiate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({
        phone: cleanPhone,
        amount: paymentAmount,
        orderId: pendingPaymentOrderId
      })
    })
    .then(res => res.json())
    .then(data => {
      if (data.success) {
        statusEl.className = 'payment-status success';
        statusEl.textContent = '📱 Airtel Money request sent! Please check your phone.';
        payBtn.disabled = false;
        pollAirtelStatus(data.transactionId);
      } else {
        statusEl.className = 'payment-status error';
        statusEl.textContent = '❌ ' + data.message;
        payBtn.disabled = false;
      }
    })
    .catch(err => {
      statusEl.className = 'payment-status error';
      statusEl.textContent = '❌ Network error. Please try again.';
      payBtn.disabled = false;
    });
  } else if (method === 'paypal') {
    fetch('/api/payments/paypal/create-order', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({
        amount: paymentAmount,
        orderId: pendingPaymentOrderId
      })
    })
    .then(res => res.json())
    .then(data => {
      if (data.success) {
        if (data.isSimulation) {
          statusEl.className = 'payment-status success';
          statusEl.textContent = '✅ PayPal simulation payment successful!';
          payBtn.disabled = false;
          setTimeout(() => {
            closePaymentModal();
            loadOrder();
            alert('✅ Payment successful! Order confirmed.');
          }, 2000);
        } else if (data.approvalUrl) {
          window.location.href = data.approvalUrl;
        }
      } else {
        statusEl.className = 'payment-status error';
        statusEl.textContent = '❌ ' + (data.error || 'Payment failed');
        payBtn.disabled = false;
      }
    })
    .catch(err => {
      statusEl.className = 'payment-status error';
      statusEl.textContent = '❌ Network error. Please try again.';
      payBtn.disabled = false;
    });
  }
}

function pollMpesaStatus(checkoutRequestId) {
  let attempts = 0;
  const maxAttempts = 30;
  const interval = setInterval(() => {
    attempts++;
    fetch(`/api/payments/mpesa/status/${checkoutRequestId}`, {
      headers: { 'Authorization': `Bearer ${token}` }
    })
    .then(res => res.json())
    .then(data => {
      if (data.data && data.data.ResultCode === '0') {
        clearInterval(interval);
        document.getElementById('paymentStatus').className = 'payment-status success';
        document.getElementById('paymentStatus').textContent = '✅ Payment successful!';
        setTimeout(() => {
          closePaymentModal();
          loadOrder();
          alert('✅ Payment successful! Order updated.');
        }, 1500);
      } else if (data.data && data.data.ResultCode !== undefined && data.data.ResultCode !== '1') {
        clearInterval(interval);
        document.getElementById('paymentStatus').className = 'payment-status error';
        document.getElementById('paymentStatus').textContent = '❌ Payment failed: ' + data.data.ResultDesc;
        document.getElementById('payNowBtn').disabled = false;
      }
      if (attempts >= maxAttempts) {
        clearInterval(interval);
        document.getElementById('paymentStatus').className = 'payment-status error';
        document.getElementById('paymentStatus').textContent = '⏳ Payment timeout. Please check your order status.';
        document.getElementById('payNowBtn').disabled = false;
      }
    })
    .catch(() => {
      if (attempts >= maxAttempts) {
        clearInterval(interval);
      }
    });
  }, 4000);
}

function pollAirtelStatus(transactionId) {
  let attempts = 0;
  const maxAttempts = 30;
  const interval = setInterval(() => {
    attempts++;
    fetch(`/api/payments/airtel/status/${transactionId}`, {
      headers: { 'Authorization': `Bearer ${token}` }
    })
    .then(res => res.json())
    .then(data => {
      if (data.data && (data.data.status === 'success' || data.data.status === 'completed')) {
        clearInterval(interval);
        document.getElementById('paymentStatus').className = 'payment-status success';
        document.getElementById('paymentStatus').textContent = '✅ Payment successful!';
        setTimeout(() => {
          closePaymentModal();
          loadOrder();
          alert('✅ Payment successful! Order updated.');
        }, 1500);
      } else if (data.data && data.data.status === 'failed') {
        clearInterval(interval);
        document.getElementById('paymentStatus').className = 'payment-status error';
        document.getElementById('paymentStatus').textContent = '❌ Payment failed.';
        document.getElementById('payNowBtn').disabled = false;
      }
      if (attempts >= maxAttempts) {
        clearInterval(interval);
        document.getElementById('paymentStatus').className = 'payment-status error';
        document.getElementById('paymentStatus').textContent = '⏳ Payment timeout. Please check your order status.';
        document.getElementById('payNowBtn').disabled = false;
      }
    })
    .catch(() => {
      if (attempts >= maxAttempts) {
        clearInterval(interval);
      }
    });
  }, 4000);
}

// ============================================================
//  CANCEL ORDER
// ============================================================
function openCancelModal() {
  document.getElementById('cancelModal').classList.add('active');
}

function closeCancelModal() {
  document.getElementById('cancelModal').classList.remove('active');
}

function submitCancel() {
  const reason = document.getElementById('cancelReason').value;
  if (!reason) {
    alert('Please select a reason.');
    return;
  }
  if (!confirm('Are you sure you want to cancel this order?')) return;
  
  fetch(`/api/orders/${orderId}/cancel`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body: JSON.stringify({ reason })
  })
  .then(res => res.json())
  .then(data => {
    if (data.success) {
      alert('✅ Order cancelled successfully.');
      closeCancelModal();
      loadOrder();
    } else {
      alert('Failed: ' + (data.error || 'Unknown error'));
    }
  })
  .catch(() => alert('Network error.'));
}

// ============================================================
//  REFUND REQUEST
// ============================================================
function openRefundModal() {
  let info = '';
  if (currentOrder.replacement_diff < 0) {
    info = `You have a balance of <strong>Ksh ${Math.abs(currentOrder.replacement_diff).toFixed(2)}</strong> from replacement.`;
  } else if (currentOrder.status === 'cancelled') {
    info = 'You are requesting a refund for a cancelled order.';
  } else {
    info = 'Please explain why you need a refund.';
  }
  document.getElementById('refundInfo').innerHTML = info;
  document.getElementById('refundReason').value = '';
  document.getElementById('refundModal').classList.add('active');
}

function closeRefundModal() {
  document.getElementById('refundModal').classList.remove('active');
}

function submitRefund() {
  const reason = document.getElementById('refundReason').value.trim();
  if (!reason) {
    alert('Please explain why you need a refund.');
    return;
  }
  if (reason.length < 10) {
    alert('Please provide more details (at least 10 characters).');
    return;
  }
  
  fetch(`/api/orders/${orderId}/refund`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body: JSON.stringify({ reason })
  })
  .then(res => res.json())
  .then(data => {
    if (data.success) {
      alert('✅ Refund request submitted. Admin will review it shortly.');
      closeRefundModal();
      loadOrder();
    } else {
      alert('Failed: ' + (data.error || 'Unknown error'));
    }
  })
  .catch(() => alert('Network error.'));
}

// ============================================================
//  RETURN REQUEST
// ============================================================
function openReturnModal() {
  if (!currentOrder || !currentOrder.items) {
    alert('No items to return.');
    return;
  }
  const container = document.getElementById('returnProductsList');
  let html = '';
  currentOrder.items.forEach(item => {
    html += `
      <div class="product-select-item" onclick="selectReturnProduct(${item.product_id})">
        <input type="radio" name="returnProduct" id="return_${item.product_id}" value="${item.product_id}">
        <div class="info">
          <div class="name">${item.product_name}</div>
          <div class="price">${item.price} × ${item.quantity}</div>
        </div>
      </div>
    `;
  });
  container.innerHTML = html;
  document.getElementById('returnReason').value = '';
  document.getElementById('returnModal').classList.add('active');
}

function closeReturnModal() {
  document.getElementById('returnModal').classList.remove('active');
}

function selectReturnProduct(productId) {
  const radios = document.querySelectorAll('input[name="returnProduct"]');
  radios.forEach(r => {
    if (parseInt(r.value) === productId) r.checked = true;
    else r.checked = false;
  });
}

function submitReturn() {
  const selected = document.querySelector('input[name="returnProduct"]:checked');
  if (!selected) {
    alert('Please select a product to return.');
    return;
  }
  const productId = parseInt(selected.value);
  const reason = document.getElementById('returnReason').value.trim();
  if (!reason) {
    alert('Please explain why you are returning this item.');
    return;
  }
  if (reason.length < 10) {
    alert('Please provide more details (at least 10 characters).');
    return;
  }
  
  fetch(`/api/orders/${orderId}/return`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body: JSON.stringify({ product_id: productId, reason })
  })
  .then(res => res.json())
  .then(data => {
    if (data.success) {
      alert('✅ Return request submitted. Admin will review it shortly.');
      closeReturnModal();
      loadOrder();
    } else {
      alert('Failed: ' + (data.error || 'Unknown error'));
    }
  })
  .catch(() => alert('Network error.'));
}

// ============================================================
//  LOGOUT
// ============================================================
function logout() {
  localStorage.removeItem('customerToken');
  localStorage.removeItem('currentUser');
  window.location.href = '/';
}

// ============================================================
//  LOAD SHOP NAME
// ============================================================
async function loadShopName() {
  try {
    const res = await fetch('/api/shop');
    const shop = await res.json();
    const el = document.getElementById('shopNameHeader');
    if (el) el.textContent = shop.name || 'Our Business';
  } catch (err) {}
}

// ============================================================
//  INIT
// ============================================================
document.addEventListener('DOMContentLoaded', () => {
  loadShopName();
  loadOrder();
});

// Expose functions globally
window.loadOrder = loadOrder;
window.sendTrackChat = sendTrackChat;
window.openReplacementModal = openReplacementModal;
window.closeReplacementModal = closeReplacementModal;
window.nextReplacementStep = nextReplacementStep;
window.toggleOldItem = toggleOldItem;
window.toggleNewProduct = toggleNewProduct;
window.filterReplacementProducts = filterReplacementProducts;
window.openPaymentModal = openPaymentModal;
window.closePaymentModal = closePaymentModal;
window.selectPaymentMethod = selectPaymentMethod;
window.processPayment = processPayment;
window.openCancelModal = openCancelModal;
window.closeCancelModal = closeCancelModal;
window.submitCancel = submitCancel;
window.openRefundModal = openRefundModal;
window.closeRefundModal = closeRefundModal;
window.submitRefund = submitRefund;
window.openReturnModal = openReturnModal;
window.closeReturnModal = closeReturnModal;
window.selectReturnProduct = selectReturnProduct;
window.submitReturn = submitReturn;
window.reorderOrder = reorderOrder;
window.logout = logout;