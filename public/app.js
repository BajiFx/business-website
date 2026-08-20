// ============================================================
//  GLOBALS & EXPOSE TO WINDOW
// ============================================================
let allProducts = [];
let rotatedProducts = [];
let currentSlide = 0;
let slideInterval;
let mapInstance = null;
let liveMapInstance = null;
let liveMarker = null;
let liveRouteLine = null;
let chatSocket = null;
let chatOpen = false;
let chatMessages = [];
let heroImages = [];
let heroImageIndex = 0;
let heroImageInterval = null;
let currentModalProductId = null;
let modalQty = 1;

// ---- Expose auth state globally ----
window.customerToken = localStorage.getItem('customerToken');
window.currentUser = null;

function setCustomerToken(token) {
  window.customerToken = token;
  if (token) {
    localStorage.setItem('customerToken', token);
  } else {
    localStorage.removeItem('customerToken');
  }
}

function setCurrentUser(user) {
  window.currentUser = user;
  if (user) {
    localStorage.setItem('currentUser', JSON.stringify(user));
  } else {
    localStorage.removeItem('currentUser');
  }
}

const storedUser = localStorage.getItem('currentUser');
if (storedUser) {
  try {
    window.currentUser = JSON.parse(storedUser);
  } catch (e) {}
}

// ============================================================
//  CART SYNC FUNCTIONS
// ============================================================
async function syncCartToServer() {
  if (!isLoggedIn()) return;
  const cart = getCart();
  try {
    const res = await fetch('/api/cart', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${window.customerToken}`
      },
      body: JSON.stringify({ items: cart })
    });
    if (!res.ok) console.error('Cart sync failed');
  } catch (err) {
    console.error('Cart sync error:', err);
  }
}

async function loadCartFromServer() {
  if (!isLoggedIn()) return;
  try {
    const res = await fetch('/api/cart', {
      headers: { 'Authorization': `Bearer ${window.customerToken}` }
    });
    if (res.ok) {
      const data = await res.json();
      if (data.items && data.items.length > 0) {
        saveCart(data.items);
        renderGrid();
        updateCartBadge();
        if (window.renderCartPage) window.renderCartPage();
      }
    }
  } catch (err) {
    console.error('Load cart error:', err);
  }
}

const originalSaveCart = window.saveCart || function(cart) { localStorage.setItem('cart', JSON.stringify(cart)); updateCartBadge(); };
window.saveCart = function(cart) {
  localStorage.setItem('cart', JSON.stringify(cart));
  updateCartBadge();
  syncCartToServer();
  if (window.renderCartPage) window.renderCartPage();
};

const originalLogin = window.handleAuthLogin;
window.handleAuthLogin = async function() {
  await originalLogin.apply(this, arguments);
  await loadCartFromServer();
};

const originalRegister = window.handleAuthRegister;
window.handleAuthRegister = async function() {
  await originalRegister.apply(this, arguments);
  await loadCartFromServer();
};

// ============================================================
//  DOM READY & MAP TOGGLE
// ============================================================
document.addEventListener('DOMContentLoaded', () => {
  const heroTitle = document.getElementById('heroTitle');
  if (heroTitle) {
    const text = heroTitle.textContent;
    heroTitle.textContent = '';
    let i = 0;
    const typeInterval = setInterval(() => {
      if (i < text.length) {
        heroTitle.textContent += text.charAt(i);
        i++;
      } else {
        clearInterval(typeInterval);
      }
    }, 60);
  }
  updateCartBadge();
  updateNavCartBadge();

  const showMapBtn = document.getElementById('showMapBtn');
  const mapSection = document.getElementById('staticMapSection');
  const liveSection = document.getElementById('liveLocationSection');
  if (showMapBtn) {
    showMapBtn.addEventListener('click', function() {
      if (!isLoggedIn()) {
        openAuthModal('login');
        return;
      }
      checkLocationStatus().then(approved => {
        if (approved) {
          if (mapSection) mapSection.style.display = 'block';
          if (liveSection) liveSection.style.display = 'block';
          showMapBtn.textContent = '📍 Hide Shop Location';
          if (window.mapInstance) setTimeout(() => mapInstance.invalidateSize(), 100);
          if (liveMapInstance) setTimeout(() => liveMapInstance.invalidateSize(), 100);
          fetch('/api/shop').then(res => res.json()).then(shop => {
            if (shop.admin_lat && shop.admin_lng) {
              updateLiveLocation(parseFloat(shop.admin_lat), parseFloat(shop.admin_lng));
            }
          });
        } else {
          const statusElem = document.getElementById('locationRequestStatus');
          statusElem.textContent = '⏳ Requesting location access...';
          fetch('/api/customer/location/request', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${window.customerToken}` }
          })
          .then(res => res.json())
          .then(data => {
            if (res.ok && data.alreadyApproved) {
              statusElem.textContent = '✅ You already have access!';
              statusElem.style.color = '#16a34a';
              if (mapSection) mapSection.style.display = 'block';
              if (liveSection) liveSection.style.display = 'block';
              showMapBtn.textContent = '📍 Hide Shop Location';
              if (window.mapInstance) setTimeout(() => mapInstance.invalidateSize(), 100);
              if (liveMapInstance) setTimeout(() => liveMapInstance.invalidateSize(), 100);
            } else if (res.ok) {
              statusElem.textContent = '✅ Request sent! Waiting for admin approval.';
              statusElem.style.color = '#16a34a';
              if (mapSection) mapSection.style.display = 'block';
              showMapBtn.textContent = '📍 Hide Shop Location';
              if (window.mapInstance) setTimeout(() => mapInstance.invalidateSize(), 100);
              const poll = setInterval(() => {
                checkLocationStatus().then(approved => {
                  if (approved) {
                    clearInterval(poll);
                    if (liveSection) liveSection.style.display = 'block';
                    if (liveMapInstance) setTimeout(() => liveMapInstance.invalidateSize(), 100);
                    statusElem.textContent = '✅ Location approved! Live map active.';
                    statusElem.style.color = '#16a34a';
                  }
                });
              }, 3000);
            } else {
              statusElem.textContent = '❌ ' + (data.error || 'Request failed');
              statusElem.style.color = '#ef4444';
            }
          })
          .catch(err => {
            statusElem.textContent = '❌ Network error. Please try again.';
            statusElem.style.color = '#ef4444';
          });
        }
      });
    });
  }
});

