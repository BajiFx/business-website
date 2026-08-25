// ============================================================
//  ADMIN PANEL - COMPLETE SECURE VERSION
//  Location: D:\my-business-website\public\js\admin.js
// ============================================================

// ============================================================
//  GLOBALS
// ============================================================

var token = localStorage.getItem('token');
var currentSection = 'dashboard';
var socket = null;
var ordersData = [];
var customersData = [];
var productsData = [];
var promoData = [];
var isLoggedIn = false;
var isInitialized = false;
var statsInterval = null;

// ============================================================
//  INIT - RUN ON PAGE LOAD - ALWAYS SHOW LOGIN FIRST
// ============================================================

(function() {
    if (isInitialized) return;
    isInitialized = true;
    
    console.log('🔐 Admin panel loading...');
    
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initAdmin);
    } else {
        initAdmin();
    }
})();

function initAdmin() {
    console.log('🔐 Admin panel initializing...');
    
    // ALWAYS SHOW LOGIN FIRST - SECURE
    showLogin();
    
    // Setup login button
    var loginBtn = document.getElementById('loginBtn');
    if (loginBtn) {
        var newLoginBtn = loginBtn.cloneNode(true);
        loginBtn.parentNode.replaceChild(newLoginBtn, loginBtn);
        newLoginBtn.addEventListener('click', function(e) {
            e.preventDefault();
            e.stopPropagation();
            console.log('🔑 Login button clicked');
            handleLogin();
        });
    }

    // Setup register button
    var registerBtn = document.getElementById('registerBtn');
    if (registerBtn) {
        var newRegisterBtn = registerBtn.cloneNode(true);
        registerBtn.parentNode.replaceChild(newRegisterBtn, registerBtn);
        newRegisterBtn.addEventListener('click', function(e) {
            e.preventDefault();
            e.stopPropagation();
            console.log('📝 Register button clicked');
            handleRegister();
        });
    }

    // Enter key support
    var passwordField = document.getElementById('loginPassword');
    var emailField = document.getElementById('loginEmail');
    
    if (passwordField) {
        passwordField.addEventListener('keypress', function(e) {
            if (e.key === 'Enter') {
                e.preventDefault();
                handleLogin();
            }
        });
    }

    if (emailField) {
        emailField.addEventListener('keypress', function(e) {
            if (e.key === 'Enter') {
                e.preventDefault();
                handleLogin();
            }
        });
    }

    // ALWAYS SHOW BOTH TABS
    var registerTab = document.getElementById('registerTab');
    var registerForm = document.getElementById('registerForm');
    var loginForm = document.getElementById('loginForm');
    var loginTab = document.getElementById('loginTab');

    if (registerTab) {
        registerTab.style.display = 'block';
        registerTab.classList.add('active');
    }
    if (registerForm) {
        registerForm.classList.add('active');
    }
    if (loginForm) {
        loginForm.classList.add('active');
    }
    if (loginTab) {
        loginTab.classList.add('active');
    }
    
    showTab('login');
    
    // Clear any existing token on page load - SECURE
    localStorage.removeItem('token');
    token = null;
}

// ============================================================
//  SHOW/HIDE FUNCTIONS
// ============================================================

function showLogin() {
    console.log('🔐 Showing login screen...');
    
    var authContainer = document.getElementById('authContainer');
    var adminPanel = document.getElementById('adminPanel');

    if (authContainer) {
        authContainer.style.display = 'flex';
        authContainer.style.position = 'fixed';
        authContainer.style.top = '0';
        authContainer.style.left = '0';
        authContainer.style.right = '0';
        authContainer.style.bottom = '0';
        authContainer.style.zIndex = '99999';
        authContainer.style.background = '#f1f5f9';
        authContainer.classList.remove('hidden');
    }
    
    if (adminPanel) {
        adminPanel.style.display = 'none';
        adminPanel.classList.remove('visible');
    }

    isLoggedIn = false;

    var status = document.getElementById('loginStatus');
    if (status) {
        status.textContent = '';
        status.className = 'auth-status';
        status.style.color = '';
    }
    
    var loginBtn = document.getElementById('loginBtn');
    if (loginBtn) {
        loginBtn.disabled = false;
        loginBtn.textContent = 'Login';
    }
    
    showTab('login');
}

function showDashboard() {
    console.log('🔄 Showing dashboard...');

    var authContainer = document.getElementById('authContainer');
    var adminPanel = document.getElementById('adminPanel');

    if (authContainer) {
        authContainer.style.display = 'none';
        authContainer.classList.add('hidden');
    }

    if (adminPanel) {
        adminPanel.style.display = 'block';
        adminPanel.classList.add('visible');
        console.log('✅ Admin panel is now visible');
    }

    isLoggedIn = true;

    initSocket();
    navigateTo('dashboard');
    
    if (statsInterval) {
        clearInterval(statsInterval);
    }
    statsInterval = setInterval(function() {
        if (currentSection === 'dashboard' && isLoggedIn) {
            loadDashboardStats();
        }
    }, 30000);
}

function showTab(tab) {
    console.log('📋 Switching to tab:', tab);
    var loginForm = document.getElementById('loginForm');
    var registerForm = document.getElementById('registerForm');
    var loginTab = document.getElementById('loginTab');
    var registerTab = document.getElementById('registerTab');

    if (loginTab) loginTab.style.display = 'block';
    if (registerTab) registerTab.style.display = 'block';

    if (loginForm) loginForm.classList.toggle('active', tab === 'login');
    if (registerForm) registerForm.classList.toggle('active', tab === 'register');
    if (loginTab) loginTab.classList.toggle('active', tab === 'login');
    if (registerTab) registerTab.classList.toggle('active', tab === 'register');
}

function togglePassword(inputId, btn) {
    var input = document.getElementById(inputId);
    if (!input) return;
    var icon = btn.querySelector('i');
    if (input.type === 'password') {
        input.type = 'text';
        if (icon) icon.className = 'fas fa-eye-slash';
    } else {
        input.type = 'password';
        if (icon) icon.className = 'fas fa-eye';
    }
}

// ============================================================
//  HANDLE LOGIN - SECURE
// ============================================================

