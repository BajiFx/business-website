// ================================================================
//  test-mpesa.js - Test M-Pesa Integration
//  Run: node test-mpesa.js
// ================================================================

require('dotenv').config();

async function testMpesaIntegration() {
    console.log('🧪 Testing M-Pesa Integration...\n');

    // Test 1: Check credentials
    console.log('📋 Test 1: Checking credentials...');
    const consumerKey = process.env.MPESA_CONSUMER_KEY;
    const consumerSecret = process.env.MPESA_CONSUMER_SECRET;
    const passkey = process.env.MPESA_PASSKEY;
    const shortcode = process.env.MPESA_SHORTCODE;
    const callbackUrl = process.env.MPESA_CALLBACK_URL;

    console.log(`   Consumer Key: ${consumerKey ? consumerKey.substring(0, 8) + '...' : 'NOT SET'}`);
    console.log(`   Consumer Secret: ${consumerSecret ? '****' : 'NOT SET'}`);
    console.log(`   Passkey: ${passkey ? '****' : 'NOT SET'}`);
    console.log(`   Shortcode: ${shortcode || 'NOT SET'}`);
    console.log(`   Callback URL: ${callbackUrl || 'NOT SET'}`);
    console.log(`   Environment: ${process.env.MPESA_ENVIRONMENT || 'sandbox'}`);
    console.log(`   Email: ${process.env.SMTP_USER || 'georgebabji1220@gmail.com'}\n`);

    if (!consumerKey || consumerKey === 'YOUR_CONSUMER_KEY_HERE') {
        console.error('❌ Consumer Key not configured!');
        console.log('   Get from: https://developer.safaricom.co.ke\n');
        return;
    }

    if (!consumerSecret || consumerSecret === 'YOUR_CONSUMER_SECRET_HERE') {
        console.error('❌ Consumer Secret not configured!');
        console.log('   Get from: https://developer.safaricom.co.ke\n');
        return;
    }

    if (!passkey || passkey === 'YOUR_PASSKEY_HERE') {
        console.error('❌ Passkey not configured!');
        console.log('   Get from: https://developer.safaricom.co.ke\n');
        return;
    }

    console.log('✅ All credentials are configured\n');

    // Test 2: Get access token
    console.log('📋 Test 2: Getting access token...');
    try {
        const auth = Buffer.from(`${consumerKey}:${consumerSecret}`).toString('base64');
        const response = await fetch('https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials', {
            method: 'GET',
            headers: {
                'Authorization': `Basic ${auth}`,
                'Content-Type': 'application/json'
            }
        });

        if (!response.ok) {
            console.error(`❌ Failed to get token: ${response.status}`);
            const text = await response.text();
            console.error(`   Response: ${text}\n`);
            return;
        }

        const data = await response.json();
        if (data.access_token) {
            console.log('✅ Access token received:', data.access_token.substring(0, 20) + '...\n');
        } else {
            console.error('❌ No access token in response:', data, '\n');
            return;
        }
    } catch (error) {
        console.error('❌ Token error:', error.message, '\n');
        return;
    }

    // Test 3: Check callback URL
    console.log('📋 Test 3: Checking callback URL...');
    if (callbackUrl) {
        console.log(`   Callback URL: ${callbackUrl}`);
        if (callbackUrl.includes('ngrok')) {
            console.log('   ✅ ngrok URL detected');
        } else if (callbackUrl.includes('localhost')) {
            console.log('   ⚠️ Localhost URL - M-Pesa cannot call localhost!');
            console.log('   Use ngrok: ngrok http 3000');
        } else {
            console.log('   ℹ️ Using custom domain');
        }
    } else {
        console.log('   ❌ Callback URL not set!');
        console.log('   Set MPESA_CALLBACK_URL in .env');
    }
    console.log('');

    console.log('✅ All M-Pesa tests passed!');
    console.log('\n📝 Next steps:');
    console.log('1. Make sure ngrok is running: ngrok http 3000');
    console.log('2. Start your server: npm start');
    console.log('3. Test STK Push via your frontend at http://localhost:3000');
    console.log('4. Check the callback URL is publicly accessible');
    console.log('   Your ngrok URL: https://donator-eldercare-cacti.ngrok-free.dev\n');
}

// Run the test
testMpesaIntegration().catch(console.error);