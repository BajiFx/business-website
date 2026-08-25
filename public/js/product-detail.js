// ============================================================
//  PRODUCT DETAIL JAVASCRIPT
// ============================================================

const urlParams = new URLSearchParams(window.location.search);
const productId = urlParams.get('id');
if (!productId) {
  document.getElementById('detailContent').innerHTML = '<p style="color:#ef4444;">Product ID missing.</p>';
}

let detailQty = 1;
let reviewRating = 0;
let currentVariantId = null;
let currentMediaIndex = 0;
let currentProduct = null;
let allVariants = [];
let shopData = null;

// ============================================================
//  FETCH SHOP DATA
// ============================================================
async function fetchShopData() {
  try {
    const res = await fetch('/api/shop');
    if (!res.ok) throw new Error('Failed to load shop');
    shopData = await res.json();
  } catch (err) {
    console.error('Error loading shop:', err);
    shopData = {};
  }
}

// ============================================================
//  GET AUTO SOCIAL LINKS
// ============================================================
function getAutoSocialLinks(product) {
  const shop = shopData || {};
  const productName = product.name || 'this product';
  const productPrice = product.price ? ` (${product.price})` : '';
  const message = `Hi, I'm interested in "${productName}"${productPrice}. Could I get more information about this product?`;
  const encodedMessage = encodeURIComponent(message);
  const whatsappNumber = shop.whatsapp || '';
  const instagramUser = shop.instagram || '';
  const facebookUser = shop.facebook || '';
  const tiktokUser = shop.tiktok || '';
  const phone = shop.phone || '';
  const cleanedWhatsapp = whatsappNumber.replace(/[^0-9]/g, '');
  return {
    whatsapp: cleanedWhatsapp ? `https://wa.me/${cleanedWhatsapp}?text=${encodedMessage}` : '#',
    instagram: instagramUser ? `https://www.instagram.com/${instagramUser.replace('@', '').trim()}/` : '#',
    messenger: facebookUser ? `https://m.me/${facebookUser.replace('@', '').trim()}?text=${encodedMessage}` : '#',
    tiktok: tiktokUser ? `https://www.tiktok.com/@${tiktokUser.replace('@', '').trim()}` : '#',
    phone: phone ? `tel:${phone}` : '#'
  };
}

// ============================================================
//  LOAD PRODUCT DETAIL
// ============================================================
async function loadProductDetail() {
  try {
    await fetchShopData();
    const res = await fetch(`/api/products/${productId}/detail`);
    if (!res.ok) throw new Error('Product not found');
    const data = await res.json();
    currentProduct = data.product;
    allVariants = data.variants || [];

    if (allVariants.length === 0) {
      allVariants = [{
        id: null,
        name: 'Default',
        price: data.product.price,
        stock: 999,
        image: data.product.image || ''
      }];
    }

    currentVariantId = allVariants[0].id;
    renderDetail(data.product, data.reviews || [], data.related || []);
  } catch (err) {
    document.getElementById('detailContent').innerHTML = `<p style="color:#ef4444;">Error: ${err.message}</p>`;
  }
}

