// ============================================================
//  CATEGORY PAGE JAVASCRIPT - COMPLETE FIXED VERSION
//  Location: D:\my-business-website\public\js\category.js
// ============================================================

// ============================================================
//  TOAST
// ============================================================
function showToast(message, type) {
    const existing = document.querySelector('.toast-container');
    if (existing) existing.remove();
    const container = document.createElement('div');
    container.className = 'toast-container';
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    const icon = document.createElement('span');
    icon.innerHTML = type === 'success' ? '✅' : type === 'error' ? '❌' : 'ℹ️';
    icon.style.fontSize = '1.2rem';
    const text = document.createElement('span');
    text.textContent = message;
    const closeBtn = document.createElement('button');
    closeBtn.innerHTML = '✕';
    closeBtn.style.cssText = 'background:none;border:none;color:white;font-size:1rem;cursor:pointer;margin-left:auto;opacity:0.7;';
    closeBtn.onclick = () => { toast.style.transform = 'translateX(120%)'; setTimeout(() => container.remove(), 300); };
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
    }, 4000);
}

// ============================================================
//  RENDER PRODUCTS
// ============================================================
function renderProducts(products) {
    const container = document.getElementById('productGrid');
    if (!container) return;
    
    if (!products || products.length === 0) {
        container.innerHTML = `<p style="text-align:center;padding:40px;color:#94a3b8;">No products found.</p>`;
        return;
    }

    const cart = typeof getCart === 'function' ? getCart() : [];
    
    container.innerHTML = products.map(p => {
        const inCart = cart.some(item => item.id === p.id);
        const btnText = inCart ? 'Add More' : 'Add to Cart';
        const btnClass = inCart ? 'in-cart' : '';
        const qtyId = `cat-qty-${p.id}`;

        let imageHtml = '';
        if (p.image) {
            imageHtml = `<img src="${p.image}" alt="${p.name}" loading="lazy" style="width:100%;height:100%;object-fit:cover;" onerror="this.parentElement.innerHTML='<div style=\\'display:flex;align-items:center;justify-content:center;height:100%;background:#e2e8f0;font-size:2rem;\\'>📦</div>'">`;
        } else {
            imageHtml = `<div style="display:flex;align-items:center;justify-content:center;height:100%;background:#e2e8f0;font-size:2rem;">📦</div>`;
        }

        let badgesHtml = '';
        if (p.isFlashSale) {
            badgesHtml += `<div class="flash-badge">🔥</div>`;
        }
        if (p.isNewArrival) {
            badgesHtml += `<div class="new-badge">🆕</div>`;
        }

        const ratingHtml = p.rating ? `<div class="rating"><span>⭐</span>(${p.rating})</div>` : '';

        let swatchesHtml = '';
        if (p.variants && p.variants.length > 0) {
            swatchesHtml = '<div class="variant-swatches">';
            p.variants.slice(0, 3).forEach(v => {
                const bg = v.image ? `url(${v.image})` : '';
                swatchesHtml += `<div class="swatch" style="background-image:${bg};" title="${v.name}" onclick="event.stopPropagation(); location.href='/product-detail.html?id=${p.id}&variant=${v.id}'"></div>`;
            });
            if (p.variants.length > 3) {
                swatchesHtml += `<span style="font-size:0.6rem;color:#94a3b8;">+${p.variants.length - 3}</span>`;
            }
            swatchesHtml += '</div>';
        }

        return `
            <div class="product-card">
                <div class="media-wrap" onclick="location.href='/product-detail.html?id=${p.id}'">
                    ${imageHtml}
                    <div class="quick-view-icon"><i class="fas fa-eye"></i></div>
                    ${badgesHtml}
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
                            <button onclick="changeCardQty(${p.id}, -1, 'cat-qty-')">−</button>
                            <span id="${qtyId}">1</span>
                            <button onclick="changeCardQty(${p.id}, 1, 'cat-qty-')">+</button>
                        </div>
                        <button class="btn-add ${btnClass}" onclick="addCardToCartFromCategory(${p.id}, 'cat-qty-')">
                            <i class="fas fa-cart-plus"></i> ${btnText}
                        </button>
                    </div>
                </div>
            </div>
        `;
    }).join('');
}

