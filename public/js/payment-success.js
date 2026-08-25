// ============================================================
//  PAYMENT SUCCESS PAGE JAVASCRIPT
// ============================================================

const urlParams = new URLSearchParams(window.location.search);
const orderId = urlParams.get('orderId') || urlParams.get('PayerID') || null;
const token = localStorage.getItem('customerToken');

if (orderId && token) {
    const paypalOrderId = urlParams.get('token') || urlParams.get('paymentId');
    if (paypalOrderId) {
        fetch('/api/payments/paypal/capture', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({
                orderId: orderId,
                paypalOrderId: paypalOrderId
            })
        })
        .then(res => res.json())
        .then(data => {
            if (data.success) {
                console.log('✅ Payment captured successfully');
            } else {
                console.error('❌ Payment capture failed:', data.message);
            }
        })
        .catch(err => console.error('❌ Capture error:', err));
    }
}