async function handleLogin() {
    var emailInput = document.getElementById('loginEmail');
    var passwordInput = document.getElementById('loginPassword');
    var status = document.getElementById('loginStatus');
    var loginBtn = document.getElementById('loginBtn');

    if (!emailInput || !passwordInput || !status) {
        console.error('❌ Login form elements not found');
        return;
    }

    var email = emailInput.value.trim();
    var password = passwordInput.value;

    console.log('🔑 Login attempt for:', email);

    status.className = 'auth-status';
    status.textContent = '';
    status.style.color = '';

    if (!email || !password) {
        status.textContent = '❌ Email and password are required.';
        status.className = 'auth-status error';
        status.style.color = '#ef4444';
        return;
    }

    if (password.length < 6) {
        status.textContent = '❌ Password must be at least 6 characters.';
        status.className = 'auth-status error';
        status.style.color = '#ef4444';
        return;
    }

    status.textContent = '⏳ Logging in...';
    status.style.color = '#2563eb';

    if (loginBtn) {
        loginBtn.disabled = true;
        loginBtn.textContent = '⏳ Logging in...';
    }

    try {
        var res = await fetch('/api/auth/login', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json'
            },
            body: JSON.stringify({ email: email, password: password })
        });

        var data = await res.json();

        if (res.ok && data.success && data.token) {
            status.textContent = '✅ Login successful! Loading dashboard...';
            status.className = 'auth-status success';
            status.style.color = '#16a34a';

            localStorage.setItem('token', data.token);
            token = data.token;

            console.log('✅ Token stored successfully');

            setTimeout(function() {
                showDashboard();
            }, 500);

        } else {
            var errorMsg = data.error || data.message || 'Invalid credentials. Please try again.';
            console.error('❌ Login failed:', errorMsg);

            status.textContent = '❌ ' + errorMsg;
            status.className = 'auth-status error';
            status.style.color = '#ef4444';

            if (loginBtn) {
                loginBtn.disabled = false;
                loginBtn.textContent = 'Login';
            }
        }

    } catch (err) {
        console.error('❌ Login error:', err);
        status.textContent = '❌ Network error: ' + err.message;
        status.className = 'auth-status error';
        status.style.color = '#ef4444';

        if (loginBtn) {
            loginBtn.disabled = false;
            loginBtn.textContent = 'Login';
        }
    }
}

// ============================================================
//  HANDLE REGISTER - SECURE
// ============================================================

async function handleRegister() {
    var emailInput = document.getElementById('regEmail');
    var passwordInput = document.getElementById('regPassword');
    var confirmInput = document.getElementById('regConfirm');
    var status = document.getElementById('registerStatus');
    var registerBtn = document.getElementById('registerBtn');

    if (!emailInput || !passwordInput || !confirmInput || !status) {
        console.error('❌ Register form elements not found');
        return;
    }

    var email = emailInput.value.trim();
    var password = passwordInput.value;
    var confirm = confirmInput.value;

    status.className = 'auth-status';
    status.textContent = '';
    status.style.color = '';

    if (!email || !password || !confirm) {
        status.textContent = '❌ All fields are required.';
        status.className = 'auth-status error';
        status.style.color = '#ef4444';
        return;
    }

    if (password.length < 6) {
        status.textContent = '❌ Password must be at least 6 characters.';
        status.className = 'auth-status error';
        status.style.color = '#ef4444';
        return;
    }

    if (password !== confirm) {
        status.textContent = '❌ Passwords do not match.';
        status.className = 'auth-status error';
        status.style.color = '#ef4444';
        return;
    }

    status.textContent = '⏳ Creating account...';
    status.style.color = '#2563eb';

    if (registerBtn) {
        registerBtn.disabled = true;
        registerBtn.textContent = '⏳ Creating...';
    }

    try {
        var res = await fetch('/api/auth/register', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json'
            },
            body: JSON.stringify({ email: email, password: password })
        });

        var data = await res.json();

        if (res.ok && data.success && data.token) {
            status.textContent = '✅ ' + data.message + ' Logging in...';
            status.className = 'auth-status success';
            status.style.color = '#16a34a';

            localStorage.setItem('token', data.token);
            token = data.token;

            console.log('✅ Token stored successfully');

            setTimeout(function() {
                showDashboard();
            }, 500);

        } else {
            var errorMsg = data.error || data.message || 'Registration failed. Please try again.';
            console.error('❌ Registration failed:', errorMsg);

            status.textContent = '❌ ' + errorMsg;
            status.className = 'auth-status error';
            status.style.color = '#ef4444';

            if (registerBtn) {
                registerBtn.disabled = false;
                registerBtn.textContent = 'Create Account';
            }
        }

    } catch (err) {
        console.error('❌ Register error:', err);
        status.textContent = '❌ Network error: ' + err.message;
        status.className = 'auth-status error';
        status.style.color = '#ef4444';

        if (registerBtn) {
            registerBtn.disabled = false;
            registerBtn.textContent = 'Create Account';
        }
    }
}

// ============================================================
//  LOGOUT - CLEAR EVERYTHING
// ============================================================

function logout() {
    console.log('🔐 Logging out...');
    
    localStorage.removeItem('token');
    token = null;
    isLoggedIn = false;
    
    if (statsInterval) {
        clearInterval(statsInterval);
        statsInterval = null;
    }
    
    if (socket) {
        socket.disconnect();
        socket = null;
    }
    
    showLogin();
    
    var loginEmail = document.getElementById('loginEmail');
    var loginPassword = document.getElementById('loginPassword');
    if (loginEmail) loginEmail.value = '';
    if (loginPassword) loginPassword.value = '';
    
    var status = document.getElementById('loginStatus');
    if (status) {
        status.textContent = '✅ Logged out successfully';
        status.className = 'auth-status success';
        status.style.color = '#16a34a';
    }
    
    console.log('✅ Logged out successfully');
}

// ============================================================
//  SIDEBAR FUNCTIONS
// ============================================================

function toggleSidebar() {
    var sidebar = document.getElementById('sidebar');
    var overlay = document.getElementById('sidebarOverlay');
    if (sidebar) sidebar.classList.toggle('open');
    if (overlay) overlay.classList.toggle('active');
}

function closeSidebar() {
    var sidebar = document.getElementById('sidebar');
    var overlay = document.getElementById('sidebarOverlay');
    if (sidebar) sidebar.classList.remove('open');
    if (overlay) overlay.classList.remove('active');
}

