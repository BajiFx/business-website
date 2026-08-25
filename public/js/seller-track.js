// ============================================================
//  SELLER TRACK JAVASCRIPT
// ============================================================

let map, shopMarker;
let customerMarkers = {};
let shopLat, shopLng;
let socket;

function getDistance(lat1, lng1, lat2, lng2) {
    const R = 6371e3;
    const φ1 = lat1 * Math.PI/180, φ2 = lat2 * Math.PI/180;
    const Δφ = (lat2-lat1) * Math.PI/180;
    const Δλ = (lng2-lng1) * Math.PI/180;
    const a = Math.sin(Δφ/2)**2 + Math.cos(φ1)*Math.cos(φ2)*Math.sin(Δλ/2)**2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

function formatDistance(meters) {
    if (meters < 1000) return Math.round(meters) + ' m';
    return (meters/1000).toFixed(1) + ' km';
}

function formatTime(seconds) {
    if (seconds < 60) return Math.round(seconds) + ' sec';
    const mins = Math.floor(seconds / 60);
    const secs = Math.round(seconds % 60);
    return mins + ' min ' + (secs > 0 ? secs + ' sec' : '');
}

async function getShopLocation() {
    const res = await fetch('/api/shop');
    const shop = await res.json();
    shopLat = parseFloat(shop.latitude);
    shopLng = parseFloat(shop.longitude);
    if (!shopLat || !shopLng) {
        alert('Shop location not set. Please set it in admin panel.');
        return false;
    }
    return true;
}

function initMap() {
    map = L.map('map').setView([shopLat, shopLng], 14);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; OpenStreetMap'
    }).addTo(map);
    shopMarker = L.marker([shopLat, shopLng], {
        icon: L.divIcon({ className: 'shop-marker', html: '📍', iconSize: [30, 30] })
    }).addTo(map).bindPopup('🏪 Your Shop');
    L.circle([shopLat, shopLng], { radius: 1000, color: '#2563eb', fillColor: '#2563eb', fillOpacity: 0.08 }).addTo(map);
}

function updateCustomerOnMap(customer) {
    const { socketId, lat, lng, name } = customer;
    if (!lat || !lng) return;
    const latNum = parseFloat(lat);
    const lngNum = parseFloat(lng);
    if (isNaN(latNum) || isNaN(lngNum)) return;

    const dist = getDistance(shopLat, shopLng, latNum, lngNum);
    const timeSec = dist / 1.4;
    const distStr = formatDistance(dist);
    const timeStr = formatTime(timeSec);

    if (customerMarkers[socketId]) {
        customerMarkers[socketId].setLatLng([latNum, lngNum]);
        customerMarkers[socketId].setPopupContent(
            `🧑 ${name || 'Customer'}<br>Distance: ${distStr}<br>~ ${timeStr} walk`
        );
    } else {
        const icon = L.divIcon({ className: 'custom-div-icon', html: '🧑‍🦯', iconSize: [30, 30] });
        const marker = L.marker([latNum, lngNum], { icon }).addTo(map)
            .bindPopup(`🧑 ${name || 'Customer'}<br>Distance: ${distStr}<br>~ ${timeStr} walk`);
        customerMarkers[socketId] = marker;
    }
    updateCustomerList();
}

function removeCustomer(socketId) {
    if (customerMarkers[socketId]) {
        map.removeLayer(customerMarkers[socketId]);
        delete customerMarkers[socketId];
    }
    updateCustomerList();
}

function updateCustomerList() {
    const container = document.getElementById('customerItems');
    const ids = Object.keys(customerMarkers);
    if (ids.length === 0) {
        container.innerHTML = '<p class="empty-customers">No active customers</p>';
        document.getElementById('info').innerHTML = '<i class="fas fa-users"></i> Customers online: 0';
        return;
    }
    let html = '';
    ids.forEach(id => {
        const marker = customerMarkers[id];
        const popup = marker.getPopup();
        const content = popup ? popup.getContent() : '';
        const distMatch = content.match(/Distance: ([\d.]+ [km]+)/);
        const timeMatch = content.match(/~ ([\d.]+ [a-z]+)/);
        const distStr = distMatch ? distMatch[1] : '?';
        const timeStr = timeMatch ? timeMatch[1] : '?';
        html += `
            <div class="customer-item">
                <span class="name">🧑 ${id.slice(0,6)}</span>
                <span>
                    <span class="dist">${distStr}</span>
                    <span class="time">${timeStr}</span>
                </span>
            </div>
        `;
    });
    container.innerHTML = html;
    document.getElementById('info').innerHTML = `<i class="fas fa-users"></i> Customers online: ${ids.length}`;
}

async function init() {
    const ok = await getShopLocation();
    if (!ok) return;
    initMap();

    socket = io();
    socket.on('connect', () => {
        console.log('Seller tracking connected');
        socket.emit('get-customers');
    });

    socket.on('customer-list', (customers) => {
        customers.forEach(c => updateCustomerOnMap(c));
    });

    socket.on('customer-update', (data) => {
        updateCustomerOnMap(data);
    });

    socket.on('customer-left', (socketId) => {
        removeCustomer(socketId);
    });
}

init();