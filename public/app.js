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
});

let allProducts = [];
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
let requestStatus = 'none';

// ---- LOAD SHOP PROFILE ----
async function loadShopProfile() {
  const res = await fetch('/api/shop');
  const shop = await res.json();
  
  document.getElementById('shopNameHeader').textContent = shop.name || 'Our Business';
  document.getElementById('heroTitle').textContent = shop.name || 'Welcome';
  document.getElementById('heroLocation').textContent = shop.location ? `📍 ${shop.location}` : '';
  document.getElementById('heroAddress').textContent = shop.address ? `🏠 ${shop.address}` : '';
  document.getElementById('heroDesc').textContent = shop.description || '';
  document.getElementById('heroMission').textContent = shop.mission || '-';
  document.getElementById('heroVision').textContent = shop.vision || '-';
  
  const logo = document.getElementById('heroLogo');
  if (shop.logo) logo.src = shop.logo;
  else logo.style.display = 'none';
  
  const heroSection = document.getElementById('heroSection');
  if (shop.heroImage) {
    heroSection.style.backgroundImage = `url(${shop.heroImage})`;
  } else {
    heroSection.style.backgroundImage = 'linear-gradient(135deg, #1e293b, #0f172a)';
  }

  // Map
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
}

// ---- LOAD PRODUCTS ----
async function loadProducts() {
  const res = await fetch('/api/products');
  allProducts = await res.json();
  renderSlider();
  renderGrid();
}

function renderSlider() {
  const wrapper = document.getElementById('sliderWrapper');
  if (!allProducts.length) {
    wrapper.innerHTML = `<div class="slide">✨ No products yet. Admin please add!</div>`;
    return;
  }
  wrapper.innerHTML = allProducts.map(p => `
    <div class="slide">
      ${p.video ? `<video src="${p.video}" controls></video>` : 
       p.image ? `<img src="${p.image}" alt="${p.name}">` : 
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
  const total = allProducts.length || 1;
  wrapper.style.transform = `translateX(-${currentSlide * 100}%)`;
}

function changeSlide(direction) {
  const total = allProducts.length || 1;
  currentSlide = (currentSlide + direction + total) % total;
  updateSlider();
}

function renderGrid() {
  const grid = document.getElementById('productGrid');
  if (!allProducts.length) {
    grid.innerHTML = `<p style="text-align:center;padding:40px;">No products available yet.</p>`;
    return;
  }

  const baseUrl = window.location.origin;

  grid.innerHTML = allProducts.map(p => {
    const productName = encodeURIComponent(p.name);
    const whatsappLink = `https://wa.me/?text=May%20we%20talk%20about%20this%20${productName}%3F%20View%20here%3A%20${baseUrl}`;
    const tiktokLink = `https://tiktok.com`;
    const instagramLink = `https://instagram.com`;
    const facebookLink = `https://facebook.com`;
    const phoneLink = `#`;

    let badgesHtml = '';
    if (p.badge1) badgesHtml += `<span class="badge badge-green">${p.badge1}</span>`;
    if (p.badge2) badgesHtml += `<span class="badge badge-blue">${p.badge2}</span>`;
    let tagsHtml = '';
    if (p.isFlashSale) tagsHtml += `<span class="tag tag-flash">🔥 Flash Sale</span>`;
    if (p.isNewArrival) tagsHtml += `<span class="tag tag-new">🆕 New Arrival</span>`;

    return `
      <div class="product-card">
        <div class="media-wrap">
          ${p.video ? `<video src="${p.video}" controls></video>` : 
           p.image ? `<img src="${p.image}" alt="${p.name}" loading="lazy">` : 
           `<div style="display:flex;align-items:center;justify-content:center;height:100%;background:#e2e8f0;">📦</div>`}
        </div>
        <div class="info">
          <div class="name">${p.name}</div>
          <div class="price">${p.price}</div>
          ${p.rating ? `<div class="rating"><span>⭐</span>(${p.rating})</div>` : ''}
          ${badgesHtml ? `<div class="badges">${badgesHtml}</div>` : ''}
          ${tagsHtml ? `<div class="product-tags">${tagsHtml}</div>` : ''}
          ${p.shipping ? `<div class="shipping">🚚 ${p.shipping}</div>` : ''}
          
          <div class="actions">
            <button class="btn btn-success" onclick="openChatWithProduct('${p.name.replace(/'/g, "\\'")}')">
              <i class="fas fa-comment-dots"></i> Let's Talk
            </button>
            <a href="${whatsappLink}" target="_blank" class="btn btn-whatsapp" title="WhatsApp"><i class="fab fa-whatsapp"></i></a>
            <a href="${tiktokLink}" target="_blank" class="btn btn-tiktok" title="TikTok"><i class="fab fa-tiktok"></i></a>
            <a href="${instagramLink}" target="_blank" class="btn btn-instagram" title="Instagram"><i class="fab fa-instagram"></i></a>
            <a href="${facebookLink}" target="_blank" class="btn btn-facebook" title="Facebook"><i class="fab fa-facebook-messenger"></i></a>
            <a href="${phoneLink}" class="btn btn-phone" title="Call"><i class="fas fa-phone"></i></a>
          </div>
        </div>
      </div>
    `;
  }).join('');
}

// ---- CHAT FUNCTIONS (same as before, with customer auth) ----
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
    chatSocket = io({
      auth: { token: customerToken }
    });
    chatSocket.on('connect', () => {
      console.log('Chat connected');
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

// ---- CUSTOMER AUTH for Chat ----
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
      checkLocationStatus(); // check if already approved
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
  // Connect to socket to receive admin location updates
  if (!liveMapInstance) {
    const mapContainer = document.getElementById('liveMap');
    // Set initial view to shop location (or admin's last location)
    liveMapInstance = L.map(mapContainer).setView([-1.2921, 36.8219], 14);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap'
    }).addTo(liveMapInstance);
    // Connect socket for location updates
    const liveSocket = io({ auth: { token: customerToken } });
    liveSocket.on('admin_location', (data) => {
      const { lat, lng } = data;
      updateLiveLocation(lat, lng);
    });
    liveSocket.on('location_request_approved', () => {
      // This also triggers when admin approves
      checkLocationStatus();
    });
    // Also request current admin location from shop
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
    liveMarker = L.marker([lat, lng]).addTo(liveMapInstance);
  }
  liveMapInstance.setView([lat, lng], 15);

  // Calculate distance from customer (if we have their location)
  if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition((pos) => {
      const userLat = pos.coords.latitude;
      const userLng = pos.coords.longitude;
      const dist = getDistance(userLat, userLng, lat, lng);
      const distText = dist < 1000 ? dist.toFixed(0) + ' m' : (dist/1000).toFixed(2) + ' km';
      const time = (dist / 1.4).toFixed(0);
      document.getElementById('liveDistance').textContent = `📍 Distance: ${distText} (about ${time} seconds walk)`;
      // Draw route line
      if (liveRouteLine) {
        liveMapInstance.removeLayer(liveRouteLine);
      }
      liveRouteLine = L.polyline([[userLat, userLng], [lat, lng]], { color: 'blue', weight: 4 }).addTo(liveMapInstance);
    });
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

// ---- START ----
loadShopProfile();
loadProducts();
if (customerToken) {
  checkLocationStatus();
}