function navigateTo(section) {
    if (!isLoggedIn) {
        console.log('⚠️ Not logged in, cannot navigate');
        showLogin();
        return;
    }
    
    document.querySelectorAll('.section').forEach(function(el) {
        el.classList.remove('active');
    });
    
    var target = document.getElementById('section-' + section);
    if (target) target.classList.add('active');

    document.querySelectorAll('.menu-item').forEach(function(el) {
        el.classList.remove('active');
    });
    
    var menuItem = document.querySelector('.menu-item[data-section="' + section + '"]');
    if (menuItem) menuItem.classList.add('active');

    var titles = {
        dashboard: 'Dashboard',
        orders: 'Orders',
        customers: 'Customers',
        products: 'Product Manager',
        promos: 'Promo Codes',
        shop: 'Shop Profile',
        payments: 'Payment Systems',
        location: 'Location Requests',
        logs: 'Admin Activity Logs'
    };
    
    var headerTitle = document.getElementById('headerTitle');
    if (headerTitle) headerTitle.textContent = titles[section] || 'Dashboard';

    currentSection = section;
    closeSidebar();

    switch (section) {
        case 'dashboard':
            loadDashboardStats();
            break;
        case 'orders':
            loadOrders();
            break;
        case 'customers':
            loadCustomers();
            break;
        case 'products':
            loadAdminProducts();
            break;
        case 'promos':
            loadPromoCodes();
            break;
        case 'shop':
            loadShopProfile();
            break;
        case 'payments':
            loadPaymentSettings();
            break;
        case 'location':
            loadLocationRequests();
            break;
        case 'logs':
            loadAdminLogs();
            break;
    }
}

// ============================================================
//  AUTH HELPERS
// ============================================================

function authHeaders() {
    return { 'Authorization': 'Bearer ' + token };
}

function initSocket() {
    if (socket) return;
    if (!isLoggedIn) return;
    
    try {
        socket = io({ auth: { token: token } });
        socket.on('new-order', function() {
            if (currentSection === 'dashboard' || currentSection === 'orders') {
                loadDashboardStats();
                loadOrders();
            }
        });
        socket.on('order-status-updated', function() {
            if (currentSection === 'dashboard' || currentSection === 'orders') {
                loadDashboardStats();
                loadOrders();
            }
        });
        socket.on('replacement-requested', function() {
            if (currentSection === 'dashboard') loadDashboardStats();
        });
        socket.on('return-requested', function() {
            if (currentSection === 'dashboard') loadDashboardStats();
        });
    } catch (err) {
        console.error('⚠️ Socket init error:', err);
    }
}

// ============================================================
//  DASHBOARD - BEAUTIFUL STAT LINKS
// ============================================================

function loadDashboardStats() {
    if (!isLoggedIn) {
        console.log('⚠️ Not logged in, skipping dashboard stats');
        return;
    }
    
    console.log('📊 Loading dashboard stats...');
    var statsGrid = document.getElementById('statsGrid');
    if (statsGrid) statsGrid.innerHTML = '<p style="text-align:center;padding:20px;color:#94a3b8;grid-column:1/-1;">Loading stats...</p>';

    fetch('/api/admin/dashboard', { headers: authHeaders() })
        .then(function(res) {
            if (res.status === 401) { 
                logout(); 
                throw new Error('Unauthorized'); 
            }
            if (!res.ok) throw new Error('Failed to fetch dashboard');
            return res.json();
        })
        .then(function(stats) {
            console.log('📊 Stats received:', stats);
            renderStats(stats);
            loadRecentOrders();
            updateOrderBadge(stats);
        })
        .catch(function(err) {
            console.error('❌ Dashboard error:', err);
            if (statsGrid) statsGrid.innerHTML = '<p style="color:#ef4444;">❌ Error loading dashboard: ' + err.message + '</p>';
        });
}

// ============================================================
//  RENDER STATS - BEAUTIFUL LINK STYLES (NO CARDS)
// ============================================================

function renderStats(stats) {
    var grid = document.getElementById('statsGrid');
    if (!grid) return;

    // Define stat items: [key, label, icon, cssClass]
    var items = [
        { key: 'pending', label: 'Pending', icon: 'fa-clock', css: 'pending' },
        { key: 'pending_payment', label: 'Awaiting Payment', icon: 'fa-hourglass-half', css: 'pending_payment' },
        { key: 'confirmed', label: 'Confirmed', icon: 'fa-check-circle', css: 'confirmed' },
        { key: 'shipped', label: 'Shipped', icon: 'fa-truck', css: 'shipped' },
        { key: 'delivered', label: 'Awaiting Pickup', icon: 'fa-box-open', css: 'delivered' },
        { key: 'received', label: 'Received', icon: 'fa-check-double', css: 'received' },
        { key: 'cancelled', label: 'Cancelled', icon: 'fa-times-circle', css: 'cancelled' },
        { key: 'replacements_pending', label: 'Replacements', icon: 'fa-exchange-alt', css: 'replacements' },
        { key: 'refunds_pending', label: 'Refunds', icon: 'fa-hand-holding-usd', css: 'refunds' },
        { key: 'urgent', label: 'Urgent', icon: 'fa-exclamation-triangle', css: 'urgent' },
        { key: 'returns_pending', label: 'Returns', icon: 'fa-undo', css: 'returns' },
        { key: 'total_orders', label: 'Total Orders', icon: 'fa-shopping-bag', css: 'total' },
        { key: 'total_revenue', label: 'Revenue (Ksh)', icon: 'fa-money-bill-wave', css: 'revenue' }
    ];

    var html = '<div class="stats-grid">';
    items.forEach(function(item) {
        var value = stats[item.key] || 0;
        // Format revenue
        if (item.key === 'total_revenue') {
            value = 'Ksh ' + parseFloat(value).toFixed(2);
        }
        var isClickable = item.key !== 'total_revenue';
        var onclick = isClickable ? 'onclick="navigateTo(\'orders\')"' : '';
        var style = isClickable ? '' : 'cursor:default;';
        // Determine if blinking dot needed
        var isPending = ['pending','pending_payment','delivered','replacements_pending','refunds_pending','urgent','returns_pending'].includes(item.key);
        var blink = (value > 0 && isPending) ? '<span class="stat-blink"></span>' : '<span class="stat-blink hidden"></span>';
        
        html += '<div class="stat-link ' + item.css + '" ' + onclick + ' style="' + style + '">';
        html += '<span class="stat-icon"><i class="fas ' + item.icon + '"></i></span>';
        html += '<span class="stat-content">';
        html += '<span class="stat-value">' + value + '</span>';
        html += '<span class="stat-label">' + item.label + ' ' + blink + '</span>';
        html += '</span>';
        html += '</div>';
    });
    html += '</div>';

    grid.innerHTML = html;
}

function updateOrderBadge(stats) {
    var total = stats.total_orders || 0;
    var badge = document.querySelector('.menu-item[data-section="orders"] .badge');
    if (badge) badge.textContent = total;
}