// ============================================================
//  AUTH / USER
// ============================================================
function isLoggedIn() {
  return !!window.customerToken && !!window.currentUser;
}

function updateUserUI() {
  const authLinks = document.getElementById('authLinks');
  const userMenu = document.getElementById('userMenu');
  const userNameDisplay = document.getElementById('userNameDisplay');
  const floatingWidgets = document.getElementById('floatingWidgets');
  const profileLabel = document.getElementById('profileLabel');

  if (isLoggedIn()) {
    if (authLinks) authLinks.style.display = 'none';
    if (userMenu) userMenu.style.display = 'flex';
    if (userNameDisplay) userNameDisplay.textContent = window.currentUser.name || 'User';
    if (floatingWidgets) floatingWidgets.style.display = 'flex';
    if (profileLabel) profileLabel.textContent = window.currentUser.name || 'User';
  } else {
    if (authLinks) authLinks.style.display = 'inline';
    if (userMenu) userMenu.style.display = 'none';
    if (floatingWidgets) floatingWidgets.style.display = 'none';
    if (profileLabel) profileLabel.textContent = 'Profile';
  }
  updateDropdownContent();
}

function updateDropdownContent() {
  const guestDiv = document.getElementById('dropdownGuest');
  const userDiv = document.getElementById('dropdownUser');
  const userNameSpan = document.getElementById('dropdownUserName');
  if (!guestDiv || !userDiv) return;
  if (isLoggedIn()) {
    guestDiv.style.display = 'none';
    userDiv.style.display = 'block';
    if (userNameSpan) userNameSpan.textContent = window.currentUser.name || 'User';
  } else {
    guestDiv.style.display = 'block';
    userDiv.style.display = 'none';
  }
}

function toggleProfileMenu() {
  const dropdown = document.getElementById('profileDropdown');
  if (!dropdown) return;
  if (dropdown.style.display === 'block') {
    dropdown.style.display = 'none';
  } else {
    updateDropdownContent();
    dropdown.style.display = 'block';
  }
}

document.addEventListener('click', function(e) {
  const dropdown = document.getElementById('profileDropdown');
  const btn = document.getElementById('profileBtn');
  if (dropdown && btn && !btn.contains(e.target) && !dropdown.contains(e.target)) {
    dropdown.style.display = 'none';
  }
});

async function fetchCurrentUser() {
  if (!window.customerToken) return;
  try {
    const res = await fetch('/api/auth/customer/verify', {
      headers: { 'Authorization': `Bearer ${window.customerToken}` }
    });
    if (res.ok) {
      const data = await res.json();
      setCurrentUser(data.user);
      updateUserUI();
      await loadCartFromServer();
    } else {
      setCustomerToken(null);
      setCurrentUser(null);
      updateUserUI();
    }
  } catch (err) {
    console.error('Error fetching user:', err);
  }
}

function logout() {
  setCustomerToken(null);
  setCurrentUser(null);
  if (chatSocket) {
    chatSocket.disconnect();
    chatSocket = null;
  }
  chatMessages = [];
  updateUserUI();
  closeAuthModal();
  renderGrid();
  updateCartBadge();
  updateNavCartBadge();
  const dropdown = document.getElementById('profileDropdown');
  if (dropdown) dropdown.style.display = 'none';
  if (window.location.pathname === '/account.html') {
    window.location.href = '/';
  }
}
window.logout = logout;

// ============================================================
//  AUTH MODAL
// ============================================================
function openAuthModal(tab = 'login') {
  const modal = document.getElementById('authModal');
  if (!modal) return;
  modal.classList.add('active');
  switchAuthTab(tab);
  const dropdown = document.getElementById('profileDropdown');
  if (dropdown) dropdown.style.display = 'none';
}
window.openAuthModal = openAuthModal;

function closeAuthModal() {
  const modal = document.getElementById('authModal');
  if (!modal) return;
  modal.classList.remove('active');
  const loginStatus = document.getElementById('authLoginStatus');
  const registerStatus = document.getElementById('authRegisterStatus');
  if (loginStatus) loginStatus.textContent = '';
  if (registerStatus) registerStatus.textContent = '';
}
window.closeAuthModal = closeAuthModal;

function switchAuthTab(tab) {
  const loginForm = document.getElementById('authLoginForm');
  const registerForm = document.getElementById('authRegisterForm');
  const title = document.getElementById('authModalTitle');
  if (!loginForm || !registerForm || !title) return;
  if (tab === 'login') {
    loginForm.style.display = 'block';
    registerForm.style.display = 'none';
    title.textContent = 'Login';
  } else {
    loginForm.style.display = 'none';
    registerForm.style.display = 'block';
    title.textContent = 'Create Account';
  }
}
window.switchAuthTab = switchAuthTab;

function toggleAuthPwd(inputId, btn) {
  const input = document.getElementById(inputId);
  if (!input) return;
  const icon = btn.querySelector('i');
  if (input.type === 'password') {
    input.type = 'text';
    icon.className = 'fas fa-eye-slash';
  } else {
    input.type = 'password';
    icon.className = 'fas fa-eye';
  }
}
window.toggleAuthPwd = toggleAuthPwd;

