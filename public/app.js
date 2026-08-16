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

// Re-usable setter to keep window in sync
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

// Load initial user from localStorage
const storedUser = localStorage.getItem('currentUser');
if (storedUser) {
  try {
    window.currentUser = JSON.parse(storedUser);
  } catch (e) {}
}
if (window.customerToken) {
  // will be verified later
}

// ============================================================
//  TYPING EFFECT
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

// Close dropdown on outside click
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

async function handleAuthLogin() {
  const email = document.getElementById('authLoginEmail').value.trim();
  const password = document.getElementById('authLoginPassword').value;
  const status = document.getElementById('authLoginStatus');
  if (!status) return;
  status.textContent = '';
  if (!email || !password) {
    status.textContent = 'Email and password are required.';
    status.style.color = '#ef4444';
    return;
  }
  status.textContent = 'Logging in...';
  status.style.color = '#2563eb';
  try {
    const res = await fetch('/api/auth/customer/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    });
    const data = await res.json();
    if (res.ok) {
      status.textContent = '✅ Logged in!';
      status.style.color = '#16a34a';
      setCustomerToken(data.token);
      setCurrentUser(data.customer);
      updateUserUI();
      closeAuthModal();
      renderGrid();
      updateCartBadge();
      if (chatOpen) {
        showChatPanel();
      }
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

async function handleAuthRegister() {
  const name = document.getElementById('authRegName').value.trim();
  const email = document.getElementById('authRegEmail').value.trim();
  const password = document.getElementById('authRegPassword').value;
  const confirm = document.getElementById('authRegConfirm').value;
  const status = document.getElementById('authRegisterStatus');
  if (!status) return;
  status.textContent = '';
  if (!name || !email || !password || !confirm) {
    status.textContent = 'All fields are required.';
    status.style.color = '#ef4444';
    return;
  }
  if (password.length < 6) {
    status.textContent = 'Password must be at least 6 characters.';
    status.style.color = '#ef4444';
    return;
  }
  if (password !== confirm) {
    status.textContent = 'Passwords do not match.';
    status.style.color = '#ef4444';
    return;
  }
  status.textContent = 'Creating account...';
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
      setCustomerToken(data.token);
      setCurrentUser(data.customer);
      updateUserUI();
      closeAuthModal();
      renderGrid();
      updateCartBadge();
      if (chatOpen) {
        showChatPanel();
      }
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
}
window.updateCartBadge = updateCartBadge;

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
  const existing = cart.find(item => item.id === productId);
  if (existing) {
    existing.quantity += quantity;
  } else {
    cart.push({
      id: product.id,
      name: product.name,
      price: product.price,
      image: product.image || '',
      quantity: quantity
    });
  }
  saveCart(cart);
  alert(`✅ Added ${quantity} "${product.name}" to cart!`);
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
  if (!products || products.length === 0) return products;
  const seed = Math.floor(Date.now() / (12 * 60 * 60 * 1000));
  const offset = seed % products.length;
  return products.slice(offset).concat(products.slice(0, offset));
}

// ============================================================
//  LOAD SHOP PROFILE
// ============================================================
async function loadShopProfile() {
  try {
    console.log('🔄 Fetching shop profile...');
    const res = await fetch('/api/shop');
    const shop = await res.json();
    console.log('📦 Shop data received:', shop);

    // Update header shop name
    const nameHeader = document.getElementById('shopNameHeader');
    if (nameHeader) nameHeader.textContent = shop.name || 'Our Business';

    // Hero elements – only exist on index.html, so check for null
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
        console.log('✅ Hero image found:', shop.heroImage);
        heroSection.style.backgroundImage = `url(${shop.heroImage})`;
        heroSection.style.backgroundSize = 'cover';
        heroSection.style.backgroundPosition = 'center';
        heroSection.style.backgroundRepeat = 'no-repeat';
        heroSection.style.backgroundColor = 'transparent';
      } else {
        console.warn('⚠️ No hero image, using gradient fallback');
        heroSection.style.backgroundImage = 'linear-gradient(135deg, #1e293b, #0f172a)';
      }
    }

    // Static Map
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
      } else {
        mapContainer.innerHTML = '<p style="padding:20px;text-align:center;color:#ef4444;">⚠️ No location set.</p>';
        const mapAddress = document.getElementById('mapAddress');
        if (mapAddress) mapAddress.textContent = '';
      }
    }

    // Contact Icons
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

    updateCartBadge();
  } catch (err) {
    console.error('❌ Error loading shop profile:', err);
  }
}

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
    console.log('🔄 Fetching products...');
    const res = await fetch('/api/products');
    allProducts = await res.json();
    console.log('📦 Products loaded:', allProducts.length, 'items');
    rotatedProducts = getRotatedProducts(allProducts);
    allProducts.forEach(p => {
      if (p.image) addImageToSlideshow(p.image);
    });
    renderSlider();
    renderGrid();
    updateCartBadge();
  } catch (err) {
    console.error('❌ Error loading products:', err);
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
function renderGrid() {
  const grid = document.getElementById('productGrid');
  if (!grid) return;
  if (!rotatedProducts.length) {
    grid.innerHTML = `<p style="text-align:center;padding:40px;">No products available yet.</p>`;
    return;
  }

  grid.innerHTML = rotatedProducts.map(p => {
    const cart = getCart();
    const inCart = cart.some(item => item.id === p.id);
    const btnText = inCart ? '➕ Add More' : '🛒 Add to Cart';
    const btnClass = inCart ? 'btn btn-success' : 'btn btn-primary';
    const tickHtml = inCart ? '<span class="green-tick">✔</span>' : '';
    const qtyId = `qty-${p.id}`;

    let imageHtml = '';
    if (p.image) {
      imageHtml = `<img src="${p.image}" alt="${p.name}" loading="lazy" onerror="this.style.display='none';this.parentElement.innerHTML='<div style=\\'display:flex;align-items:center;justify-content:center;height:100%;background:#e2e8f0;font-size:2rem;\\'>📦</div>'">`;
    } else {
      imageHtml = `<div style="display:flex;align-items:center;justify-content:center;height:100%;background:#e2e8f0;font-size:2rem;">📦</div>`;
    }

    return `
      <div class="product-card">
        <div class="media-wrap">
          ${p.video ? `<video src="${p.video}" controls></video>` : imageHtml}
          ${p.isFlashSale ? `<div class="flash-badge">🔥</div>` : ''}
          ${p.isNewArrival ? `<div class="new-badge">🆕</div>` : ''}
        </div>
        <div class="info">
          <div class="name">${p.name} ${tickHtml}</div>
          <div class="price">${p.price}</div>
          ${p.rating ? `<div class="rating"><span>⭐</span>(${p.rating})</div>` : ''}
          <div style="display:flex; align-items:center; gap:6px; flex-wrap:nowrap; margin-top:6px;">
            <button class="btn btn-details" onclick="openDetails(${p.id})">See Details</button>
            <div style="display:flex; align-items:center; gap:4px; background:#f1f5f9; border-radius:30px; padding:2px 6px; flex-shrink:0;">
              <button onclick="changeCardQty(${p.id}, -1)" style="width:24px; height:24px; border-radius:50%; border:1px solid #d1d5db; background:white; font-size:1rem; cursor:pointer; line-height:1;">−</button>
              <span id="${qtyId}" style="font-weight:700; min-width:20px; text-align:center;">1</span>
              <button onclick="changeCardQty(${p.id}, 1)" style="width:24px; height:24px; border-radius:50%; border:1px solid #d1d5db; background:white; font-size:1rem; cursor:pointer; line-height:1;">+</button>
            </div>
            <button class="${btnClass}" style="font-size:0.75rem; padding:4px 12px; white-space:nowrap;" onclick="addCardToCart(${p.id})">
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
//  OPEN DETAILS MODAL
// ============================================================
function openDetails(productId) {
  const product = allProducts.find(p => p.id === productId);
  if (!product) return;
  currentModalProductId = productId;
  modalQty = 1;
  const qtySpan = document.getElementById('modalQty');
  if (qtySpan) qtySpan.textContent = '1';

  const img = document.getElementById('detailImage');
  const vid = document.getElementById('detailVideo');
  if (img && vid) {
    if (product.image) {
      img.src = product.image;
      img.style.display = 'block';
      vid.style.display = 'none';
      img.onerror = function() { this.style.display = 'none'; };
    } else if (product.video) {
      vid.src = product.video;
      vid.style.display = 'block';
      img.style.display = 'none';
    } else {
      img.style.display = 'none';
      vid.style.display = 'none';
    }
  }

  const nameEl = document.getElementById('detailName');
  const priceEl = document.getElementById('detailPrice');
  const ratingEl = document.getElementById('detailRating');
  const descEl = document.getElementById('detailDescription');
  const contactEl = document.getElementById('detailContact');
  const shippingEl = document.getElementById('detailShipping');
  const badgesEl = document.getElementById('detailBadges');
  const actionsEl = document.getElementById('detailActions');

  if (nameEl) nameEl.textContent = product.name;
  if (priceEl) priceEl.textContent = product.price;
  if (ratingEl) ratingEl.textContent = product.rating ? `⭐ ${product.rating}` : '';
  if (descEl) descEl.textContent = product.description || 'No description available.';
  if (contactEl) contactEl.textContent = product.contact || 'Contact seller';
  if (shippingEl) shippingEl.textContent = product.shipping || '';

  if (badgesEl) {
    badgesEl.innerHTML = `
      ${product.badge1 ? `<span class="badge badge-green">${product.badge1}</span>` : ''}
      ${product.badge2 ? `<span class="badge badge-blue">${product.badge2}</span>` : ''}
      ${product.isFlashSale ? `<span class="tag tag-flash">🔥 Flash Sale</span>` : ''}
      ${product.isNewArrival ? `<span class="tag tag-new">🆕 New Arrival</span>` : ''}
    `;
  }

  const baseUrl = window.location.origin;
  const productName = encodeURIComponent(product.name);
  const whatsappLink = `https://wa.me/?text=May%20we%20talk%20about%20this%20${productName}%3F%20View%20here%3A%20${baseUrl}`;
  if (actionsEl) {
    actionsEl.innerHTML = `
      <button class="btn btn-success" onclick="openChatWithProduct('${product.name.replace(/'/g, "\\'")}')">
        <i class="fas fa-comment-dots"></i> Let's Talk
      </button>
      <a href="${whatsappLink}" target="_blank" class="btn btn-whatsapp" title="WhatsApp"><i class="fab fa-whatsapp"></i></a>
      <a href="https://tiktok.com" target="_blank" class="btn btn-tiktok" title="TikTok"><i class="fab fa-tiktok"></i></a>
      <a href="https://instagram.com" target="_blank" class="btn btn-instagram" title="Instagram"><i class="fab fa-instagram"></i></a>
      <a href="https://facebook.com" target="_blank" class="btn btn-facebook" title="Facebook"><i class="fab fa-facebook-messenger"></i></a>
      <a href="#" class="btn btn-phone" title="Call"><i class="fas fa-phone"></i></a>
    `;
  }

  updateModalCartButton(productId);

  const container = document.getElementById('relatedProductsContainer');
  if (container) {
    container.innerHTML = '<p style="color:#94a3b8;">Loading related products...</p>';
    fetch(`/api/products/${productId}/related`)
      .then(res => res.json())
      .then(related => {
        if (!related || related.length === 0) {
          container.innerHTML = '<p style="color:#94a3b8;">No related products found.</p>';
          return;
        }
        container.innerHTML = related.map(p => `
          <div class="related-item" onclick="openDetails(${p.id})">
            ${p.image ? `<img src="${p.image}" alt="${p.name}" loading="lazy" onerror="this.parentElement.innerHTML='<div class=\\'no-image\\'>📦</div>'">` : `<div class="no-image">📦</div>`}
            <div class="related-info">
              <div class="related-name">${p.name}</div>
              <div class="related-price">${p.price}</div>
              <button class="btn btn-details" onclick="event.stopPropagation(); openDetails(${p.id})">See Details</button>
            </div>
          </div>
        `).join('');
      })
      .catch(err => {
        console.error('Error fetching related products:', err);
        container.innerHTML = '<p style="color:#94a3b8;">Could not load related products.</p>';
      });
  }

  const modal = document.getElementById('detailModal');
  if (modal) modal.classList.add('active');
}
window.openDetails = openDetails;

function closeDetails() {
  const modal = document.getElementById('detailModal');
  if (modal) modal.classList.remove('active');
  currentModalProductId = null;
}
window.closeDetails = closeDetails;

document.getElementById('detailModal')?.addEventListener('click', function(e) {
  if (e.target === this) closeDetails();
});

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
      <div style="background: ${isCustomer ? '#2563eb' : '#e2e8f0'};
                  color: ${isCustomer ? 'white' : '#1e293b'};
                  padding: 8px 14px; border-radius: 18px; max-width: 80%; align-self: ${isCustomer ? 'flex-end' : 'flex-start'};">
        <div style="font-size:0.65rem; opacity:0.7;">${sender} · ${new Date(msg.timestamp).toLocaleString()}</div>
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
//  LOCATION REQUEST
// ============================================================
document.getElementById('requestLocationBtn')?.addEventListener('click', async function() {
  if (!isLoggedIn()) {
    openAuthModal('login');
    return;
  }
  const btn = this;
  const statusElem = document.getElementById('locationRequestStatus');
  btn.disabled = true;
  if (statusElem) statusElem.textContent = '⏳ Sending request...';
  try {
    const res = await fetch('/api/customer/location/request', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${window.customerToken}` }
    });
    const data = await res.json();
    if (res.ok && data.alreadyApproved) {
      if (statusElem) {
        statusElem.textContent = '✅ You already have access to the seller\'s location!';
        statusElem.style.color = '#16a34a';
      }
      isLocationApproved = true;
      showLiveLocation();
    } else if (res.ok) {
      if (statusElem) {
        statusElem.textContent = '✅ Request sent! Waiting for admin approval.';
        statusElem.style.color = '#16a34a';
      }
    } else {
      if (statusElem) {
        statusElem.textContent = '❌ ' + (data.error || 'Request failed');
        statusElem.style.color = '#ef4444';
      }
    }
  } catch (err) {
    if (statusElem) {
      statusElem.textContent = '❌ Network error. Please try again.';
      statusElem.style.color = '#ef4444';
    }
  } finally {
    btn.disabled = false;
  }
});

async function checkLocationStatus() {
  if (!isLoggedIn()) return;
  try {
    const res = await fetch('/api/customer/location/status', {
      headers: { 'Authorization': `Bearer ${window.customerToken}` }
    });
    const data = await res.json();
    if (data.status === 'approved') {
      isLocationApproved = true;
      const statusElem = document.getElementById('locationRequestStatus');
      if (statusElem) {
        statusElem.textContent = '✅ Location sharing approved!';
        statusElem.style.color = '#16a34a';
      }
      showLiveLocation();
    }
  } catch (err) {
    console.error('Error checking location status:', err);
  }
}

function showLiveLocation() {
  const section = document.getElementById('liveLocationSection');
  if (section) section.style.display = 'block';
  if (!liveMapInstance) {
    const mapContainer = document.getElementById('liveMap');
    if (!mapContainer) return;
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
//  EXPOSE FUNCTIONS GLOBALLY (for inline onclick events)
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