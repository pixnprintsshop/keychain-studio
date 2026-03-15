import { supabase } from "./supabase";
import type { User } from "@supabase/supabase-js";

// Storage keys
const STORAGE_LICENSE_KEY = "keychain-studio-license-key";
const STORAGE_LICENSE_DATA = "keychain-studio-license-data";

// Trial duration in days
const TRIAL_DURATION_DAYS = 7;

// Cache checkLicenseStatus result to avoid many requests to license/user_trials/device_activation
const LICENSE_STATUS_CACHE_TTL_MS = 2 * 60 * 1000; // 2 minutes
let licenseStatusCache: {
    userId: string;
    status: LicenseStatus;
    expiresAt: number;
} | null = null;

export interface LicenseStatus {
    type: "trial" | "licensed" | "expired";
    /** True only when type === "licensed" (paid license); false for trial, expired, or free/giveaway license. */
    isPaid: boolean;
    trialDaysRemaining?: number;
    licenseKey?: string;
    expiresAt?: Date;
    deviceCount?: number;
    maxDevices?: number;
    canExport: boolean;
}

export interface LicenseData {
    id: string;
    license_key: string;
    /** 'paid' = purchased license, 'free' = giveaway. Used for isPaid and paid-only features. */
    tier?: string;
    is_active: boolean;
    expires_at: string | null;
    max_devices: number;
}

export interface UserTrial {
    id: string;
    user_id: string;
    trial_started_at: string;
    trial_expires_at: string;
    is_active: boolean;
}

export interface DeviceActivation {
    id: string;
    license_id: string;
    user_id: string;
    device_id: string | null;
    device_name: string | null;
    activated_at: string;
    last_validated_at: string;
}

/**
 * Get stored license key
 */
export function getStoredLicenseKey(): string | null {
    return localStorage.getItem(STORAGE_LICENSE_KEY);
}

/**
 * Get stored license data
 */
export function getStoredLicenseData(): LicenseData | null {
    const data = localStorage.getItem(STORAGE_LICENSE_DATA);
    if (!data) return null;
    try {
        return JSON.parse(data);
    } catch {
        return null;
    }
}

/**
 * Store license information
 */
export function storeLicense(
    licenseKey: string,
    licenseData: LicenseData,
): void {
    localStorage.setItem(STORAGE_LICENSE_KEY, licenseKey);
    localStorage.setItem(STORAGE_LICENSE_DATA, JSON.stringify(licenseData));
    licenseStatusCache = null; // next checkLicenseStatus will refetch
}

/**
 * Clear license information
 */
export function clearLicense(): void {
    localStorage.removeItem(STORAGE_LICENSE_KEY);
    localStorage.removeItem(STORAGE_LICENSE_DATA);
    licenseStatusCache = null;
}

/**
 * Initialize trial for user (server-side)
 * Returns true if trial was successfully initialized
 */
export async function initializeTrial(userId: string): Promise<boolean> {
    try {
        // Check if user already has a trial row (active or deactivated; table has unique on user_id)
        const { data: existingTrial, error: checkError } = await supabase
            .from("user_trials")
            .select("id")
            .eq("user_id", userId)
            .maybeSingle();

        if (checkError) {
            console.error("Error checking trial:", checkError);
            // Don't fail completely, try to create trial anyway
        }

        if (existingTrial) {
            // User already has a trial row - do not insert (would violate user_id unique constraint)
            return true;
        }

        // Check if user can start a trial
        const { data: canStart, error: functionError } = await supabase.rpc(
            "can_user_start_trial",
            {
                p_user_id: userId,
            },
        );

        if (functionError) {
            console.error("Error checking trial eligibility:", functionError);
            // If RPC fails, still try to create trial (graceful degradation)
            // This handles cases where RLS might block the function call
        }

        if (functionError === null && canStart === false) {
            // User cannot start a new trial (only if function succeeded and returned false)
            console.warn("User cannot start trial (already had one)");
            return false;
        }

        // Create new trial on server
        const trialStartedAt = new Date();
        const trialExpiresAt = new Date();
        trialExpiresAt.setDate(trialExpiresAt.getDate() + TRIAL_DURATION_DAYS);

        const { data: newTrial, error: createError } = await supabase
            .from("user_trials")
            .insert({
                user_id: userId,
                trial_started_at: trialStartedAt.toISOString(),
                trial_expires_at: trialExpiresAt.toISOString(),
                is_active: true,
            })
            .select()
            .single();

        if (createError) {
            // Check if error is due to duplicate (user already has trial)
            if (createError.code === "23505") {
                // Unique constraint violation - user already has a trial
                console.log("Trial already exists for user");
                return true;
            }
            console.error("Error creating trial:", createError);
            return false;
        }

        if (!newTrial) {
            console.error("Trial creation returned no data");
            return false;
        }

        console.log("Trial initialized successfully:", newTrial.id);
        return true;
    } catch (error) {
        console.error("Error initializing trial:", error);
        return false;
    }
}