function loadRecentOrders() {
    if (!isLoggedIn) {
        console.log('⚠️ Not logged in, skipping recent orders');
        return;
    }
    
    var container = document.getElementById('orderListContainer');
    if (container) container.innerHTML = '<p class="empty-msg">Loading recent orders...</p>';

    fetch('/api/admin/recent-orders?limit=10', { headers: authHeaders() })
        .then(function(res) { return res.json(); })
        .then(function(orders) {
            var container = document.getElementById('orderListContainer');
            if (!container) return;
            if (!orders || orders.length === 0) {
                container.innerHTML = '<p class="empty-msg">No recent orders.</p>';
                return;
            }
            var html = '';
            orders.forEach(function(order) {
                html += '<div class="order-row">';
                html += '<div class="order-header">';
                html += '<span class="ref">' + (order.order_ref || '#' + order.id) + '</span>';
                html += '<span class="customer">' + (order.customer_name || 'Guest') + '</span>';
                html += '<span class="date">' + new Date(order.created_at).toLocaleDateString() + '</span>';
                html += '<span class="total">Ksh ' + parseFloat(order.total).toFixed(2) + '</span>';
                html += '<span class="status-badge status-' + order.status + '">' + order.status.replace('_', ' ').toUpperCase() + '</span>';
                html += '</div>';
                html += '</div>';
            });
            container.innerHTML = html;
        })
        .catch(function(err) {
            console.error('❌ Recent orders error:', err);
            var container = document.getElementById('orderListContainer');
            if (container) container.innerHTML = '<p class="empty-msg">Error loading orders.</p>';
        });
}

// ============================================================
//  ORDERS
// ============================================================

function loadOrders() {
    if (!isLoggedIn) {
        console.log('⚠️ Not logged in, skipping orders');
        return;
    }
    
    var container = document.getElementById('ordersListContainer');
    if (container) container.innerHTML = '<p class="empty-msg">Loading orders...</p>';

    var statusFilter = document.getElementById('orderFilterStatus') ? document.getElementById('orderFilterStatus').value : 'all';
    var searchFilter = document.getElementById('orderFilterSearch') ? document.getElementById('orderFilterSearch').value : '';

    var url = '/api/admin/orders?';
    if (statusFilter !== 'all') url += 'status=' + statusFilter + '&';
    if (searchFilter) url += 'search=' + encodeURIComponent(searchFilter) + '&';

    fetch(url, { headers: authHeaders() })
        .then(function(res) { return res.json(); })
        .then(function(orders) {
            var container = document.getElementById('ordersListContainer');
            if (!container) return;
            ordersData = orders;
            if (!orders || orders.length === 0) {
                container.innerHTML = '<p class="empty-msg">No orders found.</p>';
                return;
            }
            var html = '';
            orders.forEach(function(order) {
                var actionsHtml = '';
                var statusClass = order.status || 'pending';
                var statusLabel = order.status.replace('_', ' ').toUpperCase();

                if (order.status === 'pending') {
                    actionsHtml += '<button class="btn-confirm" onclick="confirmOrder(' + order.id + ')">Confirm</button>';
                }
                if (order.status === 'pending_payment') {
                    actionsHtml += '<span style="font-size:0.6rem; color:#f59e0b;">⏳ Awaiting payment</span>';
                }
                if (order.status === 'delivered') {
                    actionsHtml += '<button class="btn-remind" onclick="remindCustomer(' + order.id + ')">Remind</button>';
                }
                if (order.refund_status === 'pending') {
                    actionsHtml += '<button class="btn-refund-approve" onclick="handleRefund(' + order.id + ',\'approve\')">Approve Refund</button>';
                    actionsHtml += '<button class="btn-refund-reject" onclick="handleRefund(' + order.id + ',\'reject\')">Reject</button>';
                }
                if (['pending', 'confirmed', 'pending_payment'].indexOf(order.status) !== -1) {
                    actionsHtml += '<button class="btn-cancel" onclick="cancelOrder(' + order.id + ')">Cancel</button>';
                }
                if (order.status === 'pending' || order.status === 'confirmed' || order.status === 'shipped' || order.status === 'delivered') {
                    actionsHtml += '<select onchange="updateOrderStatus(' + order.id + ', this.value)" style="padding:3px 8px; border-radius:4px; border:1px solid #d1d5db; font-size:0.6rem; margin-left:4px;">';
                    actionsHtml += '<option value="">Update...</option>';
                    if (order.status === 'pending') actionsHtml += '<option value="confirmed">Confirm</option>';
                    if (order.status === 'confirmed') actionsHtml += '<option value="shipped">Ship</option>';
                    if (order.status === 'shipped') actionsHtml += '<option value="delivered">Deliver</option>';
                    if (order.status === 'delivered') actionsHtml += '<option value="received">Received</option>';
                    actionsHtml += '</select>';
                }

                html += '<div class="order-row">';
                html += '<div class="order-header">';
                html += '<span class="ref">' + (order.order_ref || '#' + order.id) + '</span>';
                html += '<span class="customer">' + (order.customer_name || 'Guest') + '</span>';
                html += '<span class="date">' + new Date(order.created_at).toLocaleString() + '</span>';
                html += '<span class="total">Ksh ' + parseFloat(order.total).toFixed(2) + '</span>';
                html += '<span class="status-badge status-' + statusClass + '">' + statusLabel + '</span>';
                html += '</div>';
                html += '<div class="order-actions">' + actionsHtml + '</div>';
                html += '</div>';
            });
            container.innerHTML = html;
        })
        .catch(function(err) {
            console.error('❌ Orders error:', err);
            var container = document.getElementById('ordersListContainer');
            if (container) container.innerHTML = '<p class="empty-msg">Error loading orders.</p>';
        });
}

function updateOrderStatus(orderId, status) {
    if (!status) return;
    if (!confirm('Update order to ' + status.toUpperCase() + '?')) return;

    fetch('/api/admin/orders/' + orderId + '/status', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ status: status })
    })
    .then(function(res) { return res.json(); })
    .then(function(data) {
        if (data.success) {
            alert('✅ Order status updated.');
            loadOrders();
            loadDashboardStats();
        } else {
            alert('❌ Failed: ' + (data.error || 'Unknown error'));
        }
    })
    .catch(function() { alert('❌ Network error.'); });
}

function filterOrders() {
    loadOrders();
}

function exportOrdersCSV() {
    window.open('/api/admin/orders/export', '_blank');
}

function confirmOrder(orderId) {
    if (!confirm('Confirm this order?')) return;
    fetch('/api/admin/orders/' + orderId + '/confirm', { method: 'PUT', headers: authHeaders() })
    .then(function(res) { return res.json(); })
    .then(function(data) {
        if (data.success) {
            alert('✅ Order confirmed.');
            loadOrders();
            loadDashboardStats();
        } else {
            alert('❌ Failed: ' + (data.error || 'Unknown error'));
        }
    })
    .catch(function() { alert('❌ Network error.'); });
}