// ============================================================
//  CHANGE CARD QUANTITY
// ============================================================
function changeCardQty(productId, delta, prefix) {
    const qtySpan = document.getElementById(`${prefix}${productId}`);
    if (!qtySpan) return;
    let current = parseInt(qtySpan.textContent) || 1;
    current = Math.max(1, current + delta);
    qtySpan.textContent = current;
}

// ============================================================
//  ADD CARD TO CART
// ============================================================
function addCardToCartFromCategory(productId, prefix) {
    const qtySpan = document.getElementById(`${prefix}${productId}`);
    const qty = qtySpan ? parseInt(qtySpan.textContent) || 1 : 1;
    if (typeof addToCart === 'function') {
        addToCart(productId, qty);
    } else {
        showToast('Please login first.', 'error');
    }
    if (qtySpan) qtySpan.textContent = '1';
}

// ============================================================
//  TOGGLE WISHLIST
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
            showToast(data.action === 'added' ? '❤️ Added to wishlist' : '💔 Removed from wishlist', 'success');
        }
    } catch (err) {
        console.error('Wishlist error:', err);
        showToast('Network error', 'error');
    }
}

// ============================================================
//  EXTRACT CATEGORIES
// ============================================================
function extractCategories(products) {
    const categoryMap = new Map();
    products.forEach(p => {
        if (p.category) {
            const count = categoryMap.get(p.category) || 0;
            categoryMap.set(p.category, count + 1);
        }
    });
    return Array.from(categoryMap.entries())
        .map(([name, count]) => ({ name, count }))
        .sort((a, b) => a.name.localeCompare(b.name));
}

// ============================================================
//  RENDER CATEGORIES
// ============================================================
function renderCategories(categories) {
    const container = document.getElementById('categoryGrid');
    if (!container) return;
    
    if (!categories || categories.length === 0) {
        container.innerHTML = `<p class="no-categories-msg" style="grid-column:1/-1; color:#94a3b8; text-align:center; padding:20px;">No categories available.</p>`;
        return;
    }
    const icons = ['📱', '👗', '🏠', '💄', '💊', '⚽', '📚', '🎵', '🍕', '🚗', '💻', '🛋️', '👟', '🎮', '📷'];
    container.innerHTML = categories.map((cat, i) => {
        const icon = icons[i % icons.length];
        return `
            <div class="category-card" onclick="filterByCategory('${cat.name}')">
                <div class="icon">${icon}</div>
                <div class="name">${cat.name}</div>
                <div class="count">${cat.count} product${cat.count > 1 ? 's' : ''}</div>
            </div>
        `;
    }).join('');
}

// ============================================================
//  POPULATE CATEGORY DROPDOWN
// ============================================================
function populateCategoryDropdown(categories) {
    const select = document.getElementById('categoryFilter');
    if (!select) return;
    select.innerHTML = '<option value="all">All Categories</option>';
    categories.forEach(cat => {
        select.innerHTML += `<option value="${cat.name}">${cat.name}</option>`;
    });
}

// ============================================================
//  FILTER BY CATEGORY
// ============================================================
function filterByCategory(category) {
    document.getElementById('categoryFilter').value = category;
    document.getElementById('searchInput').value = '';
    window.handleSearch();
    document.getElementById('productsContainer').scrollIntoView({ behavior: 'smooth' });
}

// ============================================================
//  SEARCH HANDLER
// ============================================================
window.handleSearch = function() {
    const search = document.getElementById('searchInput').value.toLowerCase().trim();
    const category = document.getElementById('categoryFilter').value;

    let filtered = window.allProducts || [];
    if (category !== 'all') {
        filtered = filtered.filter(p => p.category === category);
    }
    if (search) {
        filtered = filtered.filter(p => p.name.toLowerCase().includes(search));
    }
    renderProducts(filtered);
};

window.handleSearchWithFeedback = function() {
    const btn = document.getElementById('searchBtn');
    btn.classList.add('clicked');
    setTimeout(() => btn.classList.remove('clicked'), 700);
    window.handleSearch();
};

