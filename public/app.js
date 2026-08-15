// ===== TYPING EFFECT FOR HERO TITLE =====
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
let chatSocket = null;
let chatOpen = false;
let chatMessages = [];

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
  if (shop.heroImage) heroSection.style.backgroundImage = `url(${shop.heroImage})`;
  else heroSection.style.backgroundImage = 'linear-gradient(135deg, #1e293b, #0f172a)';

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

// ---- CHAT ----
function openChatWithProduct(productName) {
  const box = document.getElementById('chatBox');
  if (!chatOpen) toggleChat();
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
      fetch('/api/chat')
        .then(res => res.json())
        .then(msgs => {
          chatMessages = msgs;
          renderChatMessages();
        })
        .catch(() => {});
      chatSocket.on('new-chat-message', (msg) => {
        chatMessages.push(msg);
        renderChatMessages();
      });
    }
  }
}

function renderChatMessages() {
  const container = document.getElementById('chatMessages');
  if (!chatMessages.length) {
    container.innerHTML = '<p style="color:#94a3b8; text-align:center;">No messages yet.</p>';
    return;
  }
  container.innerHTML = chatMessages.map(msg => `
    <div style="background: ${msg.from_user === 'Customer' ? '#2563eb' : '#e2e8f0'}; 
                color: ${msg.from_user === 'Customer' ? 'white' : '#1e293b'}; 
                padding: 8px 14px; border-radius: 18px; max-width: 80%; align-self: ${msg.from_user === 'Customer' ? 'flex-end' : 'flex-start'};">
      <div style="font-size:0.75rem; opacity:0.7;">${msg.from_user} · ${new Date(msg.timestamp).toLocaleString()}</div>
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