// ============================================================
//  HANDLE AUTH LOGIN
// ============================================================
async function handleAuthLogin() {
  const email = document.getElementById('authLoginEmail').value.trim();
  const password = document.getElementById('authLoginPassword').value;
  const status = document.getElementById('authLoginStatus');
  if (!status) return;
  status.textContent = '';

  if (!email || !password) {
    status.textContent = '❌ Email and password are required.';
    status.style.color = '#ef4444';
    return;
  }

  status.textContent = '⏳ Logging in...';
  status.style.color = '#2563eb';

  try {
    const res = await fetch('/api/auth/customer/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    });
    const data = await res.json();

    if (res.ok) {
      status.textContent = '✅ Logged in! Redirecting...';
      status.style.color = '#16a34a';
      localStorage.setItem('customerToken', data.token);
      localStorage.setItem('currentUser', JSON.stringify(data.customer));
      window.customerToken = data.token;
      window.currentUser = data.customer;

      setTimeout(() => {
        closeAuthModal();
        updateUserUI();
        loadCartFromServer();
        renderGrid();
        updateCartBadge();
        updateNavCartBadge();
        window.location.reload();
      }, 500);
    } else {
      status.textContent = '❌ ' + (data.error || 'Login failed');
      status.style.color = '#ef4444';
    }
  } catch (err) {
    status.textContent = '❌ Network error. Please try again.';
    status.style.color = '#ef4444';
  }
}
window.handleAuthLogin = handleAuthLogin;

// ============================================================
//  HANDLE AUTH REGISTER
// ============================================================
async function handleAuthRegister() {
  const name = document.getElementById('authRegName').value.trim();
  const email = document.getElementById('authRegEmail').value.trim();
  const password = document.getElementById('authRegPassword').value;
  const confirm = document.getElementById('authRegConfirm').value;
  const status = document.getElementById('authRegisterStatus');
  if (!status) return;
  status.textContent = '';

  if (!name || !email || !password || !confirm) {
    status.textContent = '❌ All fields are required.';
    status.style.color = '#ef4444';
    return;
  }
  if (password.length < 6) {
    status.textContent = '❌ Password must be at least 6 characters.';
    status.style.color = '#ef4444';
    return;
  }
  if (password !== confirm) {
    status.textContent = '❌ Passwords do not match.';
    status.style.color = '#ef4444';
    return;
  }

  status.textContent = '⏳ Creating account...';
  status.style.color = '#2563eb';

  try {
    const res = await fetch('/api/auth/customer/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, email, password })
    });
    const data = await res.json();

    if (res.ok) {
      status.textContent = '✅ Account created! Logging in...';
      status.style.color = '#16a34a';
      localStorage.setItem('customerToken', data.token);
      localStorage.setItem('currentUser', JSON.stringify(data.customer));
      window.customerToken = data.token;
      window.currentUser = data.customer;

      setTimeout(() => {
        closeAuthModal();
        updateUserUI();
        loadCartFromServer();
        renderGrid();
        updateCartBadge();
        updateNavCartBadge();
        window.location.reload();
      }, 500);
    } else {
      status.textContent = '❌ ' + (data.error || 'Registration failed');
      status.style.color = '#ef4444';
    }
  } catch (err) {
    status.textContent = '❌ Network error. Please try again.';
    status.style.color = '#ef4444';
  }
}
window.handleAuthRegister = handleAuthRegister;

// ============================================================
//  CART FUNCTIONS
// ============================================================
function getCart() {
  try {
    return JSON.parse(localStorage.getItem('cart')) || [];
  } catch {
    return [];
  }
}
window.getCart = getCart;

function saveCart(cart) {
  localStorage.setItem('cart', JSON.stringify(cart));
  updateCartBadge();
  syncCartToServer();
  if (window.renderCartPage) window.renderCartPage();
}
window.saveCart = saveCart;

function getCartCount() {
  const cart = getCart();
  return cart.reduce((sum, item) => sum + item.quantity, 0);
}

function updateCartBadge() {
  const badges = document.querySelectorAll('#cartBadge, #cartBadgeFloat');
  const count = getCartCount();
  badges.forEach(badge => {
    if (badge) {
      if (count > 0) {
        badge.textContent = count;
        badge.style.display = 'inline';
      } else {
        badge.style.display = 'none';
      }
    }
  });
  updateNavCartBadge();
}
window.updateCartBadge = updateCartBadge;

function updateNavCartBadge() {
  const badge = document.getElementById('navCartBadge');
  if (badge) {
    const count = getCartCount();
    if (count > 0) {
      badge.textContent = count;
      badge.classList.add('show');
    } else {
      badge.classList.remove('show');
    }
  }
}

function addToCart(productId, quantity = 1) {
  if (!isLoggedIn()) {
    openAuthModal('login');
    alert('Please login or create an account to add items to cart.');
    return;
  }
  const product = allProducts.find(p => p.id === productId);
  if (!product) {
    alert('Product not found!');
    return;
  }
  const cart = getCart();
  const existing = cart.find(item => item.id === productId && !item.variant_id);
  if (existing) {
    existing.quantity += quantity;
  } else {
    cart.push({
      id: product.id,
      variant_id: null,
      name: product.name,
      price: product.price,
      image: product.image || '',
      quantity: quantity,
      variant_name: 'Default'
    });
  }
  saveCart(cart);
  showToast(`✅ Added ${quantity} "${product.name}" to cart!`, 'success');
  updateCartBadge();
  updateModalCartButton(productId);
  renderGrid();
}
window.addToCart = addToCart;

function addToCartFromModal() {
  if (currentModalProductId) {
    addToCart(currentModalProductId, modalQty);
    modalQty = 1;
    document.getElementById('modalQty').textContent = '1';
  }
}
window.addToCartFromModal = addToCartFromModal;