/**
 * Get trial start date from server
 */
export async function getTrialStartDate(userId: string): Promise<Date | null> {
    try {
        const { data: trial, error } = await supabase
            .from("user_trials")
            .select("trial_started_at, trial_expires_at")
            .eq("user_id", userId)
            .eq("is_active", true)
            .maybeSingle();

        if (error && error.code !== "PGRST116") {
            console.error("Error fetching trial:", error);
        }

        if (trial) {
            return new Date(trial.trial_started_at);
        }

        return null;
    } catch (error) {
        console.error("Error getting trial start date:", error);
        return null;
    }
}

/**
 * Calculate remaining trial days (uses server-side data)
 */
export async function getTrialDaysRemaining(userId: string): Promise<number> {
    try {
        const { data: trial, error } = await supabase
            .from("user_trials")
            .select("trial_expires_at, trial_started_at")
            .eq("user_id", userId)
            .eq("is_active", true)
            .maybeSingle();

        if (error && error.code !== "PGRST116") {
            console.error("Error fetching trial for days remaining:", error);
        }

        if (trial) {
            const expiresAt = new Date(trial.trial_expires_at);
            const now = new Date();
            const diffTime = expiresAt.getTime() - now.getTime();
            const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
            const remaining = Math.max(0, diffDays);
            console.log(
                `Trial expires in ${remaining} days (expires: ${trial.trial_expires_at})`,
            );
            return remaining;
        }

        console.log("No active trial found for user");
        return 0;
    } catch (error) {
        console.error("Error calculating trial days:", error);
        return 0;
    }
}

/**
 * Check if trial is expired (uses server-side data)
 */
export async function isTrialExpired(userId: string): Promise<boolean> {
    const remaining = await getTrialDaysRemaining(userId);
    return remaining === 0;
}

/**
 * Restore license from server if the user already has an active activation.
 * This handles the case where localStorage is empty (new browser, cleared storage)
 * but the user previously activated a license on their account.
 */
async function restoreLicenseFromServer(
    userId: string,
): Promise<LicenseData | null> {
    try {
        // Check if the user has any device activations
        const { data: activation, error: activationError } = await supabase
            .from("device_activations")
            .select("license_id")
            .eq("user_id", userId)
            .order("last_validated_at", { ascending: false })
            .limit(1)
            .maybeSingle();

        if (activationError || !activation) {
            return null;
        }

        // Fetch the linked license (use maybeSingle so inactive/missing returns null, not PGRST116)
        const { data: license, error: licenseError } = await supabase
            .from("licenses")
            .select("*")
            .eq("id", activation.license_id)
            .eq("is_active", true)
            .maybeSingle();

        if (licenseError || !license) {
            return null;
        }

        // Check expiry
        if (license.expires_at) {
            const expiresAt = new Date(license.expires_at);
            if (expiresAt < new Date()) {
                return null;
            }
        }

        // Restore to localStorage so subsequent checks are fast
        const licenseData: LicenseData = {
            id: license.id,
            license_key: license.license_key,
            tier: license.tier ?? "paid",
            is_active: license.is_active,
            expires_at: license.expires_at,
            max_devices: license.max_devices,
        };
        storeLicense(license.license_key, licenseData);

        // Update last_validated_at on the activation
        await supabase
            .from("device_activations")
            .update({ last_validated_at: new Date().toISOString() })
            .eq("license_id", license.id)
            .eq("user_id", userId);

        console.log("License restored from server for user");
        return licenseData;
    } catch (error) {
        console.error("Error restoring license from server:", error);
        return null;
    }
}

/**
 * Check license status (trial, licensed, or expired)
 * Results are cached for 2 minutes to avoid many requests to license/user_trials/device_activation.
 */