function remindCustomer(orderId) {
    if (!confirm('Send reminder to customer?')) return;
    fetch('/api/admin/orders/' + orderId + '/remind', { method: 'POST', headers: authHeaders() })
    .then(function(res) { return res.json(); })
    .then(function(data) {
        if (data.success) {
            alert('✅ Reminder sent.');
        } else {
            alert('❌ Failed: ' + (data.error || 'Unknown error'));
        }
    })
    .catch(function() { alert('❌ Network error.'); });
}

function handleRefund(orderId, action) {
    if (!confirm((action === 'approve' ? 'Approve' : 'Reject') + ' refund?')) return;
    fetch('/api/admin/orders/' + orderId + '/refund', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ action: action })
    })
    .then(function(res) { return res.json(); })
    .then(function(data) {
        if (data.success) {
            alert('✅ Refund ' + action + 'd.');
            loadOrders();
            loadDashboardStats();
        } else {
            alert('❌ Failed: ' + (data.error || 'Unknown error'));
        }
    })
    .catch(function() { alert('❌ Network error.'); });
}

function cancelOrder(orderId) {
    var reason = prompt('Cancellation reason:');
    if (!reason) return;
    if (!confirm('Cancel this order?')) return;
    fetch('/api/admin/orders/' + orderId + '/cancel', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ reason: reason })
    })
    .then(function(res) { return res.json(); })
    .then(function(data) {
        if (data.success) {
            alert('✅ Order cancelled.');
            loadOrders();
            loadDashboardStats();
        } else {
            alert('❌ Failed: ' + (data.error || 'Unknown error'));
        }
    })
    .catch(function() { alert('❌ Network error.'); });
}

// ============================================================
//  CUSTOMERS
// ============================================================

function loadCustomers() {
    if (!isLoggedIn) {
        console.log('⚠️ Not logged in, skipping customers');
        return;
    }
    
    var tbody = document.getElementById('customerTableBody');
    if (tbody) tbody.innerHTML = '<tr><td colspan="6" style="text-align:center; padding:20px; color:#94a3b8;">Loading customers...</td></tr>';

    fetch('/api/admin/customers', { headers: authHeaders() })
    .then(function(res) { return res.json(); })
    .then(function(customers) {
        customersData = customers;
        var tbody = document.getElementById('customerTableBody');
        if (!tbody) return;
        if (!customers || customers.length === 0) {
            tbody.innerHTML = '<tr><td colspan="6" style="text-align:center; padding:20px; color:#94a3b8;">No customers yet.</td></tr>';
            return;
        }
        var html = '';
        customers.forEach(function(c) {
            html += '<tr>';
            html += '<td><strong>' + c.name + '</strong></td>';
            html += '<td>' + c.email + '</td>';
            html += '<td>' + (c.phone || '—') + '</td>';
            html += '<td>' + (c.order_count || 0) + '</td>';
            html += '<td>Ksh ' + parseFloat(c.total_spent || 0).toFixed(2) + '</td>';
            html += '<td>' + new Date(c.created_at).toLocaleDateString() + '</td>';
            html += '</tr>';
        });
        tbody.innerHTML = html;
    })
    .catch(function(err) {
        console.error('❌ Customers error:', err);
        var tbody = document.getElementById('customerTableBody');
        if (tbody) tbody.innerHTML = '<tr><td colspan="6" style="text-align:center; padding:20px; color:#ef4444;">Error loading customers.</td></tr>';
    });
}

// ============================================================
//  PRODUCTS
// ============================================================

var variantCounter = 0;

function addVariantRow(name, price, stock, colorCode) {
    name = name || '';
    price = price || '';
    stock = stock || '';
    colorCode = colorCode || '#cccccc';
    var container = document.getElementById('variantsContainer');
    if (!container) return;
    var row = document.createElement('div');
    row.className = 'variant-row';
    row.dataset.index = variantCounter++;
    row.innerHTML = '<input type="text" class="variant-name" placeholder="Color name" value="' + name + '">';
    row.innerHTML += '<input type="text" class="variant-price" placeholder="Price (optional)" value="' + price + '">';
    row.innerHTML += '<input type="number" class="variant-stock" placeholder="Stock" value="' + stock + '">';
    row.innerHTML += '<input type="color" class="variant-color-code" value="' + colorCode + '">';
    row.innerHTML += '<input type="file" class="variant-image" accept="image/*">';
    row.innerHTML += '<button type="button" class="remove-variant" onclick="this.closest(\'.variant-row\').remove()">✕</button>';
    container.appendChild(row);
}

function clearVariants() {
    var container = document.getElementById('variantsContainer');
    if (container) container.innerHTML = '';
    variantCounter = 0;
}

function getVariantData() {
    var rows = document.querySelectorAll('.variant-row');
    var variants = [];
    rows.forEach(function(row) {
        var name = row.querySelector('.variant-name') ? row.querySelector('.variant-name').value.trim() : '';
        var price = row.querySelector('.variant-price') ? row.querySelector('.variant-price').value.trim() : '';
        var stock = row.querySelector('.variant-stock') ? row.querySelector('.variant-stock').value.trim() : '';
        var colorCode = row.querySelector('.variant-color-code') ? row.querySelector('.variant-color-code').value : '#cccccc';
        var fileInput = row.querySelector('.variant-image');
        var file = fileInput && fileInput.files && fileInput.files[0] ? fileInput.files[0] : null;
        if (name) variants.push({ name: name, price: price, stock: stock, colorCode: colorCode, file: file });
    });
    return variants;
}

function loadAdminProducts() {
    if (!isLoggedIn) {
        console.log('⚠️ Not logged in, skipping products');
        return;
    }
    
    var list = document.getElementById('adminProductList');
    if (!list) return;
    list.innerHTML = '<p style="color:#94a3b8;">Loading products...</p>';

    fetch('/api/products', { headers: authHeaders() })
    .then(function(res) { return res.json(); })
    .then(function(products) {
        productsData = products;
        if (!products || products.length === 0) {
            list.innerHTML = '<p style="color:#94a3b8; padding:10px 0;">No products yet. Add your first product above.</p>';
            return;
        }
        var html = '';
        products.forEach(function(p) {
            html += '<div class="product-item">';
            html += '<div class="info">';
            html += '<span class="name">' + p.name + '</span>';
            html += '<span class="price">Ksh ' + p.price + '</span>';
            if (p.rating) html += '<span style="margin-left:8px;">⭐(' + p.rating + ')</span>';
            if (p.isFlashSale) html += ' <span style="color:#ef4444;">🔥</span>';
            if (p.isNewArrival) html += ' <span style="color:#48dbfb;">🆕</span>';
            html += '<span style="font-size:0.55rem; color:#64748b; margin-left:8px;">Stock: ' + (p.stock || 0) + '</span>';
            html += '</div>';
            html += '<div class="actions">';
            html += '<button class="btn-secondary btn-sm" onclick="editProduct(' + p.id + ')" style="padding:4px 12px; border-radius:4px; border:1px solid #d1d5db; background:#e2e8f0; cursor:pointer; margin-right:4px;">✏️ Edit</button>';
            html += '<button class="btn-danger btn-sm" onclick="deleteProduct(' + p.id + ')" style="padding:4px 12px; border-radius:4px; border:none; background:#ef4444; color:white; cursor:pointer;">Delete</button>';
            html += '</div>';
            html += '</div>';
        });
        list.innerHTML = html;
    })
    .catch(function(err) {
        console.error('❌ Products error:', err);
        list.innerHTML = '<p style="color:#ef4444;">Error loading products.</p>';
    });
}

