// ============================================================
//  ACCOUNT PAGE JAVASCRIPT - COMPACT STATS
//  Location: D:\my-business-website\public\js\account.js
// ============================================================

const token = window.customerToken;
if (!token) {
  alert('Please login first.');
  window.location.href = '/';
}

let socket = null;
let allOrders = [];
let currentFilterStatus = null;
let returnsMap = {};
let expandedOrderId = null;
let currentSection = 'dashboard';

// ============================================================
//  SIDEBAR FUNCTIONS
// ============================================================
function toggleSidebar() {
    const sidebar = document.getElementById('sidebar');
    const overlay = document.getElementById('sidebarOverlay');
    sidebar.classList.toggle('open');
    overlay.classList.toggle('active');
}

function closeSidebar() {
    const sidebar = document.getElementById('sidebar');
    const overlay = document.getElementById('sidebarOverlay');
    sidebar.classList.remove('open');
    overlay.classList.remove('active');
}

function navigateTo(section) {
    document.querySelectorAll('.section').forEach(el => el.classList.remove('active'));
    const target = document.getElementById(`section-${section}`);
    if (target) target.classList.add('active');
    
    document.querySelectorAll('.menu-item').forEach(el => el.classList.remove('active'));
    const menuItem = document.querySelector(`.menu-item[data-section="${section}"]`);
    if (menuItem) menuItem.classList.add('active');
    
    currentSection = section;
    closeSidebar();
    
    switch(section) {
        case 'dashboard': loadCustomerDashboard(); break;
        case 'orders': loadOrdersTable(); break;
        case 'profile': loadProfile(); break;
        case 'addresses': loadAddresses(); break;
        case 'payments': loadPaymentHistory(); break;
    }
}

// ============================================================
//  INIT
// ============================================================
function initSocket() {
    if (socket) return;
    socket = io({ auth: { token } });
    socket.on('new-order-chat-message', (msg) => {
        loadCustomerDashboard();
        if (expandedOrderId) {
            loadOrderChat(expandedOrderId);
        }
    });
    socket.on('order-status-updated', () => { loadCustomerDashboard(); });
    socket.on('payment-updated', () => { loadCustomerDashboard(); });
    socket.on('replacement-requested', () => { loadCustomerDashboard(); });
    socket.on('return-requested', () => { loadCustomerDashboard(); });
}

// ============================================================
//  LOAD DASHBOARD
// ============================================================
function loadCustomerDashboard() {
    const user = window.currentUser || JSON.parse(localStorage.getItem('currentUser') || '{}');
    if (user.name) {
        document.getElementById('accountName').textContent = user.name;
        document.getElementById('accountEmail').textContent = user.email;
        document.getElementById('avatarInitial').textContent = user.name.charAt(0).toUpperCase();
        if (user.createdAt) {
            const date = new Date(user.createdAt);
            if (!isNaN(date.getTime())) {
                document.getElementById('memberSince').textContent = `Member since: ${date.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}`;
            } else {
                document.getElementById('memberSince').textContent = 'Member since: Recent';
            }
        } else {
            document.getElementById('memberSince').textContent = 'Member since: Recent';
        }
    }

    fetch('/api/orders', { 
        headers: { 'Authorization': `Bearer ${token}` } 
    })
    .then(res => {
        if (res.status === 429) {
            return new Promise(resolve => {
                setTimeout(() => {
                    resolve(fetch('/api/orders', { headers: { 'Authorization': `Bearer ${token}` } }));
                }, 3000);
            });
        }
        return res;
    })
    .then(res => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
    })
    .then(orders => {
        if (!Array.isArray(orders)) {
            orders = [];
        }
        allOrders = orders;
        
        return fetch('/api/returns/customer', { headers: { 'Authorization': `Bearer ${token}` } })
            .then(res => {
                if (res.status === 429) return [];
                return res.json();
            })
            .catch(() => [])
            .then(returns => {
                returnsMap = {};
                (returns || []).forEach(r => { returnsMap[r.order_id] = r; });
                renderCustomerStats(orders);
                renderRecentOrders(orders);
                updateOrderBadge(orders);
                updateCartBadges();
            });
    })
    .catch(err => {
        console.error('Error loading orders:', err);
        document.getElementById('recentOrdersContainer').innerHTML = '<p class="empty-msg">Error loading orders. Please refresh the page.</p>';
        document.getElementById('customerStatsGrid').innerHTML = '<p class="empty-msg">Unable to load order statistics.</p>';
    });
}