// ============================================================
//  LOAD DATA
// ============================================================
async function initCategoryPage() {
    console.log('🔄 Initializing category page...');
    
    try {
        // Try to use existing products from app.js first
        if (window.allProducts && window.allProducts.length > 0) {
            console.log('📦 Using existing products:', window.allProducts.length);
            const products = window.allProducts;
            const categories = extractCategories(products);
            renderCategories(categories);
            populateCategoryDropdown(categories);
            renderProducts(products);
            console.log('✅ Category page initialized from existing data');
            return;
        }
        
        // Fetch products from API
        console.log('📦 Fetching products from API...');
        const res = await fetch('/api/products');
        if (!res.ok) {
            throw new Error(`Failed to fetch products: ${res.status}`);
        }
        const products = await res.json();
        
        console.log('📦 Products loaded:', products.length);
        window.allProducts = products;

        const categories = extractCategories(products);
        console.log('📂 Categories found:', categories.length);
        
        renderCategories(categories);
        populateCategoryDropdown(categories);
        renderProducts(products);
        
        console.log('✅ Category page initialized successfully');
        
    } catch (err) {
        console.error('❌ Error initializing category page:', err);
        const categoryGrid = document.getElementById('categoryGrid');
        if (categoryGrid) {
            categoryGrid.innerHTML = `<p class="no-categories-msg" style="grid-column:1/-1; color:#ef4444; text-align:center; padding:20px;">Error loading categories: ${err.message}</p>`;
        }
        const productGrid = document.getElementById('productGrid');
        if (productGrid) {
            productGrid.innerHTML = `<p style="text-align:center;padding:40px;color:#ef4444;">Error loading products: ${err.message}</p>`;
        }
        showToast('Failed to load products. Please refresh the page.', 'error');
    }
}

// ============================================================
//  LOAD SHOP NAME
// ============================================================
async function loadShopName() {
    try {
        const res = await fetch('/api/shop');
        if (!res.ok) throw new Error('Failed to load shop');
        const shop = await res.json();
        const nameHeader = document.getElementById('shopNameHeader');
        if (nameHeader) nameHeader.textContent = shop.name || 'Our Business';
    } catch (err) {
        console.error('Error loading shop name:', err);
    }
}

// ============================================================
//  UPDATE CART BADGE
// ============================================================
function updateCartBadge() {
    const cart = typeof getCart === 'function' ? getCart() : [];
    const count = cart.reduce((sum, item) => sum + item.quantity, 0);
    const badge = document.getElementById('cartBadge');
    if (badge) {
        if (count > 0) {
            badge.textContent = count;
            badge.style.display = 'inline';
        } else {
            badge.style.display = 'none';
        }
    }
}

function updateNavCartBadge() {
    const cart = typeof getCart === 'function' ? getCart() : [];
    const count = cart.reduce((sum, item) => sum + item.quantity, 0);
    const badge = document.getElementById('navCartBadge');
    if (badge) {
        if (count > 0) {
            badge.textContent = count;
            badge.classList.add('show');
        } else {
            badge.classList.remove('show');
        }
    }
}

// ============================================================
//  EXPOSE FUNCTIONS GLOBALLY
// ============================================================
window.filterByCategory = filterByCategory;
window.renderProducts = renderProducts;
window.changeCardQty = changeCardQty;
window.addCardToCartFromCategory = addCardToCartFromCategory;
window.toggleWishlist = toggleWishlist;
window.showToast = showToast;
window.initCategoryPage = initCategoryPage;
window.handleSearch = handleSearch;
window.handleSearchWithFeedback = handleSearchWithFeedback;
window.updateCartBadge = updateCartBadge;
window.updateNavCartBadge = updateNavCartBadge;

// ============================================================
//  INIT
// ============================================================
document.addEventListener('DOMContentLoaded', function() {
    console.log('📄 Category page loaded');
    loadShopName();
    initCategoryPage();
    updateCartBadge();
    updateNavCartBadge();
});

console.log('✅ Category page JS loaded successfully');