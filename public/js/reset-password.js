// ============================================================
//  RESET PASSWORD JAVASCRIPT
// ============================================================

const urlParams = new URLSearchParams(window.location.search);
const token = urlParams.get('token');

if (token) {
    document.getElementById('step1').style.display = 'none';
    document.getElementById('step2').style.display = 'block';
    document.getElementById('pageSub').textContent = 'Enter your new password.';
}

async function requestReset() {
    const email = document.getElementById('resetEmail').value.trim();
    const status = document.getElementById('status');
    if (!email) {
        status.className = 'status error';
        status.textContent = '❌ Please enter your email address.';
        return;
    }

    status.className = 'status';
    status.textContent = '⏳ Sending reset link...';

    try {
        const res = await fetch('/api/auth/forgot-password', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email })
        });
        const data = await res.json();
        if (data.success) {
            status.className = 'status success';
            status.textContent = '✅ If your email is registered, you will receive a reset link.';
            document.getElementById('resetEmail').value = '';
        } else {
            status.className = 'status error';
            status.textContent = '❌ ' + (data.error || 'Something went wrong.');
        }
    } catch (err) {
        status.className = 'status error';
        status.textContent = '❌ Network error. Please try again.';
    }
}

async function resetPassword() {
    const password = document.getElementById('newPassword').value;
    const confirm = document.getElementById('confirmPassword').value;
    const status = document.getElementById('status');

    if (!password || password.length < 6) {
        status.className = 'status error';
        status.textContent = '❌ Password must be at least 6 characters.';
        return;
    }
    if (password !== confirm) {
        status.className = 'status error';
        status.textContent = '❌ Passwords do not match.';
        return;
    }

    status.className = 'status';
    status.textContent = '⏳ Resetting password...';

    try {
        const res = await fetch('/api/auth/reset-password', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token, password })
        });
        const data = await res.json();
        if (data.success) {
            status.className = 'status success';
            status.textContent = '✅ ' + data.message + ' Redirecting...';
            setTimeout(() => {
                window.location.href = '/';
            }, 2000);
        } else {
            status.className = 'status error';
            status.textContent = '❌ ' + (data.error || 'Reset failed.');
        }
    } catch (err) {
        status.className = 'status error';
        status.textContent = '❌ Network error. Please try again.';
    }
}