// ===== TYPING EFFECT =====
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
let customerToken = localStorage.getItem('customerToken');
let customerName = '';
let isLocationApproved = false;
let heroImages = [];
let heroImageIndex = 0;
let heroImageInterval = null;
let currentModalProductId = null;
let modalQty = 1;

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

function saveCart(cart) {
  localStorage.setItem('cart', JSON.stringify(cart));
  updateCartBadge();
}

function getCartCount() {
  const cart = getCart();
  return cart.reduce((sum, item) => sum + item.quantity, 0);
}

function updateCartBadge() {
  const badge = document.getElementById('cartBadge');
  if (badge) {
    const count = getCartCount();
    if (count > 0) {
      badge.textContent = count;
      badge.style.display = 'inline';
    } else {
      badge.style.display = 'none';
    }
  }
  const floatBadge = document.getElementById('cartBadgeFloat');
  if (floatBadge) {
    const count = getCartCount();
    if (count > 0) {
      floatBadge.textContent = count;
      floatBadge.style.display = 'inline';
    } else {
      floatBadge.style.display = 'none';
    }
  }
}

function addToCart(productId, quantity = 1) {
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

function addToCartFromModal() {
  if (currentModalProductId) {
    addToCart(currentModalProductId, modalQty);
    modalQty = 1;
    document.getElementById('modalQty').textContent = '1';
  }
}

function removeFromCart(productId) {
  let cart = getCart();
  cart = cart.filter(item => item.id !== productId);
  saveCart(cart);
  updateCartBadge();
  renderGrid();
  if (window.renderCartPage) window.renderCartPage();
}

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

function clearCart() {
  saveCart([]);
  updateCartBadge();
  renderGrid();
  if (window.renderCartPage) window.renderCartPage();
}

// ============================================================
//  MODAL QUANTITY CONTROLS
// ============================================================
function changeQty(delta) {
  const newQty = modalQty + delta;
  if (newQty < 1) return;
  modalQty = newQty;
  document.getElementById('modalQty').textContent = modalQty;
}

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

function addCardToCart(productId) {
  const qtySpan = document.getElementById(`qty-${productId}`);
  const qty = qtySpan ? parseInt(qtySpan.textContent) || 1 : 1;
  addToCart(productId, qty);
  if (qtySpan) qtySpan.textContent = '1';
}

// ============================================================
//  HELPER: rotate products every 12 hours
// ============================================================
function getRotatedProducts(products) {
  if (!products || products.length === 0) return products;
  const seed = Math.floor(Date.now() / (12 * 60 * 60 * 1000));
  const offset = seed % products.length;
  return products.slice(offset).concat(products.slice(0, offset));
}

// ---- LOAD SHOP PROFILE ----
async function loadShopProfile() {
  try {
    const res = await fetch('/api/shop');
    const shop = await res.json();
    
    document.getElementById('shopNameHeader').textContent = shop.name || 'Our Business';
    document.getElementById('heroTitle').textContent = shop.name || 'Welcome';
    document.getElementById('heroLocation').textContent = shop.location ? `📍 ${shop.location}` : '';
    document.getElementById('heroAddress').textContent = shop.address ? `🏠 ${shop.address}` : '';
    document.getElementById('heroDesc').textContent = shop.description || '';
    document.getElementById('heroMission').textContent = shop.mission || 'To provide quality products with care.';
    document.getElementById('heroVision').textContent = shop.vision || 'To be the most trusted shop in the community.';

    const logo = document.getElementById('heroLogo');
    if (shop.logo && shop.logo !== '') {
      logo.src = shop.logo;
      logo.style.display = 'block';
    } else {
      logo.style.display = 'none';
    }
    
    const heroSection = document.getElementById('heroSection');
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

    // Static Map
    const lat = parseFloat(shop.latitude);
    const lng = parseFloat(shop.longitude);
    const address = shop.address || '';
    const mapContainer = document.getElementById('shopMap');
    if (lat && lng && !isNaN(lat) && !isNaN(lng)) {
      if (mapInstance) mapInstance.remove();
      mapInstance = L.map('shopMap').setView([lat, lng], 15);
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; OpenStreetMap'
      }).addTo(mapInstance);
      L.marker([lat, lng]).addTo(mapInstance)
        .bindPopup(`<strong>${shop.name}</strong><br>${address || shop.location || ''}`);
      document.getElementById('mapAddress').textContent = address ? `📍 ${address}` : '';
    } else {
      mapContainer.innerHTML = '<p style="padding:20px;text-align:center;color:#ef4444;">⚠️ No location set.</p>';
      document.getElementById('mapAddress').textContent = '';
    }

    // Contact Icons
    document.getElementById('iconWhatsapp').href = shop.whatsapp ? `https://wa.me/${shop.whatsapp}` : '#';
    document.getElementById('iconTiktok').href = shop.tiktok ? `https://tiktok.com/@${shop.tiktok.replace('@','')}` : '#';
    document.getElementById('iconInstagram').href = shop.instagram ? `https://instagram.com/${shop.instagram.replace('@','')}` : '#';
    document.getElementById('iconFacebook').href = shop.facebook ? `https://facebook.com/messages/t/${shop.facebook.replace('@','')}` : '#';
    document.getElementById('iconPhone').href = shop.phone ? `tel:${shop.phone}` : '#';
    
    updateCartBadge();
  } catch (err) {
    console.error('Error loading shop profile:', err);
  }
}