function removeFromCart(productId) {
  let cart = getCart();
  cart = cart.filter(item => item.id !== productId);
  saveCart(cart);
  updateCartBadge();
  renderGrid();
  if (window.renderCartPage) window.renderCartPage();
}
window.removeFromCart = removeFromCart;

function updateCartQuantity(productId, delta) {
  const cart = getCart();
  const item = cart.find(i => i.id === productId);
  if (!item) return;
  item.quantity = Math.max(1, item.quantity + delta);
  saveCart(cart);
  updateCartBadge();
  renderGrid();
  if (window.renderCartPage) window.renderCartPage();
}
window.updateCartQuantity = updateCartQuantity;

function clearCart() {
  saveCart([]);
  updateCartBadge();
  renderGrid();
  if (window.renderCartPage) window.renderCartPage();
}
window.clearCart = clearCart;

// ============================================================
//  MODAL QUANTITY CONTROLS
// ============================================================
function changeQty(delta) {
  const newQty = modalQty + delta;
  if (newQty < 1) return;
  modalQty = newQty;
  const qtySpan = document.getElementById('modalQty');
  if (qtySpan) qtySpan.textContent = modalQty;
}
window.changeQty = changeQty;

function updateModalCartButton(productId) {
  const cart = getCart();
  const inCart = cart.some(item => item.id === productId);
  const modalBtn = document.getElementById('modalAddToCart');
  if (!modalBtn) return;
  if (inCart) {
    modalBtn.textContent = '➕ Add More';
    modalBtn.style.background = '#22c55e';
    modalBtn.onclick = addToCartFromModal;
  } else {
    modalBtn.textContent = '🛒 Add to Cart';
    modalBtn.style.background = '';
    modalBtn.onclick = addToCartFromModal;
  }
}

// ============================================================
//  CARD QUANTITY SELECTOR
// ============================================================
function changeCardQty(productId, delta) {
  const qtySpan = document.getElementById(`qty-${productId}`);
  if (!qtySpan) return;
  let current = parseInt(qtySpan.textContent) || 1;
  current = Math.max(1, current + delta);
  qtySpan.textContent = current;
}
window.changeCardQty = changeCardQty;

function addCardToCart(productId) {
  const qtySpan = document.getElementById(`qty-${productId}`);
  const qty = qtySpan ? parseInt(qtySpan.textContent) || 1 : 1;
  addToCart(productId, qty);
  if (qtySpan) qtySpan.textContent = '1';
}
window.addCardToCart = addCardToCart;

// ============================================================
//  HELPER: ROTATE PRODUCTS EVERY 12 HOURS
// ============================================================
function getRotatedProducts(products) {
  if (!products || !Array.isArray(products)) return [];
  if (products.length === 0) return products;
  const seed = Math.floor(Date.now() / (12 * 60 * 60 * 1000));
  const offset = seed % products.length;
  return products.slice(offset).concat(products.slice(0, offset));
}

// ============================================================
//  LOAD SHOP PROFILE
// ============================================================
async function loadShopProfile() {
  try {
    const res = await fetch('/api/shop');
    if (!res.ok) throw new Error('Failed to load shop');
    const shop = await res.json();
    const nameHeader = document.getElementById('shopNameHeader');
    if (nameHeader) nameHeader.textContent = shop.name || 'Our Business';

    const heroTitle = document.getElementById('heroTitle');
    const heroLocation = document.getElementById('heroLocation');
    const heroAddress = document.getElementById('heroAddress');
    const heroDesc = document.getElementById('heroDesc');
    const heroMission = document.getElementById('heroMission');
    const heroVision = document.getElementById('heroVision');
    const heroLogo = document.getElementById('heroLogo');
    const heroSection = document.getElementById('heroSection');

    if (heroTitle) heroTitle.textContent = shop.name || 'Welcome';
    if (heroLocation) heroLocation.textContent = shop.location ? `📍 ${shop.location}` : '';
    if (heroAddress) heroAddress.textContent = shop.address ? `🏠 ${shop.address}` : '';
    if (heroDesc) heroDesc.textContent = shop.description || '';
    if (heroMission) heroMission.textContent = shop.mission || 'To provide quality products with care.';
    if (heroVision) heroVision.textContent = shop.vision || 'To be the most trusted shop in the community.';

    if (heroLogo) {
      if (shop.logo && shop.logo !== '') {
        heroLogo.src = shop.logo;
        heroLogo.style.display = 'block';
      } else {
        heroLogo.style.display = 'none';
      }
    }

    if (heroSection) {
      if (shop.heroImage && shop.heroImage !== '') {
        heroSection.style.backgroundImage = `url(${shop.heroImage})`;
        heroSection.style.backgroundSize = 'cover';
        heroSection.style.backgroundPosition = 'center';
        heroSection.style.backgroundRepeat = 'no-repeat';
        heroSection.style.backgroundColor = 'transparent';
      } else {
        heroSection.style.backgroundImage = 'linear-gradient(135deg, #1e293b, #0f172a)';
      }
    }

    const mapContainer = document.getElementById('shopMap');
    const lat = parseFloat(shop.latitude);
    const lng = parseFloat(shop.longitude);
    const address = shop.address || '';
    if (mapContainer) {
      if (lat && lng && !isNaN(lat) && !isNaN(lng)) {
        if (mapInstance) mapInstance.remove();
        mapInstance = L.map('shopMap').setView([lat, lng], 15);
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
          attribution: '&copy; OpenStreetMap'
        }).addTo(mapInstance);
        L.marker([lat, lng]).addTo(mapInstance)
          .bindPopup(`<strong>${shop.name}</strong><br>${address || shop.location || ''}`);
        const mapAddress = document.getElementById('mapAddress');
        if (mapAddress) mapAddress.textContent = address ? `📍 ${address}` : '';
        window.mapInstance = mapInstance;
      } else {
        mapContainer.innerHTML = '<p style="padding:20px;text-align:center;color:#ef4444;">⚠️ No location set.</p>';
        const mapAddress = document.getElementById('mapAddress');
        if (mapAddress) mapAddress.textContent = '';
      }
    }

    const iconWhatsapp = document.getElementById('iconWhatsapp');
    const iconTiktok = document.getElementById('iconTiktok');
    const iconInstagram = document.getElementById('iconInstagram');
    const iconFacebook = document.getElementById('iconFacebook');
    const iconPhone = document.getElementById('iconPhone');
    if (iconWhatsapp) iconWhatsapp.href = shop.whatsapp ? `https://wa.me/${shop.whatsapp}` : '#';
    if (iconTiktok) iconTiktok.href = shop.tiktok ? `https://tiktok.com/@${shop.tiktok.replace('@','')}` : '#';
    if (iconInstagram) iconInstagram.href = shop.instagram ? `https://instagram.com/${shop.instagram.replace('@','')}` : '#';
    if (iconFacebook) iconFacebook.href = shop.facebook ? `https://facebook.com/messages/t/${shop.facebook.replace('@','')}` : '#';
    if (iconPhone) iconPhone.href = shop.phone ? `tel:${shop.phone}` : '#';

    localStorage.setItem('shop', JSON.stringify(shop));

    updateCartBadge();
  } catch (err) {
    console.error('❌ Error loading shop profile:', err);
  }
}