// ============================================================
//  RENDER CUSTOMER STATS - COMPACT VERSION
// ============================================================
function renderCustomerStats(orders) {
    const grid = document.getElementById('customerStatsGrid');
    
    if (!Array.isArray(orders)) {
        grid.innerHTML = '<p class="empty-msg">No orders to display.</p>';
        return;
    }
    
    const statuses = ['pending_payment', 'pending', 'confirmed', 'shipped', 'delivered', 'received', 'cancelled'];
    const counts = {};
    statuses.forEach(s => counts[s] = 0);
    
    orders.forEach(o => {
        if (counts[o.status] !== undefined) counts[o.status]++;
    });

    const items = [
        { key: 'pending_payment', label: 'Awaiting Payment', icon: 'fa-clock', color: '#f97316' },
        { key: 'pending', label: 'Pending', icon: 'fa-clock', color: '#f59e0b' },
        { key: 'confirmed', label: 'Confirmed', icon: 'fa-check-circle', color: '#22c55e' },
        { key: 'shipped', label: 'Shipped', icon: 'fa-truck', color: '#3b82f6' },
        { key: 'delivered', label: 'Awaiting Pickup', icon: 'fa-box-open', color: '#8b5cf6' },
        { key: 'received', label: 'Received', icon: 'fa-check-double', color: '#14b8a6' },
        { key: 'cancelled', label: 'Cancelled', icon: 'fa-times-circle', color: '#ef4444' }
    ];

    let html = '<div class="compact-stats-grid">';
    items.forEach(item => {
        const count = counts[item.key] || 0;
        const isPending = ['pending_payment', 'pending', 'delivered'].includes(item.key);
        const blink = (count > 0 && isPending) ? '<span class="blink-dot"></span>' : '';
        const active = (currentFilterStatus === item.key) ? 'active' : '';
        html += `<div class="compact-stat-item ${active}" data-status="${item.key}" onclick="filterOrdersByStatus('${item.key}')">`;
        html += `<div class="compact-stat-icon" style="color:${item.color};"><i class="fas ${item.icon}"></i></div>`;
        html += `<div class="compact-stat-content">`;
        html += `<span class="compact-stat-value">${count}</span>`;
        html += `<span class="compact-stat-label">${item.label} ${blink}</span>`;
        html += `</div></div>`;
    });
    html += '</div>';

    grid.innerHTML = html;
}