// ============================================================
//  PROMO CODES
// ============================================================

function loadPromoCodes() {
    if (!isLoggedIn) {
        console.log('⚠️ Not logged in, skipping promo codes');
        return;
    }
    
    fetch('/api/admin/promo-codes', { headers: authHeaders() })
    .then(function(res) { return res.json(); })
    .then(function(data) {
        promoData = data;
        var container = document.getElementById('promoList');
        if (!container) return;
        if (!data || data.length === 0) {
            container.innerHTML = '<p class="empty-msg" style="color:#94a3b8; padding:10px 0;">No promo codes yet.</p>';
            return;
        }
        var html = '';
        data.forEach(function(p) {
            html += '<div style="display:flex; justify-content:space-between; align-items:center; padding:8px 0; border-bottom:1px solid #f1f4f8; font-size:0.85rem;">';
            html += '<div>';
            html += '<strong style="color:#0f172a;">' + p.code + '</strong>';
            html += '<span style="margin-left:12px; color:#475569;">' + p.discount_type + ' ' + p.discount_value + '%</span>';
            html += '<span style="margin-left:12px; color:#94a3b8;">Min: Ksh ' + p.min_order_value + '</span>';
            html += '<span style="margin-left:12px; color:#94a3b8;">Used: ' + p.used_count + '/' + (p.usage_limit || '∞') + '</span>';
            html += p.active ? '<span style="color:#22c55e;">✅ Active</span>' : '<span style="color:#ef4444;">❌ Inactive</span>';
            html += '</div>';
            html += '<button onclick="deletePromo(' + p.id + ')" style="padding:4px 12px; border-radius:4px; border:none; background:#ef4444; color:white; cursor:pointer; font-size:0.7rem;">Delete</button>';
            html += '</div>';
        });
        container.innerHTML = html;
    })
    .catch(function(err) {
        console.error('❌ Promo codes error:', err);
        var container = document.getElementById('promoList');
        if (container) container.innerHTML = '<p class="empty-msg">Error loading promo codes.</p>';
    });
}

function createPromo(e) {
    e.preventDefault();
    var code = document.getElementById('promoCode') ? document.getElementById('promoCode').value.trim() : '';
    var type = document.getElementById('promoType') ? document.getElementById('promoType').value : 'percentage';
    var value = parseFloat(document.getElementById('promoValue') ? document.getElementById('promoValue').value : 0);
    var min = parseFloat(document.getElementById('promoMin') ? document.getElementById('promoMin').value : 0);
    var expires = document.getElementById('promoExpires') ? document.getElementById('promoExpires').value : '';
    var limit = document.getElementById('promoLimit') && document.getElementById('promoLimit').value ? parseInt(document.getElementById('promoLimit').value) : null;

    if (!code || !value) {
        alert('Code and value required.');
        return;
    }

    fetch('/api/admin/promo-codes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({
            code: code,
            discount_type: type,
            discount_value: value,
            min_order_value: min,
            expires_at: expires || null,
            usage_limit: limit
        })
    })
    .then(function(res) { return res.json(); })
    .then(function(data) {
        if (data.success) {
            alert('✅ Promo created!');
            loadPromoCodes();
            document.getElementById('promoCode').value = '';
            document.getElementById('promoValue').value = '';
            document.getElementById('promoMin').value = '0';
            document.getElementById('promoExpires').value = '';
            document.getElementById('promoLimit').value = '';
        } else {
            alert('❌ Failed: ' + (data.error || 'Unknown error'));
        }
    })
    .catch(function() { alert('❌ Network error.'); });
}

function deletePromo(id) {
    if (!confirm('Delete this promo?')) return;
    fetch('/api/admin/promo-codes/' + id, { method: 'DELETE', headers: authHeaders() })
    .then(function(res) {
        if (res.ok) loadPromoCodes();
        else alert('Failed to delete.');
    })
    .catch(function() { alert('Network error.'); });
}

// ============================================================
//  SHOP PROFILE
// ============================================================

function loadShopProfile() {
    if (!isLoggedIn) {
        console.log('⚠️ Not logged in, skipping shop profile');
        return;
    }
    
    fetch('/api/shop', { headers: authHeaders() })
    .then(function(res) { return res.json(); })
    .then(function(shop) {
        var fields = {
            shopName: shop.name || '',
            shopLocation: shop.location || '',
            shopAddress: shop.address || '',
            shopLatitude: shop.latitude || '',
            shopLongitude: shop.longitude || '',
            shopDesc: shop.description || '',
            shopMission: shop.mission || '',
            shopVision: shop.vision || '',
            shopWhatsapp: shop.whatsapp || '',
            shopTiktok: shop.tiktok || '',
            shopInstagram: shop.instagram || '',
            shopFacebook: shop.facebook || '',
            shopPhone: shop.phone || '',
            shopShippingPolicy: shop.shipping_policy || '',
            shopReturnPolicy: shop.return_policy || '',
            shopTerms: shop.terms_policy || '',
            shopPrivacy: shop.privacy_policy || '',
            shopDelivery: shop.delivery_enabled || false,
            shopOnline: shop.online_orders_enabled || false
        };

        Object.keys(fields).forEach(function(id) {
            var el = document.getElementById(id);
            if (el) {
                if (el.type === 'checkbox') {
                    el.checked = fields[id];
                } else {
                    el.value = fields[id];
                }
            }
        });
    })
    .catch(function(err) {
        console.error('❌ Shop profile error:', err);
    });
}

// ============================================================
//  PAYMENT SETTINGS
// ============================================================