// ============================================================
//  TOAST NOTIFICATIONS
// ============================================================
function showToast(message, type = 'success') {
  const existing = document.querySelector('.toast-container');
  if (existing) existing.remove();

  const container = document.createElement('div');
  container.className = 'toast-container';
  container.style.cssText = `
    position: fixed;
    top: 20px;
    right: 20px;
    z-index: 99999;
    max-width: 400px;
    width: 100%;
  `;

  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.style.cssText = `
    background: ${type === 'success' ? '#22c55e' : type === 'error' ? '#ef4444' : type === 'warning' ? '#f59e0b' : '#2563eb'};
    color: white;
    padding: 14px 20px;
    border-radius: 12px;
    box-shadow: 0 8px 24px rgba(0,0,0,0.15);
    font-size: 0.9rem;
    font-weight: 500;
    display: flex;
    align-items: center;
    gap: 12px;
    animation: slideIn 0.3s ease;
    margin-bottom: 8px;
    transform: translateX(0);
    transition: transform 0.3s;
  `;

  const icon = document.createElement('span');
  icon.innerHTML = type === 'success' ? '✅' : type === 'error' ? '❌' : type === 'warning' ? '⚠️' : 'ℹ️';
  icon.style.fontSize = '1.2rem';

  const text = document.createElement('span');
  text.textContent = message;

  const closeBtn = document.createElement('button');
  closeBtn.innerHTML = '✕';
  closeBtn.style.cssText = `
    background: none;
    border: none;
    color: white;
    font-size: 1rem;
    cursor: pointer;
    margin-left: auto;
    opacity: 0.7;
    transition: opacity 0.2s;
  `;
  closeBtn.onmouseover = () => closeBtn.style.opacity = '1';
  closeBtn.onclick = () => {
    toast.style.transform = 'translateX(120%)';
    setTimeout(() => container.remove(), 300);
  };

  toast.appendChild(icon);
  toast.appendChild(text);
  toast.appendChild(closeBtn);
  container.appendChild(toast);
  document.body.appendChild(container);

  setTimeout(() => {
    if (document.body.contains(container)) {
      toast.style.transform = 'translateX(120%)';
      setTimeout(() => container.remove(), 300);
    }
  }, 5000);
}
window.showToast = showToast;

// Add CSS animation
const toastStyle = document.createElement('style');
toastStyle.textContent = `
  @keyframes slideIn {
    from { transform: translateX(120%); opacity: 0; }
    to { transform: translateX(0); opacity: 1; }
  }
  @keyframes slideOut {
    from { transform: translateX(0); opacity: 1; }
    to { transform: translateX(120%); opacity: 0; }
  }
`;
document.head.appendChild(toastStyle);

// ============================================================
//  LOADING SPINNER
// ============================================================
function showSpinner(element) {
  if (!element) return;
  const originalHtml = element.innerHTML;
  element.disabled = true;
  element.innerHTML = `
    <span class="spinner" style="
      display: inline-block;
      width: 16px;
      height: 16px;
      border: 2px solid rgba(255,255,255,0.3);
      border-top: 2px solid white;
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
      margin-right: 8px;
      vertical-align: middle;
    "></span>
    Loading...
  `;
  element._originalHtml = originalHtml;
  return element;
}
window.showSpinner = showSpinner;

function hideSpinner(element) {
  if (!element) return;
  element.disabled = false;
  if (element._originalHtml) {
    element.innerHTML = element._originalHtml;
  }
}
window.hideSpinner = hideSpinner;

const spinStyle = document.createElement('style');
spinStyle.textContent = `
  @keyframes spin {
    from { transform: rotate(0deg); }
    to { transform: rotate(360deg); }
  }
`;
document.head.appendChild(spinStyle);

// ============================================================
//  AUTO SOCIAL MESSAGES
// ============================================================
function getAutoSocialLinks(product) {
  const shop = JSON.parse(localStorage.getItem('shop')) || {};
  const whatsappNumber = shop.whatsapp || '';
  const instagramUser = shop.instagram || '';
  const facebookUser = shop.facebook || '';
  const tiktokUser = shop.tiktok || '';

  const productName = product.name || 'this product';
  const productPrice = product.price ? ` (${product.price})` : '';
  const message = `Hi, I'm interested in "${productName}"${productPrice}. Could I get more information about this product?`;

  const encodedMessage = encodeURIComponent(message);

  return {
    whatsapp: whatsappNumber ? `https://wa.me/${whatsappNumber.replace(/[^0-9]/g, '')}?text=${encodedMessage}` : '#',
    instagram: instagramUser ? `https://www.instagram.com/${instagramUser.replace('@', '')}/` : '#',
    messenger: facebookUser ? `https://m.me/${facebookUser.replace('@', '')}` : '#',
    tiktok: tiktokUser ? `https://www.tiktok.com/@${tiktokUser.replace('@', '')}` : '#',
    phone: shop.phone ? `tel:${shop.phone}` : '#'
  };
}
window.getAutoSocialLinks = getAutoSocialLinks;

