const express = require('express');
const cors = require('cors');
const nodemailer = require('nodemailer');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const app = express();

app.use(express.json({ limit: '50mb' }));
app.use(cors({
  origin: [
    process.env.CLIENT_URL || 'http://localhost:5173',
    'http://localhost:5173',
    'http://localhost:3000',
    'http://127.0.0.1:5173'
  ],
  credentials: true
}));

// ============= SUPABASE CLIENT =============
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;

let supabase = null;
if (supabaseUrl && supabaseKey) {
  supabase = createClient(supabaseUrl, supabaseKey);
  console.log('[Supabase] ✅ Client initialized');
} else {
  console.warn('[Supabase] ⚠️ SUPABASE_URL or SUPABASE_KEY not set - payout storage disabled');
}

let emailTransporter = null;

const initializeEmail = () => {
  if (emailTransporter) return emailTransporter;
  
  const smtpHost = process.env.SMTP_HOST;
  const smtpPort = process.env.SMTP_PORT;
  const smtpUser = process.env.SMTP_USER;
  const smtpPassword = process.env.SMTP_PASSWORD;
    
  try {
    emailTransporter = nodemailer.createTransport({
      host: smtpHost,
      port: smtpPort,
      secure: true,
      auth: {
        user: smtpUser,
        pass: smtpPassword
      }
    });
    
   // console.log(`[Email] ✅ Nodemailer configured with Brevo SMTP (${smtpHost}:${smtpPort})`);
    return emailTransporter;
  } catch (err) {
   // console.error('[Email] ❌ Failed to create transporter:', err.message);
    return null;
  }
};

// Initialize on startup
const transporter = initializeEmail();

// Test email connection
if (transporter) {
  transporter.verify((error, success) => {
    if (error) {
      console.error('[Email] ❌ Brevo SMTP connection failed:', error.message);
     // console.error('[Email] Check SMTP_HOST, SMTP_PORT, SMTP_USER, and SMTP_PASSWORD in .env');
    } else {
      console.log('[Email] ✅ Brevo SMTP connection verified!');
    }
  });
}

// ============= EMAIL TEMPLATES =============

const emailTemplates = {
  'Complete KYC': {
    subject: '📋 Complete Your KYC Verification - Nommia IB',
    getBody: (recipientName, referrerName) => `
Dear ${recipientName},

${referrerName} has sent you a reminder to complete your KYC (Know Your Customer) verification.

Benefits of completing KYC:
✓ Unlock full trading features
✓ Increase deposit limits
✓ Access to all account types
✓ Priority support

Complete KYC in just 5 minutes:
1. Log in to your Nommia account
2. Go to Account Settings → Verification
3. Submit your documents
4. We'll review within 24 hours

Questions? Contact support@nommia.io

Best regards,
Nommia Team
    `
  },
  
  'Fund Account': {
    subject: '💰 Fund Your Trading Account - Get Started Today',
    getBody: (recipientName, referrerName) => `
Dear ${recipientName},

${referrerName} encourages you to fund your trading account and start trading with Nommia.

Why fund today?
✓ Start with competitive leverage
✓ Access 24/5 market trading
✓ Zero commissions on select instruments
✓ Professional trading tools

Quick funding options:
• Credit/Debit Card (Instant)
• Bank Transfer (1-3 days)
• E-wallets (Instant)
• Crypto (Instant)

Minimum deposit: $10 USD

Ready to fund? Log in and go to Cashier → Deposit

Questions? Contact support@nommia.io

Best regards,
Nommia Team
    `
  }
};


app.post('/api/nudges/send', async (req, res) => {
  try {
    if (!transporter) {
      return res.status(503).json({ 
        error: 'Email service not configured',
        details: 'Check SMTP_HOST, SMTP_PORT, SMTP_USER, and SMTP_PASSWORD in .env'
      });
    }

    const { 
      recipientEmail, 
      recipientName, 
      referrerName, 
      nudgeType, 
      tier, 
      partnerId 
    } = req.body;

    // Validate required fields
    const missing = [];
    if (!recipientEmail) missing.push('recipientEmail');
    if (!recipientName) missing.push('recipientName');
    if (!referrerName) missing.push('referrerName');
    if (!nudgeType) missing.push('nudgeType');
    if (!tier) missing.push('tier');
    if (!partnerId) missing.push('partnerId');

    if (missing.length > 0) {
      return res.status(400).json({ 
        error: `Missing required fields: ${missing.join(', ')}`
      });
    }

    // Validate nudge type
    if (!emailTemplates[nudgeType]) {
      const validTypes = Object.keys(emailTemplates).join(', ');
      return res.status(400).json({ 
        error: `Invalid nudgeType. Must be one of: ${validTypes}`
      });
    }

    // Validate email
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(recipientEmail)) {
      return res.status(400).json({ 
        error: 'Invalid email address'
      });
    }

    // Get template and build email
    const template = emailTemplates[nudgeType];
    const emailBody = template.getBody(recipientName, referrerName);

    console.log(`[Email] Sending ${nudgeType} to ${recipientEmail}...`);

    // Send email
    const info = await transporter.sendMail({
      from: `"${process.env.SMTP_FROM_NAME}" <${process.env.SMTP_FROM}>`,
      to: recipientEmail,
      subject: template.subject,
      html: `<pre style="font-family: Arial, sans-serif; white-space: pre-wrap; line-height: 1.6;">${emailBody}</pre>`,
      text: emailBody
    });

    console.log(`[Email] ✅ Sent to ${recipientEmail}`);

    res.status(200).json({
      success: true,
      message: `${nudgeType} nudge sent to ${recipientEmail}`,
      messageId: info.messageId,
      timestamp: new Date().toISOString(),
      recipientEmail,
      nudgeType,
      tier
    });

  } catch (error) {
    console.error('[Email] ❌ Error:', error.message);
    res.status(500).json({
      error: 'Failed to send email',
      details: error.message
    });
  }
});