function renderRecentOrders(orders) {
    const container = document.getElementById('recentOrdersContainer');
    if (!orders || !Array.isArray(orders) || orders.length === 0) {
        container.innerHTML = '<p class="empty-msg">No recent orders.</p>';
        return;
    }
    const recent = orders.slice(0, 5);
    container.innerHTML = recent.map(order => `
        <div style="display:flex; justify-content:space-between; padding:8px 0; border-bottom:1px solid #f1f4f8; font-size:0.9rem; flex-wrap:wrap; gap:6px;">
            <span style="font-weight:600;">${order.order_ref || `#${order.id}`}</span>
            <span>${new Date(order.created_at).toLocaleDateString()}</span>
            <span class="status-badge status-${order.status}">${order.status}</span>
            <span style="font-weight:700; color:#2563eb;">Ksh ${parseFloat(order.total).toFixed(2)}</span>
            <button class="btn-details" onclick="navigateTo('orders')">View All</button>
        </div>
    `).join('');
}

function updateOrderBadge(orders) {
    const badge = document.querySelector('.menu-item[data-section="orders"] .badge');
    if (badge) badge.textContent = orders && Array.isArray(orders) ? orders.length : 0;
}

function updateCartBadges() {
    const cart = getCart();
    const count = cart.reduce((sum, item) => sum + item.quantity, 0);
    document.querySelectorAll('#cartBadge, #navCartBadge, #sidebarCartBadge').forEach(badge => {
        if (badge) {
            if (count > 0) { badge.textContent = count; badge.style.display = 'inline'; } 
            else { badge.style.display = 'none'; }
        }
    });
}

function filterOrdersByStatus(status) {
    currentFilterStatus = status;
    document.querySelectorAll('#customerStatsGrid .compact-stat-item').forEach(card => {
        card.classList.toggle('active', card.dataset.status === status);
    });
    if (currentSection === 'dashboard') {
        renderCustomerStats(allOrders);
    } else if (currentSection === 'orders') {
        loadOrdersTable();
    }
}

// ============================================================
//  ORDERS TABLE (unchanged, kept for brevity)
// ============================================================

function loadOrdersTable() {
    const container = document.getElementById('ordersContainer');
    
    if (!Array.isArray(allOrders)) {
        container.innerHTML = '<p class="empty-msg">No orders to show.</p>';
        return;
    }
    
    if (allOrders.length === 0) {
        container.innerHTML = '<p class="empty-msg">No orders to show.</p>';
        return;
    }
    
    let filtered = allOrders;
    if (currentFilterStatus && currentFilterStatus !== 'all') {
        filtered = allOrders.filter(o => o.status === currentFilterStatus);
    }
    
    if (!Array.isArray(filtered)) {
        container.innerHTML = '<p class="empty-msg">No orders to show.</p>';
        return;
    }
    
    filtered.sort((a,b) => new Date(b.created_at) - new Date(a.created_at));

    let html = `
        <div class="order-table-wrapper">
            <table class="order-table">
                <thead>
                    <tr>
                        <th>Order Ref</th>
                        <th>Date</th>
                        <th>Status</th>
                        <th>Total</th>
                        <th style="text-align:center;">Actions</th>
                    </tr>
                </thead>
                <tbody>
    `;

    filtered.forEach(order => {
        const displayRef = order.order_ref || `#${order.id}`;
        const date = new Date(order.created_at).toLocaleDateString();
        const total = parseFloat(order.total).toFixed(2);
        const statusClass = order.status;
        const isExpanded = expandedOrderId === order.id;

        html += `
            <tr>
                <td><span class="order-ref">${displayRef}</span></td>
                <td><span class="order-date">${date}</span></td>
                <td><span class="status-badge status-${statusClass}">${order.status.replace('_', ' ').toUpperCase()}</span></td>
                <td><span class="order-total">Ksh ${total}</span></td>
                <td style="text-align:center;">
                    <button class="btn-details" onclick="toggleOrderDetails(${order.id})">
                        ${isExpanded ? 'Hide' : 'Details'}
                    </button>
                    <button class="btn-track" onclick="window.location.href='/order-tracking.html?id=${order.id}'">
                        <i class="fas fa-map"></i> Track
                    </button>
                </td>
            </tr>
            <tr class="order-detail-row ${isExpanded ? 'active' : ''}" id="detail-row-${order.id}">
                <td colspan="5">
                    <div class="order-detail-content">
                        ${buildOrderDetail(order)}
                    </div>
                </td>
            </tr>
        `;
    });

    html += `</tbody></table></div>`;
    container.innerHTML = html;

    if (expandedOrderId) {
        loadOrderChat(expandedOrderId);
        if (socket) socket.emit('join-order-room', expandedOrderId);
    }
}

