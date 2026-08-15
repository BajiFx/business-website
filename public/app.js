let allProducts = [];
let currentSlide = 0;
let slideInterval;
let mapInstance = null;
let chatSocket = null;
let chatOpen = false;
let chatMessages = [];
let shopData = null; // store shop profile globally

// ---- LOAD SHOP PROFILE ----
async function loadShopProfile() {
  const res = await fetch('/api/shop');
  shopData = await res.json();
  
  document.getElementById('shopNameHeader').textContent = shopData.name || 'Our Business';
  document.getElementById('heroTitle').textContent = shopData.name || 'Welcome';
  document.getElementById('heroLocation').textContent = shopData.location ? `📍 ${shopData.location}` : '';
  document.getElementById('heroAddress').textContent = shopData.address ? `🏠 ${shopData.address}` : '';
  document.getElementById('heroDesc').textContent = shopData.description || '';
  document.getElementById('heroMission').textContent = shopData.mission || '-';
  document.getElementById('heroVision').textContent = shopData.vision || '-';
  
  const logo = document.getElementById('heroLogo');
  if (shopData.logo) logo.src = shopData.logo;
  else logo.style.display = 'none';
  
  const heroSection = document.getElementById('heroSection');
  if (shopData.heroImage) heroSection.style.backgroundImage = `url(${shopData.heroImage})`;
  else heroSection.style.backgroundImage = 'linear-gradient(135deg, #1e293b, #0f172a)';

  // ---- Map ----
  const lat = parseFloat(shopData.latitude);
  const lng = parseFloat(shopData.longitude);
  const address = shopData.address || '';
  const mapContainer = document.getElementById('shopMap');
  if (lat && lng && !isNaN(lat) && !isNaN(lng)) {
    if (mapInstance) mapInstance.remove();
    mapInstance = L.map('shopMap').setView([lat, lng], 15);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap'
    }).addTo(mapInstance);
    L.marker([lat, lng]).addTo(mapInstance)
      .bindPopup(`<strong>${shopData.name}</strong><br>${address || shopData.location || ''}`);
    document.getElementById('mapAddress').textContent = address ? `📍 ${address}` : '';
  } else {
    mapContainer.innerHTML = '<p style="padding:20px;text-align:center;color:#ef4444;">⚠️ No location set. Please ask the seller to update the shop location in the admin panel.</p>';
    document.getElementById('mapAddress').textContent = '';
  }

  // ---- Contact Icons (below products) ----
  // WhatsApp – direct chat link
  const whatsappNum = shopData.whatsapp || '';
  document.getElementById('iconWhatsapp').href = whatsappNum ? `https://wa.me/${whatsappNum}` : '#';
  
  // TikTok – direct message link (opens messaging)
  const tiktokUser = shopData.tiktok ? shopData.tiktok.replace('@','') : '';
  document.getElementById('iconTiktok').href = tiktokUser ? `https://www.tiktok.com/@${tiktokUser}` : '#';
  
  // Instagram – direct message link (opens DM)
  const instagramUser = shopData.instagram ? shopData.instagram.replace('@','') : '';
  document.getElementById('iconInstagram').href = instagramUser ? `https://www.instagram.com/direct/inbox/` : '#';
  // Note: Instagram direct messaging requires the user to be logged in and the seller must have an Instagram Business account.
  // We'll use the profile link as fallback, but the user will land on the messaging area if they're logged in.
  
  // Facebook – direct message link
  const facebookUser = shopData.facebook ? shopData.facebook.replace('@','') : '';
  document.getElementById('iconFacebook').href = facebookUser ? `https://www.facebook.com/messages/t/${facebookUser}` : '#';
  
  // Phone
  document.getElementById('iconPhone').href = shopData.phone ? `tel:${shopData.phone}` : '#';
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

  // Base URL for sharing (current page)
  const baseUrl = window.location.origin + window.location.pathname;

  grid.innerHTML = allProducts.map(p => {
    const productName = encodeURIComponent(p.name);
    const productNamePlain = p.name;
    
    // ---- Build social messaging links ----
    // WhatsApp – direct to chat with pre-filled message
    const sellerWhatsApp = shopData && shopData.whatsapp ? shopData.whatsapp : '';
    const whatsappLink = sellerWhatsApp 
      ? `https://wa.me/${sellerWhatsApp}?text=May%20we%20talk%20about%20this%20${productName}%3F%20View%20here%3A%20${baseUrl}`
      : `https://wa.me/?text=May%20we%20talk%20about%20this%20${productName}%3F%20View%20here%3A%20${baseUrl}`;
    
    // TikTok – direct to seller's profile (messaging area if available)
    const tiktokUser = shopData && shopData.tiktok ? shopData.tiktok.replace('@','') : '';
    const tiktokLink = tiktokUser 
      ? `https://www.tiktok.com/@${tiktokUser}` 
      : 'https://www.tiktok.com';
    
    // Instagram – direct to messaging (DM) or profile
    const instagramUser = shopData && shopData.instagram ? shopData.instagram.replace('@','') : '';
    // Instagram direct messaging link – opens DM if user is logged in
    const instagramLink = instagramUser 
      ? `https://www.instagram.com/direct/t/${instagramUser}` 
      : 'https://www.instagram.com';
    
    // Facebook – direct to messaging
    const facebookUser = shopData && shopData.facebook ? shopData.facebook.replace('@','') : '';
    const facebookLink = facebookUser 
      ? `https://www.facebook.com/messages/t/${facebookUser}` 
      : 'https://www.facebook.com';
    
    // Phone
    const phoneLink = shopData && shopData.phone ? `tel:${shopData.phone}` : '#';

    // Badges & tags
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
           p.image ? `<img src="${p.image}" alt="${p.name}">` : 
           `<div style="display:flex;align-items:center;justify-content:center;height:100%;background:#e2e8f0;">📦</div>`}
        </div>
        <div class="info">
          <div class="name">${p.name}</div>
          <div class="price">${p.price}</div>
          ${p.rating ? `<div class="rating"><span>⭐</span>(${p.rating})</div>` : ''}
          ${badgesHtml ? `<div class="badges">${badgesHtml}</div>` : ''}
          ${tagsHtml ? `<div class="product-tags">${tagsHtml}</div>` : ''}
          ${p.shipping ? `<div class="shipping">🚚 ${p.shipping}</div>` : ''}
          
          <!-- Action Buttons -->
          <div class="actions">
            <button class="btn btn-success" onclick="openChatWithProduct('${p.name.replace(/'/g, "\\'")}')">
              <i class="fas fa-comment-dots"></i> Let's Talk
            </button>
            <a href="${whatsappLink}" target="_blank" class="btn btn-whatsapp" title="Chat on WhatsApp">
              <i class="fab fa-whatsapp"></i>
            </a>
            <a href="${tiktokLink}" target="_blank" class="btn btn-tiktok" title="Message on TikTok">
              <i class="fab fa-tiktok"></i>
            </a>
            <a href="${instagramLink}" target="_blank" class="btn btn-instagram" title="Message on Instagram">
              <i class="fab fa-instagram"></i>
            </a>
            <a href="${facebookLink}" target="_blank" class="btn btn-facebook" title="Message on Facebook">
              <i class="fab fa-facebook-messenger"></i>
            </a>
            <a href="${phoneLink}" class="btn btn-phone" title="Call">
              <i class="fas fa-phone"></i>
            </a>
          </div>
        </div>
      </div>
    `;
  }).join('');
}

// ---- MODAL ----
function openModal() { document.getElementById('loginModal').style.display = 'flex'; }
function closeModal() { document.getElementById('loginModal').style.display = 'none'; }
window.onclick = function(e) {
  const modal = document.getElementById('loginModal');
  if (e.target === modal) closeModal();
};

// ---- CHAT WIDGET with product pre-fill ----
function openChatWithProduct(productName) {
  const box = document.getElementById('chatBox');
  if (!chatOpen) {
    toggleChat();
  }
  const input = document.getElementById('chatInput');
  if (input) {
    input.value = `May we talk about this ${productName}?`;
    input.focus();
  }
}

function toggleChat() {
  const box = document.getElementById('chatBox');
  chatOpen = !chatOpen;
  box.style.display = chatOpen ? 'flex' : 'none';
  if (chatOpen) {
    if (!chatSocket) {
      chatSocket = io();
      chatSocket.on('connect', () => {
        console.log('Chat connected');
        chatSocket.emit('request-chat-history');
      });
      chatSocket.on('chat-history', (msgs) => {
        chatMessages = msgs;
        renderChatMessages();
      });
      chatSocket.on('new-chat-message', (msg) => {
        chatMessages.push(msg);
        renderChatMessages();
      });
    }
    if (chatSocket) chatSocket.emit('request-chat-history');
  }
}

function renderChatMessages() {
  const container = document.getElementById('chatMessages');
  if (!chatMessages.length) {
    container.innerHTML = '<p style="color:#94a3b8; text-align:center;">No messages yet. Start the conversation!</p>';
    return;
  }
  container.innerHTML = chatMessages.map(msg => `
    <div style="background: ${msg.from === 'Customer' ? '#2563eb' : '#e2e8f0'}; 
                color: ${msg.from === 'Customer' ? 'white' : '#1e293b'}; 
                padding: 8px 14px; border-radius: 18px; max-width: 80%; align-self: ${msg.from === 'Customer' ? 'flex-end' : 'flex-start'};">
      <div style="font-size:0.75rem; opacity:0.7;">${msg.from} · ${msg.timestamp}</div>
      <div>${msg.message}</div>
    </div>
  `).join('');
  container.scrollTop = container.scrollHeight;
}

function sendChatMessage() {
  const input = document.getElementById('chatInput');
  const msg = input.value.trim();
  if (!msg) return;
  if (!chatSocket) {
    alert('Connecting to chat... please try again.');
    return;
  }
  chatSocket.emit('chat-message', { from: 'Customer', message: msg });
  input.value = '';
}

// ---- START ----
loadShopProfile();
loadProducts();