// ---- HERO SLIDESHOW ----
function startHeroSlideshow() {
  if (heroImageInterval) clearInterval(heroImageInterval);
  if (heroImages.length <= 1) return;
  heroImageIndex = 0;
  heroImageInterval = setInterval(() => {
    heroImageIndex = (heroImageIndex + 1) % heroImages.length;
    const heroSection = document.getElementById('heroSection');
    heroSection.style.backgroundImage = `url(${heroImages[heroImageIndex]})`;
    heroSection.style.transition = 'background-image 1s ease-in-out';
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

// ---- LOAD PRODUCTS ----
async function loadProducts() {
  try {
    const res = await fetch('/api/products');
    allProducts = await res.json();
    console.log('📦 Products loaded:', allProducts);
    rotatedProducts = getRotatedProducts(allProducts);
    allProducts.forEach(p => {
      if (p.image) addImageToSlideshow(p.image);
    });
    renderSlider();
    renderGrid();
    updateCartBadge();
  } catch (err) {
    console.error('Error loading products:', err);
  }
}

// ---- SLIDER ----
function renderSlider() {
  const wrapper = document.getElementById('sliderWrapper');
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

// ---- PRODUCT GRID (with image fallback) ----
function renderGrid() {
  const grid = document.getElementById('productGrid');
  if (!rotatedProducts.length) {
    grid.innerHTML = `<p style="text-align:center;padding:40px;">No products available yet.</p>`;
    return;
  }

  grid.innerHTML = rotatedProducts.map(p => {
    const cart = getCart();
    const inCart = cart.some(item => item.id === p.id);
    const btnText = inCart ? '➕ Add More' : '🛒 Add to Cart';
    const btnClass = inCart ? 'btn btn-success' : 'btn btn-primary';
    const tickHtml = inCart ? '<span style="color:#22c55e; font-weight:700; margin-left:6px;">✔</span>' : '';
    const qtyId = `qty-${p.id}`;
    
    // Handle image: if p.image is present, use it; else show placeholder
    let imageHtml = '';
    if (p.image) {
      imageHtml = `<img src="${p.image}" alt="${p.name}" loading="lazy" onerror="this.style.display='none';this.parentElement.innerHTML='<div style=\'display:flex;align-items:center;justify-content:center;height:100%;background:#e2e8f0;font-size:2rem;\'>📦</div>'">`;
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

// ---- OPEN DETAILS MODAL (with related products) ----
function openDetails(productId) {
  const product = allProducts.find(p => p.id === productId);
  if (!product) return;
  currentModalProductId = productId;
  modalQty = 1;
  document.getElementById('modalQty').textContent = '1';

  // ---- Populate main product ----
  const img = document.getElementById('detailImage');
  const vid = document.getElementById('detailVideo');
  if (product.image) {
    img.src = product.image;
    img.style.display = 'block';
    vid.style.display = 'none';
    // If image fails, hide it and show video fallback or placeholder
    img.onerror = function() {
      this.style.display = 'none';
    };
  } else if (product.video) {
    vid.src = product.video;
    vid.style.display = 'block';
    img.style.display = 'none';
  } else {
    img.style.display = 'none';
    vid.style.display = 'none';
  }

  document.getElementById('detailName').textContent = product.name;
  document.getElementById('detailPrice').textContent = product.price;
  document.getElementById('detailRating').textContent = product.rating ? `⭐ ${product.rating}` : '';
  document.getElementById('detailDescription').textContent = product.description || 'No description available.';
  document.getElementById('detailContact').textContent = product.contact || 'Contact seller';
  document.getElementById('detailShipping').textContent = product.shipping || '';

  document.getElementById('detailBadges').innerHTML = `
    ${product.badge1 ? `<span class="badge badge-green">${product.badge1}</span>` : ''}
    ${product.badge2 ? `<span class="badge badge-blue">${product.badge2}</span>` : ''}
    ${product.isFlashSale ? `<span class="tag tag-flash">🔥 Flash Sale</span>` : ''}
    ${product.isNewArrival ? `<span class="tag tag-new">🆕 New Arrival</span>` : ''}
  `;

  const baseUrl = window.location.origin;
  const productName = encodeURIComponent(product.name);
  const whatsappLink = `https://wa.me/?text=May%20we%20talk%20about%20this%20${productName}%3F%20View%20here%3A%20${baseUrl}`;
  document.getElementById('detailActions').innerHTML = `
    <button class="btn btn-success" onclick="openChatWithProduct('${product.name.replace(/'/g, "\\'")}')">
      <i class="fas fa-comment-dots"></i> Let's Talk
    </button>
    <a href="${whatsappLink}" target="_blank" class="btn btn-whatsapp" title="WhatsApp"><i class="fab fa-whatsapp"></i></a>
    <a href="https://tiktok.com" target="_blank" class="btn btn-tiktok" title="TikTok"><i class="fab fa-tiktok"></i></a>
    <a href="https://instagram.com" target="_blank" class="btn btn-instagram" title="Instagram"><i class="fab fa-instagram"></i></a>
    <a href="https://facebook.com" target="_blank" class="btn btn-facebook" title="Facebook"><i class="fab fa-facebook-messenger"></i></a>
    <a href="#" class="btn btn-phone" title="Call"><i class="fas fa-phone"></i></a>
  `;

  updateModalCartButton(productId);

  // ---- Fetch and display related products ----
  const container = document.getElementById('relatedProductsContainer');
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

  document.getElementById('detailModal').classList.add('active');
}

function closeDetails() {
  document.getElementById('detailModal').classList.remove('active');
  currentModalProductId = null;
}

// Close on overlay click
document.getElementById('detailModal').addEventListener('click', function(e) {
  if (e.target === this) closeDetails();
});

// ---- CHAT FUNCTIONS ----
function openChatWithProduct(productName) {
  if (!customerToken) {
    toggleChat();
    document.getElementById('chatProductName').value = productName;
  } else {
    toggleChat();
    const input = document.getElementById('chatInput');
    if (input) {
      input.value = `May we talk about this ${productName}?`;
      input.focus();
    }
  }
}

function toggleChat() {
  const box = document.getElementById('chatBox');
  chatOpen = !chatOpen;
  box.style.display = chatOpen ? 'flex' : 'none';
  if (chatOpen) {
    if (!customerToken) {
      showAuthPanel();
    } else {
      showChatPanel();
    }
  }
}

function showAuthPanel() {
  document.getElementById('authPanel').style.display = 'block';
  document.getElementById('chatMessages').style.display = 'none';
  document.getElementById('chatInputArea').style.display = 'none';
  document.getElementById('chatHeader').textContent = '💬 Login / Register';
}

function showChatPanel() {
  document.getElementById('authPanel').style.display = 'none';
  document.getElementById('chatMessages').style.display = 'flex';
  document.getElementById('chatInputArea').style.display = 'flex';
  document.getElementById('chatHeader').textContent = '💬 Live Chat';
  if (!chatSocket) {
    chatSocket = io({ auth: { token: customerToken } });
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
      localStorage.removeItem('customerToken');
      customerToken = null;
      showAuthPanel();
    });
  }
}

function renderChatMessages() {
  const container = document.getElementById('chatMessages');
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
  if (!customerToken) {
    showAuthPanel();
    return;
  }
  const input = document.getElementById('chatInput');
  const msg = input.value.trim();
  if (!msg) return;
  if (!chatSocket) {
    alert('Connecting to chat... please try again.');
    return;
  }
  chatSocket.emit('chat-message', { message: msg });
  input.value = '';
}

// ---- CUSTOMER AUTH ----
async function customerRegister() {
  const name = document.getElementById('regName').value.trim();
  const email = document.getElementById('regEmail').value.trim();
  const password = document.getElementById('regPassword').value;
  const confirm = document.getElementById('regConfirm').value;
  const status = document.getElementById('authStatus');
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
      status.textContent = '✅ Registration successful! Logging in...';
      status.style.color = '#16a34a';
      localStorage.setItem('customerToken', data.token);
      customerToken = data.token;
      customerName = data.customer.name;
      checkLocationStatus();
      setTimeout(() => showChatPanel(), 500);
    } else {
      status.textContent = '❌ ' + (data.error || 'Registration failed');
      status.style.color = '#ef4444';
    }
  } catch (err) {
    status.textContent = '❌ Network error. Please try again.';
    status.style.color = '#ef4444';
  }
}

async function customerLogin() {
  const email = document.getElementById('loginEmail').value.trim();
  const password = document.getElementById('loginPassword').value;
  const status = document.getElementById('authStatus');
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
      localStorage.setItem('customerToken', data.token);
      customerToken = data.token;
      customerName = data.customer.name;
      checkLocationStatus();
      setTimeout(() => showChatPanel(), 500);
    } else {
      status.textContent = '❌ ' + (data.error || 'Login failed');
      status.style.color = '#ef4444';
    }
  } catch (err) {
    status.textContent = '❌ Network error. Please try again.';
    status.style.color = '#ef4444';
  }
}

function logoutChat() {
  localStorage.removeItem('customerToken');
  customerToken = null;
  if (chatSocket) {
    chatSocket.disconnect();
    chatSocket = null;
  }
  chatMessages = [];
  showAuthPanel();
}

// ---- LOCATION REQUEST ----
document.getElementById('requestLocationBtn').addEventListener('click', async function() {
  const btn = this;
  const statusElem = document.getElementById('locationRequestStatus');
  if (!customerToken) {
    statusElem.textContent = '❌ Please login or create an account first.';
    statusElem.style.color = '#ef4444';
    toggleChat();
    return;
  }
  btn.disabled = true;
  statusElem.textContent = '⏳ Sending request...';
  statusElem.style.color = '#2563eb';
  try {
    const res = await fetch('/api/customer/location/request', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${customerToken}` }
    });
    const data = await res.json();
    if (res.ok && data.alreadyApproved) {
      statusElem.textContent = '✅ You already have access to the seller\'s location!';
      statusElem.style.color = '#16a34a';
      isLocationApproved = true;
      showLiveLocation();
    } else if (res.ok) {
      statusElem.textContent = '✅ Request sent! Waiting for admin approval.';
      statusElem.style.color = '#16a34a';
    } else {
      statusElem.textContent = '❌ ' + (data.error || 'Request failed');
      statusElem.style.color = '#ef4444';
    }
  } catch (err) {
    statusElem.textContent = '❌ Network error. Please try again.';
    statusElem.style.color = '#ef4444';
  } finally {
    btn.disabled = false;
  }
});

async function checkLocationStatus() {
  if (!customerToken) return;
  try {
    const res = await fetch('/api/customer/location/status', {
      headers: { 'Authorization': `Bearer ${customerToken}` }
    });
    const data = await res.json();
    if (data.status === 'approved') {
      isLocationApproved = true;
      document.getElementById('locationRequestStatus').textContent = '✅ Location sharing approved!';
      document.getElementById('locationRequestStatus').style.color = '#16a34a';
      showLiveLocation();
    }
  } catch (err) {
    console.error('Error checking location status:', err);
  }
}

function showLiveLocation() {
  document.getElementById('liveLocationSection').style.display = 'block';
  if (!liveMapInstance) {
    const mapContainer = document.getElementById('liveMap');
    liveMapInstance = L.map(mapContainer).setView([-1.2921, 36.8219], 14);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap'
    }).addTo(liveMapInstance);
    const liveSocket = io({ auth: { token: customerToken } });
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
      document.getElementById('liveDistance').textContent = `📍 Distance: ${distText} (about ${time} seconds walk)`;
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

// ---- MODAL ----
function openModal() { document.getElementById('loginModal').style.display = 'flex'; }
function closeModal() { document.getElementById('loginModal').style.display = 'none'; }
window.onclick = function(e) {
  const modal = document.getElementById('loginModal');
  if (e.target === modal) closeModal();
};

// ---- START ----
loadShopProfile();
loadProducts();
if (customerToken) {
  checkLocationStatus();
}