function buildOrderDetail(order) {
    let history = order.status_history || [];
    if (typeof history === 'string') history = JSON.parse(history);

    const statusesList = ['pending_payment', 'pending', 'confirmed', 'shipped', 'delivered', 'received', 'cancelled'];
    let timelineHtml = '<div class="timeline">';
    statusesList.forEach(s => {
        const entry = history.find(h => h.status === s);
        const active = order.status === s ? 'active' : '';
        const time = entry ? new Date(entry.timestamp).toLocaleString() : '';
        const icon = s === 'pending_payment' ? '⏳' : s === 'pending' ? '🕐' : s === 'confirmed' ? '✅' : s === 'shipped' ? '🚚' : s === 'delivered' ? '📦' : s === 'received' ? '✔️' : '❌';
        if (entry || order.status === s) {
            timelineHtml += `<div class="step ${active}"><i>${icon}</i> ${s.replace('_', ' ').charAt(0).toUpperCase()+s.replace('_', ' ').slice(1)} ${time ? `<span class="time">${time}</span>` : ''}</div>`;
        }
    });
    timelineHtml += '</div>';

    let statusMessage = '';
    switch (order.status) {
        case 'pending_payment': statusMessage = 'Awaiting payment confirmation.'; break;
        case 'pending': statusMessage = 'Your order is being reviewed.'; break;
        case 'confirmed': statusMessage = 'Your order is confirmed and being prepared.'; break;
        case 'shipped': statusMessage = 'Your order is on the way.'; break;
        case 'delivered': statusMessage = 'Your order is ready for pickup.'; break;
        case 'received': statusMessage = 'You have confirmed receipt.'; break;
        case 'cancelled': statusMessage = 'This order has been cancelled.'; break;
        default: statusMessage = '';
    }

    let itemsHtml = '';
    if (order.items && order.items.length > 0) {
        itemsHtml = `
            <table class="items-table">
                <thead><tr><th>Product</th><th>Variant</th><th>Qty</th><th>Price</th><th>Subtotal</th><th>ID</th></tr></thead>
                <tbody>
        `;
        order.items.forEach(item => {
            const priceNum = parseFloat(item.price.replace(/[^0-9.]/g, '')) || 0;
            const subtotal = priceNum * item.quantity;
            const uniqueId = item.unique_id || '—';
            const variantName = item.variant_name || 'Default';
            itemsHtml += `
                <tr>
                    <td>${item.product_name}</td>
                    <td>${variantName}</td>
                    <td>${item.quantity}</td>
                    <td>${item.price}</td>
                    <td style="font-weight:700; color:#2563eb;">Ksh ${subtotal.toFixed(2)}</td>
                    <td style="font-family:monospace; font-size:0.7rem;">${uniqueId}</td>
                </tr>
            `;
        });
        itemsHtml += `</tbody></table>`;
    } else {
        itemsHtml = '<p style="font-size:0.9rem; color:#94a3b8;">No items</p>';
    }

    let extraInfo = '';
    if (returnsMap[order.id]) {
        extraInfo += `<div style="font-size:0.85rem; color:#f59e0b;">📦 Return: ${returnsMap[order.id].status.toUpperCase()}</div>`;
    }
    if (order.replacement_status && order.replacement_status !== 'none' && order.replacement_status !== 'approved' && order.replacement_status !== 'rejected') {
        extraInfo += `<span style="background:#fef3c7; padding:2px 10px; border-radius:20px; font-size:0.7rem; display:inline-block; margin-right:4px;">🔄 Replacement ${order.replacement_status}</span>`;
    }
    if (order.refund_status && order.refund_status === 'pending') {
        extraInfo += `<span style="background:#dbeafe; padding:2px 10px; border-radius:20px; font-size:0.7rem; display:inline-block;">💰 Refund Pending</span>`;
    }

    let actionsHtml = `
        <div class="action-buttons">
            <a href="/order-tracking.html?id=${order.id}" class="btn btn-primary btn-sm"><i class="fas fa-search"></i> Track</a>
            <button class="btn btn-success btn-sm" onclick="reorderOrder(${order.id})"><i class="fas fa-redo"></i> Reorder</button>
    `;
    if (['pending_payment', 'pending', 'confirmed'].includes(order.status)) {
        actionsHtml += `<button class="btn btn-danger btn-sm" onclick="cancelOrder(${order.id})"><i class="fas fa-times"></i> Cancel</button>`;
    }
    if (order.status === 'delivered') {
        actionsHtml += `<button class="btn btn-success btn-sm" onclick="markReceived(${order.id})">✅ Confirm Receive</button>`;
    }
    if (['delivered', 'received'].includes(order.status)) {
        actionsHtml += `<button class="btn btn-warning btn-sm" onclick="requestReturn(${order.id})">📦 Return</button>`;
    }
    actionsHtml += `</div>`;

    const chatId = `detail-chat-${order.id}`;
    const chatInputId = `detail-chat-input-${order.id}`;

    let deliveryHtml = '';
    if (order.delivery_address) {
        deliveryHtml = `
            <div class="detail-item">
                <span class="label">📍 Delivery</span>
                <span class="value">${order.delivery_address}</span>
                ${order.delivery_instructions ? `<br><span style="font-size:0.8rem; color:#64748b;">📝 ${order.delivery_instructions}</span>` : ''}
                ${order.recipient_name ? `<br>👤 ${order.recipient_name} (${order.recipient_phone || 'N/A'})` : ''}
            </div>
        `;
    }

    return `
        <div class="detail-grid">
            <div class="detail-item">
                <span class="label">📋 Status</span>
                <span class="value" style="font-size:0.95rem;">${statusMessage}</span>
                ${extraInfo}
            </div>
            ${deliveryHtml}
            <div class="detail-item">
                <span class="label">📅 Order Date</span>
                <span class="value">${new Date(order.created_at).toLocaleString()}</span>
                ${order.shipped_at ? `<br><span class="label">🚚 Shipped</span><span class="value">${new Date(order.shipped_at).toLocaleString()}</span>` : ''}
                ${order.delivered_at ? `<br><span class="label">📦 Delivered</span><span class="value">${new Date(order.delivered_at).toLocaleString()}</span>` : ''}
                ${order.tracking_number ? `<br><span class="label">📮 Tracking</span><span class="value">${order.tracking_number}</span>` : ''}
            </div>
            <div class="detail-item">
                <span class="label">💰 Total</span>
                <span class="value" style="font-size:1.3rem; font-weight:800; color:#2563eb;">Ksh ${parseFloat(order.total).toFixed(2)}</span>
                ${order.shipping_cost > 0 ? `<br><span class="label">🚚 Shipping</span><span class="value">Ksh ${parseFloat(order.shipping_cost).toFixed(2)}</span>` : ''}
                ${order.discount_applied > 0 ? `<br><span class="label">🎁 Discount</span><span class="value">-Ksh ${parseFloat(order.discount_applied).toFixed(2)}</span>` : ''}
            </div>
        </div>

        ${timelineHtml}

        <div style="margin: 8px 0; font-size:0.95rem; font-weight:700;">📦 Order Items</div>
        ${itemsHtml}

        ${actionsHtml}

        <div class="chat-container">
            <div class="chat-header">
                <i class="fas fa-comment"></i> Order Chat
            </div>
            <div class="chat-box" id="${chatId}">
                <div style="text-align:center; color:#94a3b8; padding:20px 0; font-size:0.85rem;">Loading messages...</div>
            </div>
            <div class="chat-input-row">
                <input type="text" id="${chatInputId}" placeholder="Type a message...">
                <button onclick="sendOrderChat(${order.id}, '${chatInputId}', '${chatId}')">Send</button>
            </div>
        </div>
    `;
}