// ============================================================
//  HERO SLIDESHOW
// ============================================================
function startHeroSlideshow() {
  if (heroImageInterval) clearInterval(heroImageInterval);
  if (heroImages.length <= 1) return;
  heroImageIndex = 0;
  heroImageInterval = setInterval(() => {
    heroImageIndex = (heroImageIndex + 1) % heroImages.length;
    const heroSection = document.getElementById('heroSection');
    if (heroSection) {
      heroSection.style.backgroundImage = `url(${heroImages[heroImageIndex]})`;
      heroSection.style.transition = 'background-image 1s ease-in-out';
    }
  }, 5000);
}

function addImageToSlideshow(imageUrl) {
  if (!imageUrl) return;
  if (!heroImages.includes(imageUrl)) {
    heroImages.push(imageUrl);
    if (heroImages.length > 1 && !heroImageInterval) {
      startHeroSlideshow();
    }
  }
}

// ============================================================
//  LOAD PRODUCTS
// ============================================================
async function loadProducts() {
  try {
    const res = await fetch('/api/products');
    if (!res.ok) {
      console.error('Failed to load products:', res.status);
      allProducts = [];
      rotatedProducts = [];
      renderGrid();
      return;
    }
    const data = await res.json();
    if (!Array.isArray(data)) {
      console.error('Products API returned invalid data:', data);
      allProducts = [];
      rotatedProducts = [];
      renderGrid();
      return;
    }
    allProducts = data;
    rotatedProducts = getRotatedProducts(allProducts);
    allProducts.forEach(p => {
      if (p.image) addImageToSlideshow(p.image);
    });
    renderSlider();
    renderGrid();
    updateCartBadge();
  } catch (err) {
    console.error('❌ Error loading products:', err);
    allProducts = [];
    rotatedProducts = [];
    renderGrid();
  }
}

// ============================================================
//  SLIDER
// ============================================================
function renderSlider() {
  const wrapper = document.getElementById('sliderWrapper');
  if (!wrapper) return;
  if (!rotatedProducts.length) {
    wrapper.innerHTML = `<div class="slide">✨ No products yet. Admin please add!</div>`;
    return;
  }
  wrapper.innerHTML = rotatedProducts.map(p => `
    <div class="slide">
      ${p.video ? `<video src="${p.video}" controls></video>` :
       p.image ? `<img src="${p.image}" alt="${p.name}" onerror="this.parentElement.innerHTML='<div>📦</div>'">` :
       `<div>📦 ${p.name}</div>`}
    </div>
  `).join('');
  currentSlide = 0;
  updateSlider();
  clearInterval(slideInterval);
  slideInterval = setInterval(() => changeSlide(1), 4000);
}

function updateSlider() {
  const wrapper = document.getElementById('sliderWrapper');
  if (!wrapper) return;
  const total = rotatedProducts.length || 1;
  wrapper.style.transform = `translateX(-${currentSlide * 100}%)`;
}

function changeSlide(direction) {
  const total = rotatedProducts.length || 1;
  currentSlide = (currentSlide + direction + total) % total;
  updateSlider();
}
window.changeSlide = changeSlide;

// ============================================================
//  PRODUCT GRID
// ============================================================
async function renderGrid() {
  const grid = document.getElementById('productGrid');
  if (!grid) return;
  if (!rotatedProducts.length) {
    grid.innerHTML = `<p style="text-align:center;padding:40px;">No products available yet.</p>`;
    return;
  }

  const variantMap = {};
  for (let product of rotatedProducts) {
    try {
      const res = await fetch(`/api/products/${product.id}/detail`);
      if (!res.ok) {
        variantMap[product.id] = [];
        continue;
      }
      const data = await res.json();
      variantMap[product.id] = data.variants || [];
    } catch (e) {
      variantMap[product.id] = [];
    }
  }

  grid.innerHTML = rotatedProducts.map(p => {
    const cart = getCart();
    const inCart = cart.some(item => item.id === p.id);
    const btnText = inCart ? 'Add More' : 'Add to Cart';
    const btnClass = inCart ? 'in-cart' : '';
    const qtyId = `qty-${p.id}`;

    let imageHtml = '';
    if (p.image) {
      imageHtml = `<img src="${p.image}" alt="${p.name}" loading="lazy" onerror="this.parentElement.innerHTML='<div style=\\'display:flex;align-items:center;justify-content:center;height:100%;background:#e2e8f0;font-size:2rem;\\'>📦</div>'">`;
    } else {
      imageHtml = `<div style="display:flex;align-items:center;justify-content:center;height:100%;background:#e2e8f0;font-size:2rem;">📦</div>`;
    }

    const variants = variantMap[p.id] || [];
    let swatchesHtml = '';
    if (variants.length > 0) {
      swatchesHtml = '<div class="variant-swatches">';
      variants.forEach(v => {
        const bg = v.image ? `url(${v.image})` : '';
        const colorLabel = v.name || '';
        swatchesHtml += `<div class="swatch" style="background-image:${bg};" title="${colorLabel}" onclick="event.stopPropagation(); location.href='/product-detail.html?id=${p.id}&variant=${v.id}'"></div>`;
      });
      swatchesHtml += '</div>';
    }

    const ratingHtml = p.rating ? `<div class="product-rating"><span>⭐</span>(${p.rating})</div>` : '';

    return `
      <div class="product-card">
        <div class="media-wrap" onclick="location.href='/product-detail.html?id=${p.id}'">
          ${imageHtml}
          <div class="quick-view-icon"><i class="fas fa-eye"></i></div>
          ${p.isFlashSale ? `<div class="flash-badge">🔥</div>` : ''}
          ${p.isNewArrival ? `<div class="new-badge">🆕</div>` : ''}
          <i id="wishlist-icon-${p.id}" class="far fa-heart" onclick="event.stopPropagation(); toggleWishlist(${p.id})" style="position:absolute; top:8px; left:8px; font-size:1.2rem; background:white; padding:4px; border-radius:50%; cursor:pointer; z-index:10;"></i>
          <div class="hover-preview">
            <div class="product-name">${p.name}</div>
            <div class="product-price">${p.price}</div>
            ${ratingHtml}
            ${swatchesHtml}
          </div>
        </div>
        <div class="info">
          <div class="name">${p.name} ${inCart ? '<span class="green-tick">✔</span>' : ''}</div>
          <div class="price">${p.price}</div>
          ${p.rating ? `<div class="rating"><span>⭐</span>(${p.rating})</div>` : ''}
          <div class="actions">
            <div class="qty-control">
              <button onclick="changeCardQty(${p.id}, -1)">−</button>
              <span id="${qtyId}">1</span>
              <button onclick="changeCardQty(${p.id}, 1)">+</button>
            </div>
            <button class="btn-add ${btnClass}" onclick="addCardToCart(${p.id})">
              <i class="fas fa-cart-plus"></i> ${btnText}
            </button>
          </div>
        </div>
      </div>
    `;
  }).join('');
}
window.renderGrid = renderGrid;

