-- Create payout_details table in Supabase
-- Run this SQL in your Supabase SQL Editor

CREATE TABLE IF NOT EXISTS public.payout_details (
  partner_id TEXT PRIMARY KEY,
  email TEXT,
  bank_name TEXT,
  account_number TEXT,
  bic TEXT,
  usdt_trc20 TEXT,
  usdt_erc20 TEXT,
  usdc_polygon TEXT,
  usdc_erc20 TEXT,
  preferred_method TEXT,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Enable RLS (Row Level Security)
ALTER TABLE public.payout_details ENABLE ROW LEVEL SECURITY;

-- Create a policy that allows all operations (adjust as needed for security)
DROP POLICY IF EXISTS "Allow all for payout_details" ON public.payout_details;
CREATE POLICY "Allow all for payout_details" ON public.payout_details
  FOR ALL USING (true) WITH CHECK (true);

-- Optional: Create an index on partner_id for faster queries
CREATE INDEX IF NOT EXISTS idx_payout_details_partner_id ON public.payout_details(partner_id);