function toggleOrderDetails(orderId) {
    if (expandedOrderId === orderId) {
        expandedOrderId = null;
        if (socket) socket.emit('leave-order-room', orderId);
    } else {
        expandedOrderId = orderId;
        if (socket) socket.emit('join-order-room', orderId);
    }
    loadOrdersTable();
}

function loadOrderChat(orderId) {
    const chatBox = document.getElementById(`detail-chat-${orderId}`);
    if (!chatBox) return;
    chatBox.innerHTML = '<div style="text-align:center; color:#94a3b8; padding:20px 0; font-size:0.85rem;">Loading messages...</div>';
    fetch(`/api/orders/${orderId}/chat`, {
        headers: { 'Authorization': `Bearer ${token}` }
    })
    .then(res => res.json())
    .then(messages => {
        chatBox.innerHTML = '';
        if (!messages || messages.length === 0) {
            chatBox.innerHTML = '<div style="text-align:center; color:#94a3b8; padding:20px 0; font-size:0.85rem;">No messages yet. Start the conversation!</div>';
            return;
        }
        messages.forEach(msg => {
            const div = document.createElement('div');
            let cls = '';
            let displayName = '';
            
            if (msg.from_user === 'Customer') {
                cls = 'customer';
                displayName = 'You';
            } else if (msg.from_user === 'Seller') {
                cls = 'seller';
                displayName = 'Seller';
            } else {
                cls = 'system';
                displayName = 'System';
            }
            
            div.className = `chat-msg ${cls}`;
            const time = new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            const formattedMessage = msg.message.replace(/\n/g, '<br>');
            
            div.innerHTML = `
                <span class="msg-sender">${displayName}</span>
                <span class="msg-text">${formattedMessage}</span>
                <span class="msg-time">${time}</span>
            `;
            chatBox.appendChild(div);
        });
        chatBox.scrollTop = chatBox.scrollHeight;
    })
    .catch(() => {
        chatBox.innerHTML = '<div style="text-align:center; color:#ef4444; padding:20px 0; font-size:0.85rem;">Error loading messages.</div>';
    });
}

function sendOrderChat(orderId, inputId, chatId) {
    const input = document.getElementById(inputId);
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
            const chatBox = document.getElementById(chatId);
            const div = document.createElement('div');
            div.className = 'chat-msg customer';
            const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            div.innerHTML = `
                <span class="msg-sender">You</span>
                <span class="msg-text">${msg}</span>
                <span class="msg-time">${time}</span>
            `;
            chatBox.appendChild(div);
            chatBox.scrollTop = chatBox.scrollHeight;
        } else {
            alert('Failed to send message.');
        }
    })
    .catch(() => alert('Network error.'));
}

// ============================================================
//  ORDER ACTIONS (unchanged)
// ============================================================