function loadPaymentSettings() {
    if (!isLoggedIn) {
        console.log('⚠️ Not logged in, skipping payment settings');
        return;
    }
    
    fetch('/api/shop', { headers: authHeaders() })
    .then(function(res) { return res.json(); })
    .then(function(shop) {
        var fields = {
            paymentMpesa: shop.mpesa_enabled || false,
            paymentMpesaNumber: shop.mpesa_number || '',
            paymentAirtel: shop.airtel_enabled || false,
            paymentAirtelNumber: shop.airtel_number || '',
            paymentBank: shop.bank_enabled || false,
            paymentBankName: shop.bank_name || '',
            paymentBankAccount: shop.bank_account || '',
            paymentBankHolder: shop.bank_account_name || '',
            paymentPaypal: shop.paypal_enabled || false,
            paymentPaypalEmail: shop.paypal_email || ''
        };

        Object.keys(fields).forEach(function(id) {
            var el = document.getElementById(id);
            if (el) {
                if (el.type === 'checkbox') {
                    el.checked = fields[id];
                } else {
                    el.value = fields[id];
                }
            }
        });
    })
    .catch(function(err) {
        console.error('❌ Payment settings error:', err);
    });
}

// ============================================================
//  LOCATION REQUESTS
// ============================================================

function loadLocationRequests() {
    if (!isLoggedIn) {
        console.log('⚠️ Not logged in, skipping location requests');
        return;
    }
    
    fetch('/api/admin/location-requests', { headers: authHeaders() })
    .then(function(res) { return res.json(); })
    .then(function(data) {
        var container = document.getElementById('locationRequestsList');
        if (!container) return;
        if (!data || data.length === 0) {
            container.innerHTML = '<p class="empty-msg" style="color:#94a3b8; padding:10px 0;">No pending location requests.</p>';
            return;
        }
        var html = '';
        data.forEach(function(req) {
            html += '<div style="display:flex; justify-content:space-between; align-items:center; padding:10px 0; border-bottom:1px solid #f1f4f8; font-size:0.85rem;">';
            html += '<div>';
            html += '<strong>' + req.name + '</strong>';
            html += '<span style="color:#64748b; margin-left:8px;">' + req.email + '</span>';
            html += '<br><span style="font-size:0.7rem; color:#94a3b8;">Requested: ' + new Date(req.created_at).toLocaleString() + '</span>';
            html += '</div>';
            html += '<div>';
            html += '<button onclick="approveLocation(' + req.id + ')" style="padding:4px 14px; border-radius:4px; border:none; background:#22c55e; color:white; cursor:pointer; margin-right:4px;">Approve</button>';
            html += '<button onclick="rejectLocation(' + req.id + ')" style="padding:4px 14px; border-radius:4px; border:none; background:#ef4444; color:white; cursor:pointer;">Reject</button>';
            html += '</div>';
            html += '</div>';
        });
        container.innerHTML = html;
    })
    .catch(function(err) {
        console.error('❌ Location requests error:', err);
        var container = document.getElementById('locationRequestsList');
        if (container) container.innerHTML = '<p class="empty-msg">Error loading location requests.</p>';
    });
}

function approveLocation(id) {
    if (!confirm('Approve location access?')) return;
    fetch('/api/admin/location-requests/' + id + '/approve', { method: 'POST', headers: authHeaders() })
    .then(function(res) {
        if (res.ok) {
            alert('✅ Approved!');
            loadLocationRequests();
        } else {
            alert('❌ Failed.');
        }
    })
    .catch(function() { alert('❌ Network error.'); });
}

function rejectLocation(id) {
    if (!confirm('Reject location access?')) return;
    fetch('/api/admin/location-requests/' + id + '/reject', { method: 'POST', headers: authHeaders() })
    .then(function(res) {
        if (res.ok) {
            alert('✅ Rejected.');
            loadLocationRequests();
        } else {
            alert('❌ Failed.');
        }
    })
    .catch(function() { alert('❌ Network error.'); });
}

// ============================================================
//  ADMIN LOGS
// ============================================================

function loadAdminLogs() {
    if (!isLoggedIn) {
        console.log('⚠️ Not logged in, skipping admin logs');
        return;
    }
    
    fetch('/api/admin/logs', { headers: authHeaders() })
    .then(function(res) { return res.json(); })
    .then(function(logs) {
        var container = document.getElementById('logsList');
        if (!container) return;
        if (!logs || logs.length === 0) {
            container.innerHTML = '<p class="empty-msg" style="color:#94a3b8; padding:10px 0;">No logs yet.</p>';
            return;
        }
        var html = '';
        logs.forEach(function(log) {
            html += '<div style="padding:6px 0; border-bottom:1px solid #f1f4f8; font-size:0.75rem; display:flex; gap:12px;">';
            html += '<span style="color:#94a3b8; white-space:nowrap;">' + new Date(log.created_at).toLocaleString() + '</span>';
            html += '<span style="font-weight:600; color:#2563eb;">' + log.action + '</span>';
            html += '<span style="color:#64748b;">' + (log.details ? JSON.stringify(log.details) : '') + '</span>';
            html += '</div>';
        });
        container.innerHTML = html;
    })
    .catch(function(err) {
        console.error('❌ Logs error:', err);
        var container = document.getElementById('logsList');
        if (container) container.innerHTML = '<p class="empty-msg">Error loading logs.</p>';
    });
}

// ============================================================
//  PRODUCT EDIT/DELETE FUNCTIONS
// ============================================================