// ============================================================
//  RENDER DETAIL
// ============================================================
function renderDetail(product, reviews, related) {
  const container = document.getElementById('detailContent');

  let variant = allVariants.find(v => v.id === currentVariantId) || allVariants[0];
  let media = [];
  if (variant.image) {
    media.push({ id: null, type: 'image', url: variant.image });
  }
  if (product.image && !media.length) {
    media.push({ id: null, type: 'image', url: product.image });
  }
  if (currentMediaIndex >= media.length) currentMediaIndex = 0;

  // Color Variants
  let variantHtml = '';
  if (allVariants.length > 1) {
    variantHtml = `<div class="variant-selector"><span class="label">Color:</span>`;
    allVariants.forEach(v => {
      const active = v.id === currentVariantId ? 'active' : '';
      const colorCode = v.color_code || '#cccccc';
      const bgImage = v.image ? `url(${v.image})` : '';
      const isInStock = v.stock > 0;
      variantHtml += `
        <button class="variant-btn ${active}" onclick="selectVariant(${v.id})" title="${v.name}">
          ${v.image ? `<span class="color-swatch" style="background-image:${bgImage};"></span>` :
            `<span class="color-swatch" style="background:${colorCode};"></span>`}
          ${!isInStock ? `<span class="stock-badge">✕</span>` : ''}
        </button>
      `;
    });
    variantHtml += '</div>';
  } else {
    variantHtml = `<div class="variant-selector"><span class="label">Color:</span> <span style="font-weight:500;">${allVariants[0].name}</span></div>`;
  }

  // Thumbnails
  let thumbHtml = '';
  media.forEach((m, idx) => {
    const active = idx === currentMediaIndex ? 'active' : '';
    thumbHtml += `<div class="thumb ${active}" onclick="selectMedia(${idx})"><img src="${m.url}" alt="Media"></div>`;
  });

  // Main media
  let mainMediaHtml = '';
  if (media.length > 0 && media[currentMediaIndex]) {
    mainMediaHtml = `<img src="${media[currentMediaIndex].url}" alt="${product.name}">`;
  } else {
    mainMediaHtml = '<div class="no-image">📦</div>';
  }

  // Price
  const currentPrice = variant.price || product.price;
  const oldPrice = product.old_price || '';
  const discountPercent = product.discount_percent || '';
  let priceHtml = `
    <div class="price-section">
      <span class="current-price">Ksh ${parseFloat(currentPrice).toFixed(2)}</span>
  `;
  if (oldPrice && parseFloat(oldPrice) > parseFloat(currentPrice)) {
    priceHtml += `<span class="old-price">Ksh ${parseFloat(oldPrice).toFixed(2)}</span>`;
    if (discountPercent) {
      priceHtml += `<span class="discount-badge">-${discountPercent}%</span>`;
    }
  }
  priceHtml += `</div>`;

  // Stock
  const stockDisplay = variant.stock !== undefined ? variant.stock : 999;
  const stockHtml = `
    <div class="stock-info">
      ${stockDisplay > 0 ?
        `<span class="in-stock">✓ In Stock (${stockDisplay} available)</span>` :
        `<span class="out-of-stock">✕ Out of Stock</span>`}
    </div>
  `;

  // Rating
  const ratingValue = parseFloat(product.rating) || 0;
  const fullStars = Math.round(ratingValue);
  let ratingHtml = '';
  if (ratingValue > 0) {
    ratingHtml = `
      <div class="rating-section">
        <span class="stars">${'⭐'.repeat(Math.min(fullStars, 5))}</span>
        <span class="rating-text">${ratingValue.toFixed(1)}</span>
        <span class="review-count">(${product.review_count || 0} reviews)</span>
      </div>
    `;
  }

  // Badges
  let badgesHtml = '';
  if (product.badge1) badgesHtml += `<span class="badge badge-green">${product.badge1}</span>`;
  if (product.badge2) badgesHtml += `<span class="badge badge-blue">${product.badge2}</span>`;
  if (product.isFlashSale) badgesHtml += `<span class="badge tag-flash">🔥 Flash Sale</span>`;
  if (product.isNewArrival) badgesHtml += `<span class="badge tag-new">🆕 New</span>`;
  if (badgesHtml) badgesHtml = `<div class="badges">${badgesHtml}</div>`;

  // Description
  const descriptionHtml = `<div class="description">${product.description || 'No description available for this product.'}</div>`;

  // Services
  let servicesHtml = '';
  if (product.shipping) {
    servicesHtml = `<div class="services"><span>Delivery Information:</span> ${product.shipping}</div>`;
  }

  // Return Policy
  const returnDays = product.return_window_days || 14;
  const restockingFee = product.restocking_fee_percent || 0;
  const returnCondition = product.return_condition || 'unopened';
  const returnEnabled = product.return_enabled !== false;

  let returnPolicyHtml = '';
  if (returnEnabled) {
    returnPolicyHtml = `
      <div class="return-policy">
        <strong>🔄 Return Policy:</strong> 
        Returns accepted within ${returnDays} days of delivery. 
        ${restockingFee > 0 ? `Restocking fee: ${restockingFee}%. ` : ''}
        Products must be in ${returnCondition} condition.
      </div>
    `;
  } else {
    returnPolicyHtml = `
      <div class="return-policy" style="background:linear-gradient(145deg, #fef2f2, #fee2e2); border-left-color:#ef4444; color:#991b1b;">
        <strong>❌ Non-Returnable:</strong> This item is final sale and cannot be returned.
      </div>
    `;
  }

  // Contact Us
  const socialLinks = getAutoSocialLinks(product);
  let contactRatingHtml = '';
  if (ratingValue > 0) {
    contactRatingHtml = `
      <div class="product-rating-display">
        <span class="stars">${'⭐'.repeat(Math.min(fullStars, 5))}</span>
        <span class="rating-value">${ratingValue.toFixed(1)}</span>
        <span class="review-count">(${product.review_count || 0} reviews)</span>
      </div>
    `;
  } else {
    contactRatingHtml = `
      <div class="product-rating-display">
        <span style="color:#94a3b8; font-size:0.8rem;">No ratings yet. Be the first to rate!</span>
      </div>
    `;
  }

  let contactHtml = `
    <div class="contact-us-section">
      <h4>📞 Contact Us</h4>
      ${contactRatingHtml}
      <div class="social-icons" style="margin-top:6px;">
        <a href="${socialLinks.whatsapp}" target="_blank" class="whatsapp"><i class="fab fa-whatsapp"></i> WhatsApp</a>
        <a href="${socialLinks.instagram}" target="_blank" class="instagram"><i class="fab fa-instagram"></i> Instagram</a>
        <a href="${socialLinks.messenger}" target="_blank" class="messenger"><i class="fab fa-facebook-messenger"></i> Messenger</a>
        <a href="${socialLinks.tiktok}" target="_blank" class="tiktok"><i class="fab fa-tiktok"></i> TikTok</a>
        <a href="${socialLinks.phone}" class="phone"><i class="fas fa-phone"></i> Call</a>
      </div>
    </div>
  `;

  // Reviews
  let reviewsHtml = '';
  if (reviews && reviews.length > 0) {
    reviewsHtml = reviews.slice(0, 4).map(r => `
      <div class="review-item">
        <div class="rating">${'⭐'.repeat(Math.min(r.rating, 5))}</div>
        <div class="review-text">${r.review_text || ''}</div>
        <div class="review-meta">
          <span class="reviewer">${r.customer_name || 'Anonymous'}</span>
          <span>${new Date(r.created_at).toLocaleDateString()}</span>
        </div>
      </div>
    `).join('');
    if (reviews.length > 4) {
      reviewsHtml += `<div class="review-more" onclick="loadAllReviews()">+ ${reviews.length - 4} more reviews</div>`;
    }
  } else {
    reviewsHtml = `<div class="review-empty">No reviews yet. Be the first to review!</div>`;
  }

  // Related
  let relatedHtml = '';
  if (related && related.length > 0) {
    relatedHtml = related.slice(0, 4).map(p => `
      <div class="related-item" onclick="location.href='/product-detail.html?id=${p.id}'">
        ${p.image ? `<img src="${p.image}" alt="${p.name}">` : `<div class="no-image">📦</div>`}
        <div class="related-info">
          <div class="related-name">${p.name}</div>
          <div class="related-price">${p.price}</div>
        </div>
      </div>
    `).join('');
  }

  // Cart button
  const isInCart = getCart().some(item => item.id === product.id && item.variant_id === currentVariantId);
  const btnText = isInCart ? 'Add More' : 'Add to Cart';
  const btnClass = isInCart ? 'in-cart' : '';

  // Render everything
  container.innerHTML = `
    <div class="detail-container">
      <div class="detail-media">
        <div class="detail-main-media">${mainMediaHtml}</div>
        ${thumbHtml ? `<div class="media-thumbnails">${thumbHtml}</div>` : ''}
      </div>

      <div class="detail-info">
        <div class="name">${product.name}</div>
        ${ratingHtml}
        ${priceHtml}
        ${stockHtml}
        ${badgesHtml}
        ${descriptionHtml}
        ${servicesHtml}
        ${returnPolicyHtml}
        ${variantHtml}

        <div class="qty-section">
          <span class="qty-label">Quantity:</span>
          <div class="qty-control">
            <button onclick="changeDetailQty(-1)">−</button>
            <span id="detailQty">${detailQty}</span>
            <button onclick="changeDetailQty(1)">+</button>
          </div>
        </div>

        <div class="button-group">
          <button class="btn-add-large ${btnClass}" onclick="addVariantToCart()">🛒 ${btnText}</button>
          <button class="btn-buy-now" onclick="buyNow()">Buy Now</button>
        </div>

        ${contactHtml}
      </div>
    </div>

    <div class="reviews-wrapper">
      <div class="write-review">
        <h4><i class="fas fa-pen" style="color:#2563eb;"></i> Write a Review</h4>
        <div class="stars-row">
          <span class="stars" id="reviewStars">
            <span onclick="setRating(1)">⭐</span>
            <span onclick="setRating(2)">⭐</span>
            <span onclick="setRating(3)">⭐</span>
            <span onclick="setRating(4)">⭐</span>
            <span onclick="setRating(5)">⭐</span>
          </span>
          <span class="rating-hint">👆 Click a star to rate this product</span>
        </div>
        <textarea id="reviewText" placeholder="Share your experience with this product..." rows="2"></textarea>
        <button class="btn-submit" onclick="submitReview(${product.id})">Submit Review</button>
      </div>

      <div class="reviews-section">
        <h3>
          ⭐ Reviews
          <span class="review-count-badge">${reviews ? reviews.length : 0}</span>
        </h3>
        <div class="reviews-list">
          ${reviewsHtml}
        </div>
      </div>
    </div>

    <div class="related-products">
      <h3>You may also like</h3>
      <div class="related-grid">${relatedHtml}</div>
    </div>
  `;
}