async function cancelOrder(id) {
    const reason = prompt('Please provide a reason for cancellation:');
    if (!reason) return;
    if (!confirm('Cancel this order?')) return;
    try {
        const res = await fetch(`/api/orders/${id}/cancel`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
            body: JSON.stringify({ reason })
        });
        const data = await res.json();
        if (data.success) {
            alert('Order cancelled.');
            loadCustomerDashboard();
        } else {
            alert('Failed: ' + (data.error || 'Unknown error'));
        }
    } catch (err) {
        alert('Network error.');
    }
}
window.cancelOrder = cancelOrder;

async function reorderOrder(id) {
    try {
        const res = await fetch(`/api/orders/${id}/reorder`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const data = await res.json();
        if (data.success) {
            localStorage.setItem('cart', JSON.stringify(data.items));
            alert('Items added to cart! Redirecting...');
            window.location.href = '/cart.html';
        } else {
            alert('Failed: ' + (data.error || 'Unknown error'));
        }
    } catch (err) {
        alert('Network error.');
    }
}
window.reorderOrder = reorderOrder;

async function markReceived(id) {
    if (!confirm('Have you received all items in good condition?')) return;
    try {
        const res = await fetch(`/api/orders/${id}/receive`, {
            method: 'PUT',
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const data = await res.json();
        if (data.success) {
            alert('Order marked as received!');
            loadCustomerDashboard();
        } else {
            alert('Failed: ' + (data.error || 'Unknown error'));
        }
    } catch (err) {
        alert('Network error.');
    }
}
window.markReceived = markReceived;

async function requestReturn(id) {
    const productId = prompt('Enter the product ID to return:');
    if (!productId) return;
    const reason = prompt('Reason for return:');
    if (!reason) return;
    try {
        const res = await fetch(`/api/orders/${id}/return`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
            body: JSON.stringify({ product_id: parseInt(productId), reason })
        });
        const data = await res.json();
        if (data.success) {
            alert('Return request submitted.');
            loadCustomerDashboard();
        } else {
            alert('Failed: ' + (data.error || 'Unknown error'));
        }
    } catch (err) {
        alert('Network error.');
    }
}
window.requestReturn = requestReturn;

// ============================================================
//  PROFILE (unchanged)
// ============================================================

function loadProfile() {
    const user = window.currentUser || JSON.parse(localStorage.getItem('currentUser') || '{}');
    if (user.name) {
        document.getElementById('profileName').value = user.name || '';
        document.getElementById('profileEmail').value = user.email || '';
        document.getElementById('profilePhone').value = user.phone || '';
    }
}

function updateProfile() {
    const name = document.getElementById('profileName').value.trim();
    const email = document.getElementById('profileEmail').value.trim();
    const phone = document.getElementById('profilePhone').value.trim();
    const status = document.getElementById('profileStatus');
    if (!name || !email || !phone) {
        status.textContent = '❌ All fields are required.';
        status.style.color = '#ef4444';
        return;
    }
    fetch('/api/auth/customer/profile', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ name, email, phone })
    })
    .then(res => res.json())
    .then(data => {
        if (data.user) {
            localStorage.setItem('currentUser', JSON.stringify(data.user));
            window.currentUser = data.user;
            status.textContent = '✅ Profile updated successfully!';
            status.style.color = '#16a34a';
            loadCustomerDashboard();
        } else {
            status.textContent = '❌ Failed to update profile.';
            status.style.color = '#ef4444';
        }
    })
    .catch(() => {
        status.textContent = '❌ Network error.';
        status.style.color = '#ef4444';
    });
}

// ============================================================
//  ADDRESSES (unchanged)
// ============================================================

function loadAddresses() {
    const container = document.getElementById('addressBookContainer');
    fetch('/api/addresses', { headers: { 'Authorization': `Bearer ${token}` } })
        .then(res => res.json())
        .then(addresses => {
            if (!addresses || addresses.length === 0) {
                container.innerHTML = '<p class="empty-msg">No saved addresses.</p>';
                return;
            }
            container.innerHTML = addresses.map(addr => `
                <div class="address-item">
                    <div>
                        <span class="label">${addr.label}</span>
                        ${addr.is_default ? ' <span style="font-size:0.65rem; background:#2563eb; color:white; padding:0 10px; border-radius:20px;">Default</span>' : ''}
                        ${addr.location_name ? `<span class="location-name">📍 ${addr.location_name}</span>` : ''}
                        <br><span class="address-text">${addr.address}</span>
                    </div>
                    <div class="actions">
                        ${!addr.is_default ? `<button class="btn btn-primary btn-sm" onclick="setDefaultAddress(${addr.id})">Default</button>` : ''}
                        <button class="btn btn-danger btn-sm" onclick="deleteAddress(${addr.id})"><i class="fas fa-trash"></i></button>
                    </div>
                </div>
            `).join('');
        })
        .catch(() => { container.innerHTML = '<p class="empty-msg">Error loading addresses.</p>'; });
}