export async function checkLicenseStatus(
    user: User | null,
): Promise<LicenseStatus> {
    if (!user) {
        return {
            type: "expired",
            isPaid: false,
            canExport: false,
        };
    }

    const now = Date.now();
    if (
        licenseStatusCache?.userId === user.id &&
        licenseStatusCache.expiresAt > now
    ) {
        return licenseStatusCache.status;
    }

    const setCacheAndReturn = (status: LicenseStatus): LicenseStatus => {
        licenseStatusCache = {
            userId: user.id,
            status,
            expiresAt: Date.now() + LICENSE_STATUS_CACHE_TTL_MS,
        };
        return status;
    };

    // Initialize trial if needed (this will create trial if user doesn't have one)
    const trialInitialized = await initializeTrial(user.id);

    // If trial initialization failed, log error but continue to check status
    if (!trialInitialized) {
        console.warn(
            "Trial initialization returned false, but continuing to check status",
        );
    }

    // Check if user has a stored license
    let licenseKey = getStoredLicenseKey();
    let licenseData = getStoredLicenseData();

    // If no local license, try to restore from server (user may have activated on another browser)
    if (!licenseKey || !licenseData) {
        const restored = await restoreLicenseFromServer(user.id);
        if (restored) {
            licenseKey = restored.license_key;
            licenseData = restored;
        }
    }

    if (licenseKey && licenseData) {
        // Validate license with Supabase
        const isValid = await validateDeviceActivation(user.id);
        if (isValid) {
            // If tier is missing from cache (e.g. DB updated after activation), fetch from server
            if (licenseData.tier === undefined) {
                const { data: licenseRow } = await supabase
                    .from("licenses")
                    .select("tier")
                    .eq("license_key", licenseKey)
                    .maybeSingle();
                if (licenseRow?.tier != null) {
                    licenseData = { ...licenseData, tier: licenseRow.tier };
                    storeLicense(licenseKey, licenseData);
                }
            }

            const expiresAt = licenseData.expires_at
                ? new Date(licenseData.expires_at)
                : null;
            const isExpired = expiresAt ? expiresAt < new Date() : false;

            if (isExpired) {
                return setCacheAndReturn({
                    type: "expired",
                    isPaid: false,
                    licenseKey,
                    expiresAt: expiresAt || undefined,
                    canExport: false,
                });
            }

            const isPaidLicense = (licenseData.tier ?? "paid") === "paid";
            return setCacheAndReturn({
                type: "licensed",
                isPaid: isPaidLicense,
                licenseKey,
                expiresAt: expiresAt || undefined,
                maxDevices: licenseData.max_devices,
                canExport: true,
            });
        } else {
            // License validation failed, clear it
            clearLicense();
        }
    }

    // Check trial status (server-side)
    // Wait a bit to ensure trial was created if it was just initialized
    let trialDaysRemaining = await getTrialDaysRemaining(user.id);

    // If no trial found and we just tried to initialize, retry a few times
    if (trialDaysRemaining === 0 && trialInitialized) {
        // Retry with exponential backoff to ensure database write has completed
        for (let attempt = 0; attempt < 3; attempt++) {
            await new Promise((resolve) =>
                setTimeout(resolve, 100 * (attempt + 1)),
            );
            trialDaysRemaining = await getTrialDaysRemaining(user.id);
            if (trialDaysRemaining > 0) {
                console.log(`Trial found after ${attempt + 1} retry attempts`);
                break;
            }
        }
    }

    const trialExpired = trialDaysRemaining === 0;

    if (trialExpired) {
        return setCacheAndReturn({
            type: "expired",
            isPaid: false,
            trialDaysRemaining: 0,
            canExport: false,
        });
    }

    return setCacheAndReturn({
        type: "trial",
        isPaid: false,
        trialDaysRemaining,
        canExport: true, // Trial users can use all features including export
    });
}

/**
 * Validate device activation with Supabase (user-based)
 */
export async function validateDeviceActivation(
    userId: string,
): Promise<boolean> {
    const licenseKey = getStoredLicenseKey();
    if (!licenseKey) return false;

    try {
        // Get license by key (do not require is_active so newly activated license validates even if UPDATE lagged)
        const { data: license, error: licenseError } = await supabase
            .from("licenses")
            .select("*")
            .eq("license_key", licenseKey)
            .maybeSingle();

        if (licenseError || !license) {
            return false;
        }

        // Check if license is expired
        if (license.expires_at) {
            const expiresAt = new Date(license.expires_at);
            if (expiresAt < new Date()) {
                return false;
            }
        }

        // Check user activation (by user_id)
        const { data: activation, error: activationError } = await supabase
            .from("device_activations")
            .select("*")
            .eq("license_id", license.id)
            .eq("user_id", userId)
            .maybeSingle();

        if (activationError && activationError.code !== "PGRST116") {
            return false;
        }

        if (activation) {
            // Update last_validated_at
            await supabase
                .from("device_activations")
                .update({ last_validated_at: new Date().toISOString() })
                .eq("id", activation.id);
            return true;
        } else {
            // No activation for this user: this license is not valid for them.
            // Activations should only be created explicitly via activateLicense().
            return false;
        }
    } catch (error) {
        console.error("Error validating device activation:", error);
        return false;
    }
}

/**
 * Activate license key (user-based)
 */
