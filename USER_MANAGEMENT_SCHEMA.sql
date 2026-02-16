-- User Management Schema for Nommia IB Dashboard
-- Run this SQL in your Supabase SQL Editor

-- Table for tracking user role upgrades (Country Manager, Regional Manager)
CREATE TABLE IF NOT EXISTS public.user_roles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username TEXT UNIQUE NOT NULL,
  email TEXT,
  base_role VARCHAR(50) DEFAULT 'IB', -- IB, CountryManager, RegionalManager
  country_assigned VARCHAR(100), -- For Country Manager
  regions_assigned TEXT[], -- For Regional Manager (array of country codes)
  assigned_by TEXT, -- Admin who made the assignment
  assigned_date TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Table for nudge settings and cooldowns
CREATE TABLE IF NOT EXISTS public.nudge_settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_username TEXT NOT NULL,
  nudge_type VARCHAR(100) NOT NULL, -- 'Complete KYC', 'Fund Account', etc.
  cooldown_hours INTEGER DEFAULT 24, -- Cooldown period between nudges
  max_nudges_per_week INTEGER DEFAULT 3, -- Max nudges per week
  enabled BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(admin_username, nudge_type)
);

-- Table to track nudge sending history and cooldown
CREATE TABLE IF NOT EXISTS public.nudge_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_username TEXT NOT NULL,
  recipient_email TEXT NOT NULL,
  nudge_type VARCHAR(100) NOT NULL,
  sent_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  last_sent_to_recipient TIMESTAMP WITH TIME ZONE,
  FOREIGN KEY (admin_username) REFERENCES public.user_roles(username),
  INDEX idx_recipient_nudge (recipient_email, nudge_type),
  INDEX idx_sent_time (sent_at)
);

-- Enable RLS (Row Level Security)
ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.nudge_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.nudge_history ENABLE ROW LEVEL SECURITY;

-- Allow admins to manage user roles
CREATE POLICY "Allow admins to read user roles" ON public.user_roles
  FOR SELECT USING (true);

CREATE POLICY "Allow admins to manage user roles" ON public.user_roles
  FOR ALL USING (true) WITH CHECK (true);

-- Allow admins to manage nudge settings
CREATE POLICY "Allow nudge settings access" ON public.nudge_settings
  FOR ALL USING (true) WITH CHECK (true);

-- Allow admins to view nudge history
CREATE POLICY "Allow nudge history access" ON public.nudge_history
  FOR ALL USING (true) WITH CHECK (true);

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_user_roles_base_role ON public.user_roles(base_role);
CREATE INDEX IF NOT EXISTS idx_user_roles_country ON public.user_roles(country_assigned);
CREATE INDEX IF NOT EXISTS idx_nudge_settings_admin ON public.nudge_settings(admin_username);
CREATE INDEX IF NOT EXISTS idx_nudge_history_recipient ON public.nudge_history(recipient_email);
