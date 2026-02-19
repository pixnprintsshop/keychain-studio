-- ============================================================================
-- Complete Licensing System SQL Script
-- ============================================================================
-- This script sets up the complete licensing system for Keychain Studio
-- Includes: licenses, device_activations, user_trials tables, functions, and RLS policies
-- ============================================================================

-- ============================================================================
-- 1. Helper Function: Update updated_at timestamp
-- ============================================================================
-- This function is used by triggers to automatically update the updated_at column

CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- 2. Licenses Table
-- ============================================================================
-- Stores license keys and their metadata

CREATE TABLE IF NOT EXISTS public.licenses (
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    license_key text NOT NULL,
    is_active boolean NULL DEFAULT true,
    expires_at timestamp with time zone NULL,
    max_devices integer NULL DEFAULT 3,
    created_at timestamp with time zone NULL DEFAULT now(),
    updated_at timestamp with time zone NULL DEFAULT now(),
    CONSTRAINT licenses_pkey PRIMARY KEY (id),
    CONSTRAINT licenses_license_key_key UNIQUE (license_key)
) TABLESPACE pg_default;

-- Indexes for licenses table
CREATE INDEX IF NOT EXISTS idx_licenses_license_key 
    ON public.licenses USING btree (license_key) TABLESPACE pg_default;

CREATE INDEX IF NOT EXISTS idx_licenses_is_active 
    ON public.licenses USING btree (is_active) TABLESPACE pg_default;

-- Trigger to auto-update updated_at
CREATE TRIGGER update_licenses_updated_at 
    BEFORE UPDATE ON public.licenses 
    FOR EACH ROW 
    EXECUTE FUNCTION update_updated_at_column();

-- ============================================================================
-- 3. Device Activations Table
-- ============================================================================
-- Tracks which users have activated which licenses
-- Uses user_id (from auth.users) for user-based licensing

CREATE TABLE IF NOT EXISTS public.device_activations (
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    license_id uuid NOT NULL,
    user_id uuid NULL, -- References auth.users(id)
    device_id text NULL, -- Optional, kept for backward compatibility
    device_name text NULL,
    activated_at timestamp with time zone NULL DEFAULT now(),
    last_validated_at timestamp with time zone NULL DEFAULT now(),
    CONSTRAINT device_activations_pkey PRIMARY KEY (id),
    CONSTRAINT device_activations_license_id_user_id_key UNIQUE (license_id, user_id),
    CONSTRAINT device_activations_license_id_fkey 
        FOREIGN KEY (license_id) 
        REFERENCES public.licenses (id) 
        ON DELETE CASCADE
) TABLESPACE pg_default;

-- Add user_id column if it doesn't exist (for migrations)
ALTER TABLE public.device_activations 
    ADD COLUMN IF NOT EXISTS user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE;

-- Indexes for device_activations table
CREATE INDEX IF NOT EXISTS idx_device_activations_license_id 
    ON public.device_activations USING btree (license_id) TABLESPACE pg_default;

CREATE INDEX IF NOT EXISTS idx_device_activations_user_id 
    ON public.device_activations USING btree (user_id) TABLESPACE pg_default;

CREATE INDEX IF NOT EXISTS idx_device_activations_device_id 
    ON public.device_activations USING btree (device_id) TABLESPACE pg_default;

-- ============================================================================
-- 4. User Trials Table
-- ============================================================================
-- Tracks free trials per user account (one trial per user)

CREATE TABLE IF NOT EXISTS public.user_trials (
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL,
    trial_started_at timestamp with time zone NOT NULL DEFAULT now(),
    trial_expires_at timestamp with time zone NOT NULL,
    is_active boolean NULL DEFAULT true,
    created_at timestamp with time zone NULL DEFAULT now(),
    updated_at timestamp with time zone NULL DEFAULT now(),
    CONSTRAINT user_trials_pkey PRIMARY KEY (id),
    CONSTRAINT user_trials_user_id_key UNIQUE (user_id)
) TABLESPACE pg_default;

-- Indexes for user_trials table
CREATE INDEX IF NOT EXISTS idx_user_trials_user_id 
    ON public.user_trials USING btree (user_id) TABLESPACE pg_default;

CREATE INDEX IF NOT EXISTS idx_user_trials_is_active 
    ON public.user_trials USING btree (is_active) TABLESPACE pg_default;

-- Trigger to auto-update updated_at
CREATE TRIGGER update_user_trials_updated_at 
    BEFORE UPDATE ON public.user_trials 
    FOR EACH ROW 
    EXECUTE FUNCTION update_updated_at_column();

-- ============================================================================
-- 5. Functions
-- ============================================================================

-- Function to check if a user can start a trial
-- Returns true if user has never had an active trial, false otherwise
CREATE OR REPLACE FUNCTION can_user_start_trial(p_user_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    existing_trial_count integer;
BEGIN
    -- Check if user already has an active trial
    SELECT COUNT(*) INTO existing_trial_count
    FROM public.user_trials
    WHERE user_id = p_user_id
        AND is_active = true;
    
    RETURN existing_trial_count = 0;
END;
$$;

-- ============================================================================
-- 6. Row Level Security (RLS) Policies
-- ============================================================================
-- Enable RLS on all tables
ALTER TABLE public.licenses ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.device_activations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_trials ENABLE ROW LEVEL SECURITY;

-- Policies for licenses table
-- Users can only read active licenses (for validation)
CREATE POLICY "Users can view active licenses" 
    ON public.licenses 
    FOR SELECT 
    USING (is_active = true);

-- Only service role can insert/update/delete licenses
-- (This should be done through your backend/admin panel)

-- Policies for device_activations table
-- Users can only view their own activations
CREATE POLICY "Users can view own activations" 
    ON public.device_activations 
    FOR SELECT 
    USING (auth.uid() = user_id);

-- Users can insert their own activations
CREATE POLICY "Users can create own activations" 
    ON public.device_activations 
    FOR INSERT 
    WITH CHECK (auth.uid() = user_id);

-- Users can update their own activations
CREATE POLICY "Users can update own activations" 
    ON public.device_activations 
    FOR UPDATE 
    USING (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);

-- Policies for user_trials table
-- Users can only view their own trial
CREATE POLICY "Users can view own trial" 
    ON public.user_trials 
    FOR SELECT 
    USING (auth.uid() = user_id);

-- Users can create their own trial (via function)
CREATE POLICY "Users can create own trial" 
    ON public.user_trials 
    FOR INSERT 
    WITH CHECK (auth.uid() = user_id);

-- Users can update their own trial
CREATE POLICY "Users can update own trial" 
    ON public.user_trials 
    FOR UPDATE 
    USING (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);

-- ============================================================================
-- 7. Grant Permissions
-- ============================================================================
-- Grant necessary permissions to authenticated users

GRANT USAGE ON SCHEMA public TO authenticated;
GRANT SELECT ON public.licenses TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.device_activations TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.user_trials TO authenticated;
GRANT EXECUTE ON FUNCTION can_user_start_trial(uuid) TO authenticated;

-- ============================================================================
-- Notes:
-- ============================================================================
-- 1. License keys should be created through your admin panel/backend
-- 2. Users can only see and manage their own activations and trials
-- 3. The can_user_start_trial function is SECURITY DEFINER to allow
--    server-side validation even when called from client
-- 4. device_id column in device_activations is kept for backward compatibility
--    but is optional - the system now primarily uses user_id
-- 5. Make sure to run this script as a database superuser or with appropriate
--    permissions to create functions and set up RLS policies
-- ============================================================================
