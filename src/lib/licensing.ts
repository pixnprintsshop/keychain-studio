import { supabase } from "./supabase";
import type { User } from "@supabase/supabase-js";

// Storage keys
const STORAGE_LICENSE_KEY = "keychain-studio-license-key";
const STORAGE_LICENSE_DATA = "keychain-studio-license-data";

// Trial duration in days
const TRIAL_DURATION_DAYS = 7;

export interface LicenseStatus {
    type: "trial" | "licensed" | "expired";
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
}

/**
 * Clear license information
 */
export function clearLicense(): void {
    localStorage.removeItem(STORAGE_LICENSE_KEY);
    localStorage.removeItem(STORAGE_LICENSE_DATA);
}

/**
 * Initialize trial for user (server-side)
 * Returns true if trial was successfully initialized
 */
export async function initializeTrial(userId: string): Promise<boolean> {
    try {
        // Check if user already has a trial
        const { data: existingTrial, error: checkError } = await supabase
            .from("user_trials")
            .select("*")
            .eq("user_id", userId)
            .eq("is_active", true)
            .maybeSingle();

        if (checkError && checkError.code !== "PGRST116") {
            console.error("Error checking trial:", checkError);
            // Don't fail completely, try to create trial anyway
        }

        if (existingTrial) {
            // User already has a trial
            return true;
        }

        // Check if user can start a trial
        const { data: canStart, error: functionError } = await supabase.rpc(
            "can_user_start_trial",
            {
                p_user_id: userId,
            }
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
export async function getTrialStartDate(
    userId: string,
): Promise<Date | null> {
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
export async function getTrialDaysRemaining(
    userId: string,
): Promise<number> {
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
            console.log(`Trial expires in ${remaining} days (expires: ${trial.trial_expires_at})`);
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

        // Fetch the linked license
        const { data: license, error: licenseError } = await supabase
            .from("licenses")
            .select("*")
            .eq("id", activation.license_id)
            .eq("is_active", true)
            .single();

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
 */
export async function checkLicenseStatus(
    user: User | null,
): Promise<LicenseStatus> {
    if (!user) {
        return {
            type: "expired",
            canExport: false,
        };
    }

    // Initialize trial if needed (this will create trial if user doesn't have one)
    const trialInitialized = await initializeTrial(user.id);

    // If trial initialization failed, log error but continue to check status
    if (!trialInitialized) {
        console.warn("Trial initialization returned false, but continuing to check status");
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
            const expiresAt = licenseData.expires_at
                ? new Date(licenseData.expires_at)
                : null;
            const isExpired = expiresAt ? expiresAt < new Date() : false;

            if (isExpired) {
                return {
                    type: "expired",
                    licenseKey,
                    expiresAt: expiresAt || undefined,
                    canExport: false,
                };
            }

            return {
                type: "licensed",
                licenseKey,
                expiresAt: expiresAt || undefined,
                maxDevices: licenseData.max_devices,
                canExport: true,
            };
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
            await new Promise(resolve => setTimeout(resolve, 100 * (attempt + 1)));
            trialDaysRemaining = await getTrialDaysRemaining(user.id);
            if (trialDaysRemaining > 0) {
                console.log(`Trial found after ${attempt + 1} retry attempts`);
                break;
            }
        }
    }

    const trialExpired = trialDaysRemaining === 0;

    if (trialExpired) {
        return {
            type: "expired",
            trialDaysRemaining: 0,
            canExport: false,
        };
    }

    return {
        type: "trial",
        trialDaysRemaining,
        canExport: true, // Trial users can use all features including export
    };
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
        // Get license by key
        const { data: license, error: licenseError } = await supabase
            .from("licenses")
            .select("*")
            .eq("license_key", licenseKey)
            .eq("is_active", true)
            .single();

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
        } else {
            // Create activation if it doesn't exist
            const deviceName = `${navigator.platform} - ${navigator.userAgent.split(" ")[0]}`;
            await supabase
                .from("device_activations")
                .insert({
                    license_id: license.id,
                    user_id: userId,
                    device_id: null,
                    device_name: deviceName,
                    activated_at: new Date().toISOString(),
                    last_validated_at: new Date().toISOString(),
                });
        }

        return true;
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
): Promise<{ success: boolean; error?: string }> {
    try {
        // Validate license key format (basic check)
        if (!licenseKey || licenseKey.trim().length === 0) {
            return { success: false, error: "License key cannot be empty" };
        }

        const deviceName = `${navigator.platform} - ${navigator.userAgent.split(" ")[0]}`;

        // Get license from Supabase
        const { data: license, error: licenseError } = await supabase
            .from("licenses")
            .select("*")
            .eq("license_key", licenseKey.trim())
            .eq("is_active", true)
            .single();

        if (licenseError || !license) {
            return {
                success: false,
                error: "Invalid or inactive license key",
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

        // Check existing user activations
        const { data: existingActivations, error: countError } = await supabase
            .from("device_activations")
            .select("id")
            .eq("license_id", license.id);

        if (countError) {
            return {
                success: false,
                error: "Error checking device limit",
            };
        }

        const currentDeviceCount = existingActivations?.length || 0;

        // Check if this user is already activated
        const { data: existingActivation } = await supabase
            .from("device_activations")
            .select("*")
            .eq("license_id", license.id)
            .eq("user_id", userId)
            .maybeSingle();

        // If device is not already activated, check device limit
        if (!existingActivation) {
            // Check device limit
            if (currentDeviceCount >= license.max_devices) {
                return {
                    success: false,
                    error: `Device limit reached (${license.max_devices} devices). Please deactivate a device first.`,
                };
            }
        }

        if (existingActivation) {
            // User already activated, just update validation time
            await supabase
                .from("device_activations")
                .update({
                    last_validated_at: new Date().toISOString(),
                    device_name: deviceName,
                })
                .eq("id", existingActivation.id);
        } else {
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
        }

        // Store license information
        storeLicense(licenseKey.trim(), license);

        return { success: true };
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
            .single();

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
