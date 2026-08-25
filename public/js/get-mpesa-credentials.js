// ============================================================
//  GET M-PESA CREDENTIALS JAVASCRIPT
// ============================================================

function toggleVisibility(id) {
    const input = document.getElementById(id);
    const btn = event.target;
    if (input.type === 'password') {
        input.type = 'text';
        btn.textContent = 'Hide';
    } else {
        input.type = 'password';
        btn.textContent = 'Show';
    }
}

function updateEnvPreview() {
    const consumerKey = document.getElementById('consumerKey').value || 'your_consumer_key';
    const consumerSecret = document.getElementById('consumerSecret').value || 'your_consumer_secret';
    const passkey = document.getElementById('passkey').value || 'your_passkey';
    const shortcode = document.getElementById('shortcode').value || '174379';
    const callbackUrl = document.getElementById('callbackUrl').value || 'https://your-ngrok-url.ngrok.io/api/payments/mpesa-callback';
    const environment = document.getElementById('environment').value || 'sandbox';

    document.getElementById('envOutput').textContent = 
`# M-Pesa Configuration
MPESA_CONSUMER_KEY=${consumerKey}
MPESA_CONSUMER_SECRET=${consumerSecret}
MPESA_PASSKEY=${passkey}
MPESA_SHORTCODE=${shortcode}
MPESA_CALLBACK_URL=${callbackUrl}
MPESA_ENVIRONMENT=${environment}`;
}

// Update preview on any change
document.addEventListener('DOMContentLoaded', () => {
    const inputs = document.querySelectorAll('#consumerKey, #consumerSecret, #passkey, #shortcode, #callbackUrl, #environment');
    inputs.forEach(input => {
        input.addEventListener('input', updateEnvPreview);
        input.addEventListener('change', updateEnvPreview);
    });
    updateEnvPreview();
});

async function saveCredentials() {
    const status = document.getElementById('status');
    const consumerKey = document.getElementById('consumerKey').value.trim();
    const consumerSecret = document.getElementById('consumerSecret').value.trim();
    const passkey = document.getElementById('passkey').value.trim();
    const shortcode = document.getElementById('shortcode').value.trim() || '174379';
    const callbackUrl = document.getElementById('callbackUrl').value.trim();
    const environment = document.getElementById('environment').value;

    if (!consumerKey || !consumerSecret || !passkey) {
        status.className = 'status error';
        status.textContent = '❌ Please fill in all required fields (Consumer Key, Consumer Secret, Passkey).';
        return;
    }

    status.className = 'status loading';
    status.textContent = '⏳ Saving credentials...';

    try {
        const response = await fetch('/api/mpesa/save-credentials', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${localStorage.getItem('token')}`
            },
            body: JSON.stringify({
                consumerKey,
                consumerSecret,
                passkey,
                shortcode,
                callbackUrl,
                environment
            })
        });

        const data = await response.json();

        if (data.success) {
            status.className = 'status success';
            status.textContent = '✅ Credentials saved successfully! You can now use M-Pesa.';
            
            status.textContent += ' 🔍 Testing connection...';
            const testResponse = await fetch('/api/mpesa/test-connection', {
                headers: {
                    'Authorization': `Bearer ${localStorage.getItem('token')}`
                }
            });
            const testData = await testResponse.json();
            if (testData.success) {
                status.textContent = '✅ Credentials saved and verified! M-Pesa is ready to use.';
                status.className = 'status success';
            } else {
                status.textContent += ' ⚠️ Credentials saved but connection test failed. Please check your credentials.';
                status.className = 'status error';
            }
        } else {
            status.className = 'status error';
            status.textContent = '❌ Failed to save credentials: ' + (data.error || 'Unknown error');
        }
    } catch (error) {
        status.className = 'status error';
        status.textContent = '❌ Network error: ' + error.message;
    }
}

function copyEnv() {
    const text = document.getElementById('envOutput').textContent;
    navigator.clipboard.writeText(text).then(() => {
        const btn = event.target;
        const originalText = btn.innerHTML;
        btn.innerHTML = '<i class="fas fa-check"></i> Copied!';
        setTimeout(() => {
            btn.innerHTML = originalText;
        }, 2000);
    }).catch(() => {
        const textarea = document.createElement('textarea');
        textarea.value = text;
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand('copy');
        document.body.removeChild(textarea);
        alert('✅ Copied to clipboard!');
    });
}