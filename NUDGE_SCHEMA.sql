-- ============= NUDGE RECORDS TABLE =============
-- Stores all email nudges sent to partners/clients for audit trail

CREATE TABLE IF NOT EXISTS nudges (
  id BIGSERIAL PRIMARY KEY,
  
  -- Nudge details
  recipient_email TEXT NOT NULL,
  recipient_name TEXT NOT NULL,
  referrer_name TEXT,
  nudge_type TEXT NOT NULL, -- 'Complete KYC', 'Fund Account', etc.
  tier INTEGER NOT NULL,    -- Network tier: 1, 2, or 3
  
  -- Tracking
  partner_id TEXT NOT NULL,                -- ID of partner who sent the nudge
  email_message_id TEXT,                   -- Message ID from Gmail (for tracking delivery)
  status TEXT DEFAULT 'sent',              -- sent, bounced, opened (for future)
  
  -- Timestamps
  sent_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  opened_at TIMESTAMP WITH TIME ZONE,      -- When recipient opens (if tracked)
  
  -- Raw response (for debugging)
  backend_response JSONB,
  
  -- Metadata
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS nudges_partner_id_idx ON nudges(partner_id);
CREATE INDEX IF NOT EXISTS nudges_recipient_email_idx ON nudges(recipient_email);
CREATE INDEX IF NOT EXISTS nudges_sent_at_idx ON nudges(sent_at DESC);
CREATE INDEX IF NOT EXISTS nudges_nudge_type_idx ON nudges(nudge_type);

-- ============= NOTES =============
/*
To use this in Supabase:

1. Go to SQL Editor in Supabase dashboard
2. Copy this entire script
3. Click "Run"
4. Verify table is created in Tables view

Table will store:
- All nudges sent (automatic via sendNudgeEmail function)
- Recipient email, name, nudge type
- Partner/referrer information
- Email Message ID for tracking
- Timestamps for analytics

Queries you can run:
- Get all nudges for a partner: 
  SELECT * FROM nudges WHERE partner_id = '123' ORDER BY sent_at DESC;
  
- Get nudge stats by type:
  SELECT nudge_type, COUNT(*) as total, COUNT(DISTINCT recipient_email) as unique_recipients 
  FROM nudges GROUP BY nudge_type;
  
- Get recent nudges:
  SELECT * FROM nudges ORDER BY sent_at DESC LIMIT 50;
*/