// ============================================================
//  WISHLIST TOGGLE (NEW)
// ============================================================
async function toggleWishlist(productId) {
  if (!isLoggedIn()) {
    openAuthModal('login');
    return;
  }
  try {
    const res = await fetch('/api/wishlist', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${window.customerToken}`
      },
      body: JSON.stringify({ product_id: productId })
    });
    const data = await res.json();
    if (data.success) {
      const icon = document.getElementById(`wishlist-icon-${productId}`);
      if (icon) {
        if (data.action === 'added') {
          icon.className = 'fas fa-heart';
          icon.style.color = '#ef4444';
        } else {
          icon.className = 'far fa-heart';
          icon.style.color = '';
        }
      }
      showToast(data.action === 'added' ? 'Added to wishlist ❤️' : 'Removed from wishlist', 'success');
    } else {
      showToast('Failed to update wishlist', 'error');
    }
  } catch (err) {
    console.error('Wishlist error:', err);
    showToast('Network error', 'error');
  }
}
window.toggleWishlist = toggleWishlist;

// ============================================================
//  OPEN DETAILS MODAL
// ============================================================
function openDetails(productId) {
  window.location.href = `/product-detail.html?id=${productId}`;
}
window.openDetails = openDetails;

function closeDetails() {}
window.closeDetails = closeDetails;

// ============================================================
//  CHAT FUNCTIONS
// ============================================================
function openChatWithProduct(productName) {
  if (!isLoggedIn()) {
    openAuthModal('login');
    return;
  }
  toggleChat();
  const input = document.getElementById('chatInput');
  if (input) {
    input.value = `May we talk about this ${productName}?`;
    input.focus();
  }
}
window.openChatWithProduct = openChatWithProduct;

function toggleChat() {
  const box = document.getElementById('chatBox');
  if (!box) return;
  chatOpen = !chatOpen;
  box.style.display = chatOpen ? 'flex' : 'none';
  if (chatOpen) {
    const prompt = document.getElementById('chatLoginPrompt');
    const inputArea = document.getElementById('chatInputArea');
    const header = document.getElementById('chatHeader');
    if (!isLoggedIn()) {
      if (prompt) prompt.style.display = 'flex';
      if (inputArea) inputArea.style.display = 'none';
      if (header) header.textContent = '💬 Login to Chat';
    } else {
      if (prompt) prompt.style.display = 'none';
      if (inputArea) inputArea.style.display = 'flex';
      if (header) header.textContent = '💬 Live Chat';
      if (!chatSocket) {
        chatSocket = io({ auth: { token: window.customerToken } });
        chatSocket.on('connect', () => {
          fetch('/api/chat')
            .then(res => res.json())
            .then(msgs => {
              chatMessages = msgs;
              renderChatMessages();
            });
        });
        chatSocket.on('new-chat-message', (msg) => {
          chatMessages.push(msg);
          renderChatMessages();
        });
        chatSocket.on('connect_error', (err) => {
          console.error('Socket connection error:', err);
          setCustomerToken(null);
          setCurrentUser(null);
          updateUserUI();
          toggleChat();
        });
      }
    }
  }
}
window.toggleChat = toggleChat;

function renderChatMessages() {
  const container = document.getElementById('chatMessages');
  if (!container) return;
  if (!chatMessages.length) {
    container.innerHTML = '<p style="color:#94a3b8; text-align:center;">No messages yet.</p>';
    return;
  }
  container.innerHTML = chatMessages.map(msg => {
    const sender = msg.from_user === 'Customer' ? msg.customer_name || 'Customer' : 'Seller';
    const isCustomer = msg.from_user === 'Customer';
    return `
      <div class="msg ${isCustomer ? 'customer' : 'seller'}">
        <div class="meta" style="font-size:0.65rem; opacity:0.7;">${sender} · ${new Date(msg.timestamp).toLocaleString()}</div>
        <div>${msg.message}</div>
      </div>
    `;
  }).join('');
  container.scrollTop = container.scrollHeight;
}

function sendChatMessage() {
  if (!isLoggedIn()) {
    openAuthModal('login');
    return;
  }
  const input = document.getElementById('chatInput');
  if (!input) return;
  const msg = input.value.trim();
  if (!msg) return;
  if (!chatSocket) {
    alert('Connecting to chat... please try again.');
    return;
  }
  chatSocket.emit('chat-message', { message: msg });
  input.value = '';
}
window.sendChatMessage = sendChatMessage;

// ============================================================
//  LOCATION REQUEST & STATUS
// ============================================================
async function checkLocationStatus() {
  if (!isLoggedIn()) return false;
  try {
    const res = await fetch('/api/customer/location/status', {
      headers: { 'Authorization': `Bearer ${window.customerToken}` }
    });
    if (!res.ok) return false;
    const data = await res.json();
    if (data.status === 'approved') {
      const liveSection = document.getElementById('liveLocationSection');
      if (liveSection) liveSection.style.display = 'block';
      if (!liveMapInstance) {
        const mapContainer = document.getElementById('liveMap');
        if (mapContainer) {
          liveMapInstance = L.map(mapContainer).setView([-1.2921, 36.8219], 14);
          L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
            attribution: '&copy; OpenStreetMap'
          }).addTo(liveMapInstance);
          const liveSocket = io({ auth: { token: window.customerToken } });
          liveSocket.on('admin_location', (data) => {
            const { lat, lng } = data;
            updateLiveLocation(lat, lng);
          });
          liveSocket.on('location_request_approved', () => {
            checkLocationStatus();
          });
          fetch('/api/shop').then(res => res.json()).then(shop => {
            if (shop.admin_lat && shop.admin_lng) {
              updateLiveLocation(parseFloat(shop.admin_lat), parseFloat(shop.admin_lng));
            }
          });
        }
      }
      return true;
    }
    return false;
  } catch (err) {
    console.error('Error checking location status:', err);
    return false;
  }
}

function updateLiveLocation(lat, lng) {
  if (!liveMapInstance) return;
  if (liveMarker) {
    liveMarker.setLatLng([lat, lng]);
  } else {
    liveMarker = L.marker([lat, lng], {
      icon: L.divIcon({ className: 'admin-live-marker', html: '📍', iconSize: [30, 30] })
    }).addTo(liveMapInstance);
  }
  liveMapInstance.setView([lat, lng], 15);
  if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition((pos) => {
      const userLat = pos.coords.latitude;
      const userLng = pos.coords.longitude;
      const dist = getDistance(userLat, userLng, lat, lng);
      const distText = dist < 1000 ? dist.toFixed(0) + ' m' : (dist/1000).toFixed(2) + ' km';
      const time = (dist / 1.4).toFixed(0);
      const distanceEl = document.getElementById('liveDistance');
      if (distanceEl) distanceEl.textContent = `📍 Distance: ${distText} (about ${time} seconds walk)`;
      if (liveRouteLine) {
        liveMapInstance.removeLayer(liveRouteLine);
      }
      liveRouteLine = L.polyline([[userLat, userLng], [lat, lng]], {
        color: '#2563eb',
        weight: 3,
        dashArray: '8, 5'
      }).addTo(liveMapInstance);
    }, () => {}, { enableHighAccuracy: true, timeout: 5000 });
  }
}

function getDistance(lat1, lng1, lat2, lng2) {
  const R = 6371e3;
  const φ1 = lat1 * Math.PI/180;
  const φ2 = lat2 * Math.PI/180;
  const Δφ = (lat2-lat1) * Math.PI/180;
  const Δλ = (lng2-lng1) * Math.PI/180;
  const a = Math.sin(Δφ/2)**2 + Math.cos(φ1)*Math.cos(φ2)*Math.sin(Δλ/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

// ============================================================
//  MODAL
// ============================================================
function openModal() {
  const modal = document.getElementById('loginModal');
  if (modal) modal.style.display = 'flex';
}
function closeModal() {
  const modal = document.getElementById('loginModal');
  if (modal) modal.style.display = 'none';
}
window.onclick = function(e) {
  const modal = document.getElementById('loginModal');
  if (modal && e.target === modal) closeModal();
};

// ============================================================
//  START
// ============================================================
updateUserUI();
fetchCurrentUser();
loadShopProfile();
loadProducts();
if (window.customerToken) {
  checkLocationStatus();
}

// ============================================================
//  EXPOSE FUNCTIONS GLOBALLY
// ============================================================
window.isLoggedIn = isLoggedIn;
window.updateUserUI = updateUserUI;
window.toggleProfileMenu = toggleProfileMenu;
window.logout = logout;
window.openAuthModal = openAuthModal;
window.closeAuthModal = closeAuthModal;
window.switchAuthTab = switchAuthTab;
window.toggleAuthPwd = toggleAuthPwd;
window.handleAuthLogin = handleAuthLogin;
window.handleAuthRegister = handleAuthRegister;
window.getCart = getCart;
window.saveCart = saveCart;
window.updateCartBadge = updateCartBadge;
window.updateNavCartBadge = updateNavCartBadge;
window.addToCart = addToCart;
window.addToCartFromModal = addToCartFromModal;
window.removeFromCart = removeFromCart;
window.updateCartQuantity = updateCartQuantity;
window.clearCart = clearCart;
window.changeQty = changeQty;
window.changeCardQty = changeCardQty;
window.addCardToCart = addCardToCart;
window.openDetails = openDetails;
window.closeDetails = closeDetails;
window.openChatWithProduct = openChatWithProduct;
window.toggleChat = toggleChat;
window.sendChatMessage = sendChatMessage;
window.changeSlide = changeSlide;
window.renderGrid = renderGrid;
window.checkLocationStatus = checkLocationStatus;
window.showToast = showToast;
window.showSpinner = showSpinner;
window.hideSpinner = hideSpinner;
window.getAutoSocialLinks = getAutoSocialLinks;
window.toggleWishlist = toggleWishlist;