async function editProduct(id) {
    try {
        var res = await fetch('/api/products/' + id + '/detail', { headers: authHeaders() });
        var data = await res.json();
        var product = data.product;
        var variants = data.variants || [];

        var fields = {
            editProductId: product.id,
            pName: product.name || '',
            pPrice: product.price || '',
            pOldPrice: product.old_price || '',
            pDiscount: product.discount_percent || '',
            pCategory: product.category || '',
            pStock: product.stock || 0,
            pContact: product.contact || '+254700000000',
            pRating: product.rating || '',
            pBadge1: product.badge1 || '',
            pBadge2: product.badge2 || '',
            pShipping: product.shipping || '',
            pDescription: product.description || '',
            pFlashSale: product.isFlashSale || false,
            pNewArrival: product.isNewArrival || false
        };

        Object.keys(fields).forEach(function(id) {
            var el = document.getElementById(id);
            if (el) {
                if (el.type === 'checkbox') {
                    el.checked = fields[id];
                } else {
                    el.value = fields[id];
                }
            }
        });

        clearVariants();
        variants.forEach(function(v) {
            addVariantRow(v.name, v.price || '', v.stock || '', v.color_code || '#cccccc');
        });

        var submitBtn = document.getElementById('productSubmitBtn');
        if (submitBtn) submitBtn.textContent = '💾 Update Product';
        var cancelBtn = document.getElementById('cancelEditBtn');
        if (cancelBtn) cancelBtn.style.display = 'inline-block';
        window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (err) {
        alert('Failed to load product details.');
    }
}

function cancelEditProduct() {
    var form = document.getElementById('productForm');
    if (form) form.reset();
    var editIdField = document.getElementById('editProductId');
    if (editIdField) editIdField.value = '';
    var submitBtn = document.getElementById('productSubmitBtn');
    if (submitBtn) submitBtn.textContent = '➕ Add Product';
    var cancelBtn = document.getElementById('cancelEditBtn');
    if (cancelBtn) cancelBtn.style.display = 'none';
    clearVariants();
    loadAdminProducts();
}

function deleteProduct(id) {
    if (!confirm('Delete this product?')) return;
    fetch('/api/products/' + id, { method: 'DELETE', headers: authHeaders() })
    .then(function(res) {
        if (res.ok) loadAdminProducts();
        else alert('Failed to delete product.');
    })
    .catch(function() { alert('Network error.'); });
}

// ============================================================
//  EVENT LISTENERS FOR FORMS
// ============================================================

document.addEventListener('DOMContentLoaded', function() {
    // Shop form
    var shopForm = document.getElementById('shopForm');
    if (shopForm) {
        shopForm.addEventListener('submit', async function(e) {
            e.preventDefault();
            var formData = new FormData(this);
            var status = document.getElementById('settingsStatus');
            if (status) status.textContent = '⏳ Saving...';
            try {
                var res = await fetch('/api/shop', { method: 'POST', headers: authHeaders(), body: formData });
                var data = await res.json();
                if (res.ok) {
                    if (status) {
                        status.textContent = '✅ Settings saved!';
                        status.style.color = '#16a34a';
                    }
                    alert('✅ Shop profile updated!');
                } else {
                    if (status) {
                        status.textContent = '❌ Failed: ' + (data.error || 'Unknown error');
                        status.style.color = '#ef4444';
                    }
                }
            } catch (err) {
                if (status) {
                    status.textContent = '❌ Network error.';
                    status.style.color = '#ef4444';
                }
            }
        });
    }

    // Payment form
    var paymentForm = document.getElementById('paymentForm');
    if (paymentForm) {
        paymentForm.addEventListener('submit', async function(e) {
            e.preventDefault();
            var formData = new FormData();
            var fields = {
                mpesa_enabled: document.getElementById('paymentMpesa') ? document.getElementById('paymentMpesa').checked : false,
                mpesa_number: document.getElementById('paymentMpesaNumber') ? document.getElementById('paymentMpesaNumber').value : '',
                airtel_enabled: document.getElementById('paymentAirtel') ? document.getElementById('paymentAirtel').checked : false,
                airtel_number: document.getElementById('paymentAirtelNumber') ? document.getElementById('paymentAirtelNumber').value : '',
                bank_enabled: document.getElementById('paymentBank') ? document.getElementById('paymentBank').checked : false,
                bank_name: document.getElementById('paymentBankName') ? document.getElementById('paymentBankName').value : '',
                bank_account: document.getElementById('paymentBankAccount') ? document.getElementById('paymentBankAccount').value : '',
                bank_account_name: document.getElementById('paymentBankHolder') ? document.getElementById('paymentBankHolder').value : '',
                paypal_enabled: document.getElementById('paymentPaypal') ? document.getElementById('paymentPaypal').checked : false,
                paypal_email: document.getElementById('paymentPaypalEmail') ? document.getElementById('paymentPaypalEmail').value : ''
            };

            Object.keys(fields).forEach(function(key) {
                formData.append(key, fields[key]);
            });

            var status = document.getElementById('paymentStatus');
            if (status) status.textContent = '⏳ Saving...';
            try {
                var res = await fetch('/api/shop', { method: 'POST', headers: authHeaders(), body: formData });
                var data = await res.json();
                if (res.ok) {
                    if (status) {
                        status.textContent = '✅ Payment settings saved!';
                        status.style.color = '#16a34a';
                    }
                    alert('✅ Payment settings updated!');
                } else {
                    if (status) {
                        status.textContent = '❌ Failed: ' + (data.error || 'Unknown error');
                        status.style.color = '#ef4444';
                    }
                }
            } catch (err) {
                if (status) {
                    status.textContent = '❌ Network error.';
                    status.style.color = '#ef4444';
                }
            }
        });
    }

    // Product form
    var productForm = document.getElementById('productForm');
    if (productForm) {
        productForm.addEventListener('submit', async function(e) {
            e.preventDefault();
            var formData = new FormData(this);
            
            var variants = getVariantData();
            if (variants.length > 0) {
                formData.append('variants', JSON.stringify(variants));
                variants.forEach(function(v, index) {
                    if (v.file) {
                        formData.append('variantImages', v.file);
                    }
                });
            }

            var editId = document.getElementById('editProductId') ? document.getElementById('editProductId').value : '';
            var url = editId ? '/api/products/' + editId : '/api/products';
            var method = editId ? 'PUT' : 'POST';

            try {
                var res = await fetch(url, { method: method, headers: authHeaders(), body: formData });
                var data = await res.json();
                if (res.ok) {
                    alert(editId ? '✅ Product updated!' : '✅ Product added!');
                    cancelEditProduct();
                    loadAdminProducts();
                } else {
                    alert('❌ Failed: ' + (data.error || 'Unknown error'));
                }
            } catch (err) {
                alert('❌ Network error.');
            }
        });
    }
});

// ============================================================
//  EXPOSE GLOBALS
// ============================================================

window.toggleSidebar = toggleSidebar;
window.closeSidebar = closeSidebar;
window.navigateTo = navigateTo;
window.logout = logout;
window.showTab = showTab;
window.togglePassword = togglePassword;
window.loadDashboardStats = loadDashboardStats;
window.loadOrders = loadOrders;
window.loadCustomers = loadCustomers;
window.loadPromoCodes = loadPromoCodes;
window.loadLocationRequests = loadLocationRequests;
window.loadAdminLogs = loadAdminLogs;
window.loadAdminProducts = loadAdminProducts;
window.loadShopProfile = loadShopProfile;
window.loadPaymentSettings = loadPaymentSettings;
window.confirmOrder = confirmOrder;
window.remindCustomer = remindCustomer;
window.handleRefund = handleRefund;
window.cancelOrder = cancelOrder;
window.approveLocation = approveLocation;
window.rejectLocation = rejectLocation;
window.createPromo = createPromo;
window.deletePromo = deletePromo;
window.addVariantRow = addVariantRow;
window.editProduct = editProduct;
window.cancelEditProduct = cancelEditProduct;
window.deleteProduct = deleteProduct;
window.exportOrdersCSV = exportOrdersCSV;
window.filterOrders = filterOrders;
window.updateOrderStatus = updateOrderStatus;
window.handleLogin = handleLogin;
window.handleRegister = handleRegister;
window.showDashboard = showDashboard;
window.showLogin = showLogin;

console.log('✅ Admin panel loaded successfully - BEAUTIFUL STAT LINKS');