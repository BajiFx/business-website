// ============================================================
//  INDEX (HOMEPAGE) JAVASCRIPT
// ============================================================

document.addEventListener('DOMContentLoaded', function() {
    loadShopProfile();
    loadProducts();
    if (typeof updateUserUI === 'function') updateUserUI();
    if (window.customerToken && typeof checkLocationStatus === 'function') {
        checkLocationStatus();
    }
    
    const requestBtn = document.getElementById('requestLocationBtn');
    if (requestBtn) {
        requestBtn.addEventListener('click', function() {
            if (!isLoggedIn()) {
                openAuthModal('login');
                return;
            }
            fetch('/api/customer/location/request', {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${window.customerToken}` }
            })
            .then(res => res.json())
            .then(data => {
                if (data.success) {
                    if (data.alreadyApproved) {
                        document.getElementById('locationRequestStatus').textContent = '✅ Location access already approved!';
                        document.getElementById('locationRequestStatus').style.color = '#16a34a';
                    } else {
                        document.getElementById('locationRequestStatus').textContent = '✅ Request sent! Awaiting admin approval.';
                        document.getElementById('locationRequestStatus').style.color = '#f59e0b';
                    }
                } else {
                    document.getElementById('locationRequestStatus').textContent = '❌ ' + (data.error || 'Request failed');
                    document.getElementById('locationRequestStatus').style.color = '#ef4444';
                }
            })
            .catch(() => {
                document.getElementById('locationRequestStatus').textContent = '❌ Network error';
                document.getElementById('locationRequestStatus').style.color = '#ef4444';
            });
        });
    }
});

// ============================================================
//  HANDLE CHAT TAB NAVIGATION FROM OTHER PAGES
// ============================================================

// Check if we should open chat automatically (from URL param)
document.addEventListener('DOMContentLoaded', function() {
    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.get('openChat') === 'true') {
        setTimeout(() => {
            if (typeof toggleChat === 'function') {
                toggleChat();
            }
        }, 500);
    }
});

// Re-export functions from app.js for global use
window.changeSlide = changeSlide;
window.openAuthModal = openAuthModal;
window.closeAuthModal = closeAuthModal;
window.switchAuthTab = switchAuthTab;
window.toggleAuthPwd = toggleAuthPwd;
window.handleAuthLogin = handleAuthLogin;
window.handleAuthRegister = handleAuthRegister;
window.toggleChat = toggleChat;
window.sendChatMessage = sendChatMessage;
window.closeDetails = closeDetails;
window.getAutoSocialLinks = getAutoSocialLinks;