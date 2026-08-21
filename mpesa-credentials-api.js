// ================================================================
//  M-PESA CREDENTIALS MANAGEMENT API
// ================================================================

/**
 * Save M-Pesa Credentials to .env
 * POST /api/mpesa/save-credentials
 */
app.post('/api/mpesa/save-credentials', authMiddleware, async (req, res) => {
  if (req.role !== 'admin') {
    return res.status(403).json({ error: 'Admin only' });
  }

  try {
    const { consumerKey, consumerSecret, passkey, shortcode, callbackUrl, environment } = req.body;

    if (!consumerKey || !consumerSecret || !passkey) {
      return res.status(400).json({ error: 'Consumer Key, Consumer Secret, and Passkey are required' });
    }

    // Read current .env
    const envPath = path.join(__dirname, '.env');
    let envContent = '';
    
    if (fs.existsSync(envPath)) {
      envContent = fs.readFileSync(envPath, 'utf8');
    }

    // Update M-Pesa entries
    const lines = envContent.split('\n');
    const newLines = [];
    const mpesaKeys = {
      'MPESA_CONSUMER_KEY': consumerKey,
      'MPESA_CONSUMER_SECRET': consumerSecret,
      'MPESA_PASSKEY': passkey,
      'MPESA_SHORTCODE': shortcode || '174379',
      'MPESA_CALLBACK_URL': callbackUrl || '',
      'MPESA_ENVIRONMENT': environment || 'sandbox'
    };

    let updated = false;
    for (const line of lines) {
      let isMpesaKey = false;
      for (const [key, value] of Object.entries(mpesaKeys)) {
        if (line.trim().startsWith(`${key}=`)) {
          newLines.push(`${key}=${value}`);
          isMpesaKey = true;
          updated = true;
          delete mpesaKeys[key];
          break;
        }
      }
      if (!isMpesaKey) {
        newLines.push(line);
      }
    }

    // Add any missing keys
    for (const [key, value] of Object.entries(mpesaKeys)) {
      if (value && value.trim()) {
        newLines.push(`${key}=${value}`);
        updated = true;
      }
    }

    // Write to .env
    fs.writeFileSync(envPath, newLines.join('\n'));

    // Log the activity
    await logAdminActivity(req.userId, 'UPDATE_MPESA_CREDENTIALS', {
      environment: environment || 'sandbox',
      shortcode: shortcode || '174379'
    });

    res.json({
      success: true,
      message: 'M-Pesa credentials saved successfully'
    });

  } catch (error) {
    console.error('❌ Error saving M-Pesa credentials:', error);
    res.status(500).json({
      error: 'Failed to save credentials: ' + error.message
    });
  }
});

/**
 * Test M-Pesa Connection
 * GET /api/mpesa/test-connection
 */
app.get('/api/mpesa/test-connection', authMiddleware, async (req, res) => {
  if (req.role !== 'admin') {
    return res.status(403).json({ error: 'Admin only' });
  }

  try {
    const consumerKey = process.env.MPESA_CONSUMER_KEY;
    const consumerSecret = process.env.MPESA_CONSUMER_SECRET;

    if (!consumerKey || !consumerSecret || consumerKey === 'YOUR_CONSUMER_KEY_HERE') {
      return res.status(400).json({
        success: false,
        error: 'M-Pesa credentials are not configured'
      });
    }

    const auth = Buffer.from(`${consumerKey}:${consumerSecret}`).toString('base64');
    const response = await fetch('https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials', {
      method: 'GET',
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/json'
      }
    });

    if (response.ok) {
      const data = await response.json();
      res.json({
        success: true,
        message: 'Successfully connected to Safaricom API',
        environment: process.env.MPESA_ENVIRONMENT || 'sandbox'
      });
    } else {
      const text = await response.text();
      res.status(400).json({
        success: false,
        error: `Failed to connect: ${response.status} - ${text}`
      });
    }

  } catch (error) {
    console.error('❌ M-Pesa connection test error:', error);
    res.status(500).json({
      success: false,
      error: 'Connection test failed: ' + error.message
    });
  }
});