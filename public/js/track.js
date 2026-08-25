// ============================================================
//  CUSTOMER TRACK JAVASCRIPT
// ============================================================

let map, userMarker, shopMarker, routeLine;
let shopLat, shopLng;
let socket = null;
let watchId = null;
let isSharing = false;
let prevDist = null;

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
        document.getElementById('statusMsg').innerHTML = '❌ Shop location not set.';
        return false;
    }
    return true;
}

function initMap(userLat, userLng) {
    map = L.map('map').setView([userLat, userLng], 15);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; OpenStreetMap'
    }).addTo(map);

    if (shopLat && shopLng) {
        shopMarker = L.marker([shopLat, shopLng], {
            icon: L.divIcon({ className: 'shop-marker', html: '📍', iconSize: [30, 30] })
        }).addTo(map).bindPopup('🏪 Shop');
        L.circle([shopLat, shopLng], { radius: 1000, color: '#2563eb', fillColor: '#2563eb', fillOpacity: 0.08 }).addTo(map);
    }

    const userIcon = L.divIcon({ className: 'user-marker', html: '🧑‍🦯', iconSize: [30, 30] });
    userMarker = L.marker([userLat, userLng], { icon: userIcon }).addTo(map).bindPopup('You are here');
    map.setView([userLat, userLng], 15);
    
    updateInfo(userLat, userLng);
    drawRoute(userLat, userLng);
}

function drawRoute(userLat, userLng) {
    if (routeLine) map.removeLayer(routeLine);
    routeLine = L.polyline([[userLat, userLng], [shopLat, shopLng]], {
        color: '#2563eb',
        weight: 3,
        dashArray: '8, 6',
        opacity: 0.7
    }).addTo(map);
}

function updateInfo(lat, lng) {
    if (!shopLat || !shopLng) return;
    const dist = getDistance(lat, lng, shopLat, shopLng);
    const speed = 1.4;
    const timeSec = dist / speed;
    let directionText = '';
    if (prevDist !== null) {
        const diff = dist - prevDist;
        if (diff < -2) directionText = '⬆️ Getting closer!';
        else if (diff > 2) directionText = '⬇️ Moving away';
        else directionText = '⟷ Steady';
    }
    prevDist = dist;
    document.getElementById('distValue').textContent = formatDistance(dist);
    document.getElementById('timeValue').textContent = formatTime(timeSec);
    document.getElementById('dirValue').textContent = directionText;
    document.getElementById('statusMsg').innerHTML = '<span class="dot active"></span> Live tracking active';
}

function startTracking() {
    if (!navigator.geolocation) {
        alert('Geolocation not supported');
        return;
    }
    watchId = navigator.geolocation.watchPosition(
        (pos) => {
            const lat = pos.coords.latitude;
            const lng = pos.coords.longitude;
            if (userMarker) {
                userMarker.setLatLng([lat, lng]);
                map.setView([lat, lng], 15);
                drawRoute(lat, lng);
            } else {
                initMap(lat, lng);
            }
            updateInfo(lat, lng);
            if (isSharing && socket) {
                socket.emit('customer-location', { lat, lng, name: 'Customer' });
            }
        },
        (err) => {
            document.getElementById('statusMsg').innerHTML = '❌ GPS error: ' + err.message;
        },
        { enableHighAccuracy: true, timeout: 10000 }
    );
}

function toggleSharing() {
    if (!socket) {
        socket = io();
        socket.on('connect', () => {
            document.getElementById('statusMsg').innerHTML = '<span class="dot active"></span> Connected. Sharing location...';
        });
    }
    isSharing = !isSharing;
    const btn = document.getElementById('shareBtn');
    const text = document.getElementById('shareText');
    if (isSharing) {
        btn.classList.add('sharing');
        text.textContent = 'Stop Sharing';
        navigator.geolocation.getCurrentPosition((pos) => {
            socket.emit('customer-location', { lat: pos.coords.latitude, lng: pos.coords.longitude, name: 'Customer' });
        });
        document.getElementById('statusMsg').innerHTML = '<span class="dot active"></span> 🔄 Sharing your live location with the seller...';
    } else {
        btn.classList.remove('sharing');
        text.textContent = 'Share Location';
        document.getElementById('statusMsg').innerHTML = '<span class="dot active"></span> 📍 Sharing stopped. You are still tracking yourself.';
    }
}

(async function() {
    const ok = await getShopLocation();
    if (!ok) return;
    startTracking();
    socket = io();
    socket.on('connect', () => console.log('Socket connected'));
})();