export async function activateLicense(
    licenseKey: string,
    userId: string,
): Promise<{ success: boolean; error?: string; alreadyActivated?: boolean }> {
    try {
        // Validate license key format (basic check)
        if (!licenseKey || licenseKey.trim().length === 0) {
            return { success: false, error: "License key cannot be empty" };
        }

        const deviceName = `${navigator.platform} - ${navigator.userAgent.split(" ")[0]}`;

        // Clear any existing (e.g. expired) stored license so the new one is the only one in use
        clearLicense();

        // Deactivate trial first (expired or not) so activation is not blocked by trial state
        const { error: trialDeactivateError } = await supabase
            .from("user_trials")
            .update({ is_active: false })
            .eq("user_id", userId);
        if (trialDeactivateError) {
            console.warn("License activation: could not deactivate trial (non-fatal):", trialDeactivateError.message);
        }

        // Get license from Supabase (allow inactive keys so user can activate and we set active on first use)
        const { data: license, error: licenseError } = await supabase
            .from("licenses")
            .select("*")
            .eq("license_key", licenseKey.trim())
            .maybeSingle();

        if (licenseError || !license) {
            return {
                success: false,
                error: "Invalid license key",
            };
        }

        // Check if license is expired
        if (license.expires_at) {
            const expiresAt = new Date(license.expires_at);
            if (expiresAt < new Date()) {
                return {
                    success: false,
                    error: "License has expired",
                };
            }
        }

        // One user per license: RPC bypasses RLS so we see all activations (client SELECT may be restricted)
        const { data: byAnotherUser, error: rpcError } = await supabase.rpc(
            "license_activated_by_another_user",
            { p_license_id: license.id, p_user_id: userId },
        );
        if (rpcError) {
            return {
                success: false,
                error: "Error checking license",
            };
        }
        if (byAnotherUser) {
            return {
                success: false,
                error:
                    "This license is already activated to another account. Each license can only be used by one account.",
            };
        }

        // Get existing activations for this license (for this user: refresh; for device limit check)
        const { data: existingActivations, error: countError } = await supabase
            .from("device_activations")
            .select("id, user_id")
            .eq("license_id", license.id);

        if (countError) {
            return {
                success: false,
                error: "Error checking license",
            };
        }

        const currentDeviceCount = existingActivations?.length || 0;
        const existingActivation = existingActivations?.find(
            (a) => a.user_id === userId,
        );

        // If this user is not already activated, check device limit
        if (!existingActivation) {
            if (currentDeviceCount >= license.max_devices) {
                return {
                    success: false,
                    error: `Device limit reached (${license.max_devices} devices). Please deactivate a device first.`,
                };
            }
        }

        if (existingActivation) {
            // User already activated this license: refresh validation time and ensure license is active
            await supabase
                .from("device_activations")
                .update({
                    last_validated_at: new Date().toISOString(),
                    device_name: deviceName,
                })
                .eq("id", existingActivation.id);
            await supabase.rpc("set_license_active", { p_license_id: license.id });
            // Fall through to store and return with alreadyActivated: true
        } else {
            // Remove all of this user's activations (e.g. expired license) so we replace with the new one
            const { error: deleteError } = await supabase
                .from("device_activations")
                .delete()
                .eq("user_id", userId);
            if (deleteError) {
                console.warn("License activation: could not remove old activations (non-fatal):", deleteError.message);
            }

            // Create new user activation
            const { error: activationError } = await supabase
                .from("device_activations")
                .insert({
                    license_id: license.id,
                    user_id: userId,
                    device_id: null,
                    device_name: deviceName,
                    activated_at: new Date().toISOString(),
                    last_validated_at: new Date().toISOString(),
                });

            if (activationError) {
                return {
                    success: false,
                    error: "Failed to activate license",
                };
            }

            // Set license active on first use (RPC bypasses RLS so DB is updated reliably)
            await supabase.rpc("set_license_active", { p_license_id: license.id });
        }

        // Replace any existing (e.g. expired) license so the new one is the only one in use
        clearLicense();
        storeLicense(licenseKey.trim(), { ...license, is_active: true });

        // Deactivate any trial (expired or not) so status is driven by the license only (non-fatal)
        const { error: trialUpdateError } = await supabase
            .from("user_trials")
            .update({ is_active: false })
            .eq("user_id", userId);
        if (trialUpdateError) {
            console.warn("License activation: could not deactivate trial (non-fatal):", trialUpdateError.message);
        }

        return { success: true, alreadyActivated: !!existingActivation };
    } catch (error) {
        console.error("Error activating license:", error);
        return {
            success: false,
            error: "An unexpected error occurred",
        };
    }
}

/**
 * Get device activation count for current license
 */
export async function getDeviceActivationCount(): Promise<number> {
    const licenseKey = getStoredLicenseKey();
    if (!licenseKey) return 0;

    try {
        const { data: license } = await supabase
            .from("licenses")
            .select("id")
            .eq("license_key", licenseKey)
            .maybeSingle();

        if (!license) return 0;

        const { data: activations } = await supabase
            .from("device_activations")
            .select("id")
            .eq("license_id", license.id);

        return activations?.length || 0;
    } catch {
        return 0;
    }
}