/**
 * GET /api/nudges/health
 */
app.get('/api/nudges/health', (req, res) => {
  const isHealthy = transporter !== null;
  res.status(isHealthy ? 200 : 503).json({
    status: isHealthy ? 'healthy' : 'unhealthy',
    email: isHealthy ? 'configured' : 'not configured',
    service: 'nodemailer-brevo-smtp',
    timestamp: new Date().toISOString()
  });
});

// ============= HEALTH CHECK =============

app.get('/api/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    service: 'nommia-nudge-backend',
    timestamp: new Date().toISOString()
  });
});

app.post('/api/payouts/save', async (req, res) => {
  try {
    if (!supabase) {
      return res.status(503).json({ 
        error: 'Supabase not configured',
        details: 'Set SUPABASE_URL and SUPABASE_KEY in .env'
      });
    }

    const { partnerId, bankName, accountNumber, iban, swiftCode, usdtTrc20, usdtErc20, usdcPolygon, usdcErc20, preferredMethod } = req.body;

    // Validate required fields
    if (!partnerId) {
      return res.status(400).json({ 
        error: 'Missing required field: partnerId'
      });
    }

    console.log(`[Payouts] Saving payout details for partner: ${partnerId}`);

    // Upsert (insert or update)
    const { data, error } = await supabase
      .from('payout_details')
      .upsert({
        partner_id: partnerId,
        bank_name: bankName || null,
        account_number: accountNumber || null,
        iban: iban || null,
        swift_code: swiftCode || null,
        usdt_trc20: usdtTrc20 || null,
        usdt_erc20: usdtErc20 || null,
        usdc_polygon: usdcPolygon || null,
        usdc_erc20: usdcErc20 || null,
        preferred_method: preferredMethod || null,
        updated_at: new Date().toISOString()
      }, { onConflict: 'partner_id' })
      .select();

    if (error) {
      console.error('[Payouts] ❌ Save failed:', error.message);
      return res.status(400).json({ 
        error: 'Failed to save payout details',
        details: error.message
      });
    }

    console.log('[Payouts] ✅ Saved successfully');
    res.status(200).json({
      success: true,
      message: 'Payout details saved successfully',
      data: data[0]
    });
  } catch (err) {
    console.error('[Payouts] ❌ Error:', err.message);
    res.status(500).json({
      error: 'Internal server error',
      details: err.message
    });
  }
});

app.get('/api/payouts/:partnerId', async (req, res) => {
  try {
    if (!supabase) {
      return res.status(503).json({ 
        error: 'Supabase not configured'
      });
    }

    const { partnerId } = req.params;

    if (!partnerId) {
      return res.status(400).json({ 
        error: 'Missing required parameter: partnerId'
      });
    }

    console.log(`[Payouts] Fetching payout details for partner: ${partnerId}`);

    const { data, error } = await supabase
      .from('payout_details')
      .select('*')
      .eq('partner_id', partnerId)
      .single();

    if (error && error.code !== 'PGRST116') {
      // PGRST116 = no rows found (it's okay)
      console.error('[Payouts] ❌ Fetch failed:', error.message);
      return res.status(400).json({ 
        error: 'Failed to fetch payout details',
        details: error.message
      });
    }

    console.log('[Payouts] ✅ Fetched successfully');
    res.status(200).json({
      success: true,
      data: data || null,
      message: data ? 'Payout details found' : 'No payout details saved yet'
    });
  } catch (err) {
    console.error('[Payouts] ❌ Error:', err.message);
    res.status(500).json({
      error: 'Internal server error',
      details: err.message
    });
  }
});

app.delete('/api/payouts/:partnerId', async (req, res) => {
  try {
    if (!supabase) {
      return res.status(503).json({ 
        error: 'Supabase not configured'
      });
    }

    const { partnerId } = req.params;

    if (!partnerId) {
      return res.status(400).json({ 
        error: 'Missing required parameter: partnerId'
      });
    }

    console.log(`[Payouts] Deleting payout details for partner: ${partnerId}`);

    const { error } = await supabase
      .from('payout_details')
      .delete()
      .eq('partner_id', partnerId);

    if (error) {
      console.error('[Payouts] ❌ Delete failed:', error.message);
      return res.status(400).json({ 
        error: 'Failed to delete payout details',
        details: error.message
      });
    }

    console.log('[Payouts] ✅ Deleted successfully');
    res.status(200).json({
      success: true,
      message: 'Payout details deleted successfully'
    });
  } catch (err) {
    console.error('[Payouts] ❌ Error:', err.message);
    res.status(500).json({
      error: 'Internal server error',
      details: err.message
    });
  }
});

app.use((err, req, res, next) => {
  console.error('[Server] Error:', err.message);
  res.status(500).json({
    error: 'Internal server error',
    message: err.message
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    error: 'Not found',
    path: req.path,
    method: req.method
  });
});

const port = process.env.PORT || 5000; 

app.listen(port, '0.0.0.0', () => {
  console.log(`[Server] Running on http://0.0.0.0:${port} (env: ${process.env.NODE_ENV || 'development'})`);
});