function showAddAddress() {
    document.getElementById('addressModal').classList.add('active');
    document.getElementById('addressInput').value = '';
    document.getElementById('addressLat').value = '';
    document.getElementById('addressLng').value = '';
    document.getElementById('addressLocationName').value = '';
    document.getElementById('addressSuggestions').style.display = 'none';
}
function closeAddressModal() { document.getElementById('addressModal').classList.remove('active'); }

document.getElementById('addressInput')?.addEventListener('input', function() {
    const query = this.value.trim();
    const suggestionsDiv = document.getElementById('addressSuggestions');
    if (query.length < 3) { suggestionsDiv.style.display = 'none'; return; }
    fetch(`https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=5`)
        .then(res => res.json())
        .then(data => {
            if (!data.length) { suggestionsDiv.style.display = 'none'; return; }
            suggestionsDiv.style.display = 'block';
            suggestionsDiv.innerHTML = data.map(item => `
                <div onclick="selectAddressSuggestion('${item.display_name.replace(/'/g, "\\'")}', '${item.lat}', '${item.lon}')">
                    ${item.display_name}
                </div>
            `).join('');
        })
        .catch(() => { suggestionsDiv.style.display = 'none'; });
});

function selectAddressSuggestion(address, lat, lng) {
    document.getElementById('addressInput').value = address;
    document.getElementById('addressLat').value = lat;
    document.getElementById('addressLng').value = lng;
    document.getElementById('addressLocationName').value = address;
    document.getElementById('addressSuggestions').style.display = 'none';
}

function saveAddress() {
    const label = document.getElementById('addressLabel').value;
    const address = document.getElementById('addressInput').value.trim();
    const lat = document.getElementById('addressLat').value.trim();
    const lng = document.getElementById('addressLng').value.trim();
    const location_name = document.getElementById('addressLocationName').value.trim() || address;
    if (!address) { alert('Please enter an address.'); return; }
    fetch('/api/addresses', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ label, address, lat, lng, location_name })
    })
    .then(res => res.json())
    .then(data => {
        if (data.success) {
            alert('Address saved!');
            closeAddressModal();
            loadAddresses();
        } else {
            alert('Failed to save address.');
        }
    })
    .catch(() => alert('Network error.'));
}

function setDefaultAddress(id) {
    fetch(`/api/addresses/${id}/default`, {
        method: 'PUT',
        headers: { 'Authorization': `Bearer ${token}` }
    })
    .then(res => res.json())
    .then(data => {
        if (data.success) { loadAddresses(); }
        else { alert('Failed to set default.'); }
    })
    .catch(() => alert('Network error.'));
}

function deleteAddress(id) {
    if (!confirm('Delete this address?')) return;
    fetch(`/api/addresses/${id}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${token}` }
    })
    .then(res => res.json())
    .then(data => {
        if (data.success) { loadAddresses(); }
        else { alert('Failed to delete address.'); }
    })
    .catch(() => alert('Network error.'));
}

// ============================================================
//  PAYMENT HISTORY (unchanged)
// ============================================================