// ============================================================
//  LOAD ALL REVIEWS (EXPAND)
// ============================================================
function loadAllReviews() {
  loadProductDetail();
}

// ============================================================
//  VARIANT & MEDIA FUNCTIONS
// ============================================================
function selectVariant(variantId) {
  currentVariantId = variantId;
  currentMediaIndex = 0;
  loadProductDetail();
}

function selectMedia(index) {
  currentMediaIndex = index;
  loadProductDetail();
}

function changeDetailQty(delta) {
  detailQty = Math.max(1, detailQty + delta);
  const span = document.getElementById('detailQty');
  if (span) span.textContent = detailQty;
}

// ============================================================
//  ADD TO CART
// ============================================================
function addVariantToCart() {
  if (!currentProduct) return;
  const variant = allVariants.find(v => v.id === currentVariantId) || allVariants[0];
  const price = variant.price || currentProduct.price;
  const variantId = variant.id;
  const variantName = variant.name || 'Default';
  const image = variant.image || currentProduct.image;

  let cart = getCart();
  const existing = cart.find(item => item.id === currentProduct.id && item.variant_id === variantId);
  if (existing) {
    existing.quantity += detailQty;
  } else {
    cart.push({
      id: currentProduct.id,
      variant_id: variantId,
      name: currentProduct.name,
      price: price,
      image: image || '',
      quantity: detailQty,
      variant_name: variantName
    });
  }
  saveCart(cart);
  updateCartBadge();
  showToast(`✅ Added ${detailQty} "${currentProduct.name}" to cart!`, 'success');
  detailQty = 1;
  const span = document.getElementById('detailQty');
  if (span) span.textContent = '1';
  loadProductDetail();
}

