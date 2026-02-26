-- ============================================================================
-- Alter script: Add license tier (paid / free) for existing databases
-- ============================================================================
-- Run this on databases that were created before the tier column existed.
-- Safe to run multiple times (idempotent).
-- ============================================================================

-- 1. Add tier column to licenses
ALTER TABLE public.licenses
    ADD COLUMN IF NOT EXISTS tier text NOT NULL DEFAULT 'paid';

-- 2. Ensure check constraint (drop if exists to avoid duplicate)
ALTER TABLE public.licenses
    DROP CONSTRAINT IF EXISTS licenses_tier_check;
ALTER TABLE public.licenses
    ADD CONSTRAINT licenses_tier_check CHECK (tier IN ('free', 'paid'));

-- 3. Index for tier (e.g. for filtering giveaways vs paid)
CREATE INDEX IF NOT EXISTS idx_licenses_tier
    ON public.licenses USING btree (tier) TABLESPACE pg_default;

-- 4. Update user_license_tier: 'paid' only when user has a valid license with tier = 'paid'
CREATE OR REPLACE FUNCTION public.user_license_tier(p_user_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    has_valid_paid boolean;
BEGIN
    SELECT EXISTS (
        SELECT 1
        FROM public.device_activations da
        JOIN public.licenses l ON l.id = da.license_id
        WHERE da.user_id = p_user_id
          AND l.is_active = true
          AND l.tier = 'paid'
          AND (l.expires_at IS NULL OR l.expires_at > now())
    ) INTO has_valid_paid;
    
    IF has_valid_paid THEN
        RETURN 'paid';
    ELSE
        RETURN 'free';
    END IF;
END;
$$;

-- 5. user_has_paid_license: true only when user has a valid paid (non-giveaway) license
CREATE OR REPLACE FUNCTION public.user_has_paid_license(p_user_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    RETURN public.user_license_tier(p_user_id) = 'paid';
END;
$$;

-- 6. create_license: add p_tier parameter ('paid' or 'free')
CREATE OR REPLACE FUNCTION public.create_license(
    p_license_key text,
    p_max_devices integer DEFAULT 3,
    p_expires_at timestamp with time zone DEFAULT NULL,
    p_tier text DEFAULT 'paid'
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    new_id uuid;
    tier_val text;
BEGIN
    tier_val := lower(trim(p_tier));
    IF tier_val NOT IN ('free', 'paid') THEN
        tier_val := 'paid';
    END IF;
    INSERT INTO public.licenses (license_key, tier, is_active, max_devices, expires_at)
    VALUES (trim(p_license_key), tier_val, true, greatest(1, p_max_devices), p_expires_at)
    RETURNING id INTO new_id;
    RETURN new_id;
END;
$$;

-- ============================================================================
-- Optional: Grant execute on new create_license signature to service_role
-- GRANT EXECUTE ON FUNCTION public.create_license(text, integer, timestamp with time zone, text) TO service_role;
-- ============================================================================
