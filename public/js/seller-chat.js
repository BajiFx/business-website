// ============================================================
//  SELLER CHAT JAVASCRIPT
// ============================================================

let socket = io();
let messages = [];

socket.on('connect', () => {
    console.log('Seller chat connected');
    socket.emit('request-chat-history');
});

socket.on('chat-history', (msgs) => {
    messages = msgs;
    renderMessages();
});

socket.on('new-chat-message', (msg) => {
    messages.push(msg);
    renderMessages();
});

function renderMessages() {
    const container = document.getElementById('messages');
    if (!messages.length) {
        container.innerHTML = '<p class="empty">💬 No messages yet. Customers will appear here.</p>';
        return;
    }
    container.innerHTML = messages.map(msg => {
        const isCustomer = msg.from === 'Customer' || msg.from_user === 'Customer';
        const sender = isCustomer ? (msg.customer_name || 'Customer') : 'Seller';
        const time = msg.timestamp ? new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
        const messageText = msg.message || msg.text || '';
        return `
            <div class="msg ${isCustomer ? 'customer' : 'seller'}">
                <div class="meta">
                    <span class="sender">${sender}</span>
                    <span class="time">${time}</span>
                </div>
                <div>${messageText}</div>
            </div>
        `;
    }).join('');
    container.scrollTop = container.scrollHeight;
}

function sendMessage() {
    const input = document.getElementById('msgInput');
    const text = input.value.trim();
    if (!text) return;
    socket.emit('chat-message', { from: 'Seller', message: text });
    input.value = '';
    const tempMsg = { from: 'Seller', message: text, timestamp: new Date().toISOString() };
    messages.push(tempMsg);
    renderMessages();
}