// ============================================================
//  MINIFY PAGE JAVASCRIPT
// ============================================================

async function loadStats() {
    try {
        const response = await fetch('/api/admin/assets/stats', {
            headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` }
        });
        const data = await response.json();
        if (data.success) {
            document.getElementById('jsCount').textContent = data.jsCount;
            document.getElementById('cssCount').textContent = data.cssCount;
            document.getElementById('totalSize').textContent = data.totalSize;
        }
    } catch (err) {
        console.error('Stats error:', err);
    }
}

async function minifyAssets() {
    const btn = document.getElementById('minifyBtn');
    const output = document.getElementById('output');
    
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> Minifying...';
    
    output.className = 'output show';
    output.innerHTML = `
        <div class="icon">⏳</div>
        <div class="title">Minifying assets...</div>
        <div class="details">Please wait, this may take a moment.</div>
    `;
    
    try {
        const response = await fetch('/api/admin/minify', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${localStorage.getItem('token')}`
            }
        });
        
        const data = await response.json();
        
        if (data.success) {
            let filesHtml = data.files.map(f => `
                <div class="file">
                    <span>${f}</span>
                    <span style="color:#16a34a;">✅</span>
                </div>
            `).join('');
            
            output.className = 'output show success';
            output.innerHTML = `
                <div class="icon">✅</div>
                <div class="title">${data.message}</div>
                <div class="details">
                    <p><strong>Files Minified:</strong> ${data.files.length}</p>
                    <p><strong>Total Reduction:</strong> ${data.totalReduction}</p>
                    <div style="margin-top:8px;"><strong>Files:</strong></div>
                    ${filesHtml}
                </div>
            `;
            loadStats();
        } else {
            output.className = 'output show error';
            output.innerHTML = `
                <div class="icon">❌</div>
                <div class="title">Failed to minify assets</div>
                <div class="details">${data.error || 'Unknown error'}</div>
            `;
        }
    } catch (err) {
        output.className = 'output show error';
        output.innerHTML = `
            <div class="icon">❌</div>
            <div class="title">Network Error</div>
            <div class="details">${err.message}</div>
        `;
    }
    
    btn.disabled = false;
    btn.innerHTML = '<i class="fas fa-compress"></i> Minify Assets';
}

document.addEventListener('DOMContentLoaded', loadStats);