function buyNow() {
  addVariantToCart();
  window.location.href = '/cart.html';
}

// ============================================================
//  REVIEW
// ============================================================
function setRating(rating) {
  reviewRating = rating;
  const stars = document.querySelectorAll('#reviewStars span');
  stars.forEach((star, index) => {
    star.style.color = index < rating ? '#f59e0b' : '#d1d5db';
  });
}

function submitReview(productId) {
  const text = document.getElementById('reviewText').value.trim();
  if (!reviewRating) { alert('Please select a rating.'); return; }
  if (!text) { alert('Please write a review.'); return; }
  const token = window.customerToken;
  if (!token) { alert('Please login first.'); return; }
  fetch(`/api/products/${productId}/review`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body: JSON.stringify({ rating: reviewRating, review_text: text })
  })
    .then(res => res.json())
    .then(data => {
      if (data.success) {
        showToast('✅ Review submitted!', 'success');
        document.getElementById('reviewText').value = '';
        setRating(0);
        loadProductDetail();
      } else {
        showToast('❌ Failed to submit review.', 'error');
      }
    })
    .catch(() => showToast('❌ Network error.', 'error'));
}

// ============================================================
//  INIT
// ============================================================
document.addEventListener('DOMContentLoaded', () => {
  loadProductDetail();
  updateCartBadge();
  updateNavCartBadge();
});

// Expose globals
window.selectVariant = selectVariant;
window.selectMedia = selectMedia;
window.changeDetailQty = changeDetailQty;
window.addVariantToCart = addVariantToCart;
window.buyNow = buyNow;
window.setRating = setRating;
window.submitReview = submitReview;
window.loadProductDetail = loadProductDetail;
window.loadAllReviews = loadAllReviews;