function loadPaymentHistory() {
    const tbody = document.getElementById('paymentHistoryBody');
    if (!tbody) return;
    
    tbody.innerHTML = '<tr><td colspan="5" style="text-align:center; padding:20px; color:#94a3b8;">Loading payments...</td></tr>';
    
    fetch('/api/payments/customer', { 
        headers: { 'Authorization': `Bearer ${token}` } 
    })
    .then(res => {
        if (!res.ok) throw new Error('Failed to fetch payments');
        return res.json();
    })
    .then(payments => {
        if (!payments || payments.length === 0) {
            tbody.innerHTML = '<tr><td colspan="5" style="text-align:center; padding:20px; color:#94a3b8;">No payment history found.</td></tr>';
            return;
        }
        
        payments.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
        
        let html = '';
        payments.forEach(p => {
            let icon = 'fa-credit-card';
            let iconClass = 'bank';
            let methodName = p.method.toUpperCase();
            
            switch(p.method) {
                case 'mpesa':
                    icon = 'fa-mobile-alt';
                    iconClass = 'mpesa';
                    methodName = 'M-Pesa';
                    break;
                case 'airtel':
                    icon = 'fa-phone';
                    iconClass = 'airtel';
                    methodName = 'Airtel Money';
                    break;
                case 'paypal':
                    icon = 'fa-paypal';
                    iconClass = 'paypal';
                    methodName = 'PayPal';
                    break;
                case 'bank':
                    icon = 'fa-university';
                    iconClass = 'bank';
                    methodName = 'Bank Transfer';
                    break;
            }
            
            let statusClass = 'pending';
            let statusText = p.status.toUpperCase();
            if (p.status === 'success' || p.status === 'successful' || p.status === 'completed') {
                statusClass = 'success';
            } else if (p.status === 'failed' || p.status === 'error') {
                statusClass = 'failed';
            } else {
                statusClass = 'pending';
            }
            
            const amount = parseFloat(p.amount).toFixed(2);
            const date = new Date(p.created_at).toLocaleString();
            const txId = p.transaction_id || 'N/A';
            
            html += `
                <tr>
                    <td>
                        <div class="payment-method">
                            <i class="fas ${icon} method-icon ${iconClass}"></i>
                            ${methodName}
                        </div>
                    </td>
                    <td style="text-align:right; font-weight:700; color:#0f172a;">
                        Ksh ${amount}
                    </td>
                    <td style="text-align:center;">
                        <span class="payment-status ${statusClass}">${statusText}</span>
                    </td>
                    <td>
                        <span class="payment-txid" title="${txId}">${txId.length > 30 ? txId.substring(0, 25) + '...' : txId}</span>
                    </td>
                    <td style="font-size:0.75rem; color:#94a3b8; white-space:nowrap;">
                        ${date}
                    </td>
                </tr>
            `;
        });
        
        tbody.innerHTML = html;
    })
    .catch(err => {
        console.error('Error loading payment history:', err);
        tbody.innerHTML = '<tr><td colspan="5" style="text-align:center; padding:20px; color:#ef4444;">Error loading payment history. Please try again.</td></tr>';
    });
}

// ============================================================
//  LOGOUT & DELETE ACCOUNT
// ============================================================

function logout() {
    if (typeof window.logout === 'function') {
        window.logout();
    } else {
        localStorage.removeItem('customerToken');
        localStorage.removeItem('currentUser');
        localStorage.removeItem('guest_cart');
        window.location.href = '/';
    }
}
window.logout = logout;

async function deleteAccount() {
    if (!confirm('⚠️ Are you sure you want to delete your account? This action cannot be undone.')) return;
    if (!confirm('⚠️ This is permanent! All your data will be lost. Are you absolutely sure?')) return;
    try {
        const res = await fetch('/api/auth/customer/delete', {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const data = await res.json();
        if (data.success) {
            alert('✅ Your account has been deleted.');
            localStorage.removeItem('customerToken');
            localStorage.removeItem('currentUser');
            localStorage.removeItem('guest_cart');
            window.location.href = '/';
        } else {
            alert('❌ Failed to delete account: ' + (data.error || 'Unknown error'));
        }
    } catch (err) {
        alert('❌ Network error. Please try again.');
    }
}
window.deleteAccount = deleteAccount;

// ============================================================
//  INIT
// ============================================================
document.addEventListener('DOMContentLoaded', () => {
    initSocket();
    navigateTo('dashboard');
    updateCartBadges();
});

// Expose globals
window.toggleSidebar = toggleSidebar;
window.closeSidebar = closeSidebar;
window.navigateTo = navigateTo;
window.loadCustomerDashboard = loadCustomerDashboard;
window.loadOrdersTable = loadOrdersTable;
window.loadProfile = loadProfile;
window.loadAddresses = loadAddresses;
window.loadPaymentHistory = loadPaymentHistory;
window.toggleOrderDetails = toggleOrderDetails;
window.sendOrderChat = sendOrderChat;
window.filterOrdersByStatus = filterOrdersByStatus;
window.showAddAddress = showAddAddress;
window.closeAddressModal = closeAddressModal;
window.saveAddress = saveAddress;
window.setDefaultAddress = setDefaultAddress;
window.deleteAddress = deleteAddress;
window.logout = logout;
window.deleteAccount = deleteAccount;
window.selectAddressSuggestion = selectAddressSuggestion;
window.reorderOrder = reorderOrder;
window.markReceived = markReceived;
window.requestReturn = requestReturn;
window.cancelOrder = cancelOrder;
window.updateProfile = updateProfile;