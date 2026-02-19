<script lang="ts">
    import {
        type LicenseStatus,
        activateLicense,
        checkLicenseStatus,
    } from "../lib/licensing";
    import type { User } from "@supabase/supabase-js";

    interface Props {
        user: User | null;
        onStatusChange?: () => void;
    }

    let { user, onStatusChange }: Props = $props();

    let isOpen = $state(false);
    let licenseKeyInput = $state("");
    let isActivating = $state(false);
    let errorMessage = $state("");
    let successMessage = $state("");
    let licenseStatus: LicenseStatus | null = $state(null);

    export function open() {
        isOpen = true;
        loadLicenseStatus();
    }

    export function close() {
        isOpen = false;
        licenseKeyInput = "";
        errorMessage = "";
        successMessage = "";
    }

    async function loadLicenseStatus() {
        if (!user) return;
        licenseStatus = await checkLicenseStatus(user);
    }

    async function handleActivate() {
        if (!user) {
            errorMessage = "Please sign in first";
            return;
        }

        if (!licenseKeyInput.trim()) {
            errorMessage = "Please enter a license key";
            return;
        }

        isActivating = true;
        errorMessage = "";
        successMessage = "";

        const result = await activateLicense(licenseKeyInput.trim(), user.id);

        if (result.success) {
            successMessage = "License activated successfully!";
            licenseKeyInput = "";
            await loadLicenseStatus();
            // Notify parent of status change
            if (onStatusChange) {
                onStatusChange();
            }
            // Close modal after 2 seconds
            setTimeout(() => {
                close();
            }, 2000);
        } else {
            errorMessage = result.error || "Failed to activate license";
        }

        isActivating = false;
    }

    function handleKeydown(e: KeyboardEvent) {
        if (e.key === "Escape") {
            close();
        } else if (e.key === "Enter" && !isActivating) {
            handleActivate();
        }
    }
</script>

{#if isOpen}
    <div
        class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4"
        onclick={close}
        onkeydown={handleKeydown}
        role="dialog"
        aria-modal="true"
        aria-labelledby="license-modal-title"
        tabindex="-1"
    >
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div
            class="relative w-full max-w-md rounded-2xl border border-slate-200 bg-white shadow-xl"
            onclick={(e) => e.stopPropagation()}
        >
            <div class="p-6">
                <div class="mb-4 flex items-center justify-between">
                    <h2
                        id="license-modal-title"
                        class="text-2xl font-bold text-slate-900"
                    >
                        License Activation
                    </h2>
                    <button
                        type="button"
                        class="rounded-lg p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600 transition-colors"
                        onclick={close}
                        aria-label="Close dialog"
                    >
                        <svg
                            class="h-5 w-5"
                            fill="none"
                            viewBox="0 0 24 24"
                            stroke="currentColor"
                        >
                            <path
                                stroke-linecap="round"
                                stroke-linejoin="round"
                                stroke-width="2"
                                d="M6 18L18 6M6 6l12 12"
                            />
                        </svg>
                    </button>
                </div>

                <!-- Current Status -->
                {#if licenseStatus}
                    <div class="mb-4 rounded-lg border border-slate-200 bg-slate-50 p-4">
                        <div class="text-sm font-medium text-slate-700 mb-2">
                            Current Status:
                        </div>
                        {#if licenseStatus.type === "trial"}
                            <div class="flex items-center gap-2">
                                <span
                                    class="inline-flex items-center rounded-full bg-yellow-100 px-2.5 py-0.5 text-xs font-medium text-yellow-800"
                                >
                                    Trial
                                </span>
                                <span class="text-sm text-slate-600">
                                    {licenseStatus.trialDaysRemaining} days
                                    remaining
                                </span>
                            </div>
                            <p class="mt-2 text-xs text-slate-500">
                                All features are available during trial. Activate a
                                license to continue after trial expires.
                            </p>
                        {:else if licenseStatus.type === "licensed"}
                            <div class="flex items-center gap-2">
                                <span
                                    class="inline-flex items-center rounded-full bg-green-100 px-2.5 py-0.5 text-xs font-medium text-green-800"
                                >
                                    Licensed
                                </span>
                                {#if licenseStatus.expiresAt}
                                    <span class="text-sm text-slate-600">
                                        Expires: {new Date(licenseStatus.expiresAt).toLocaleDateString()}
                                    </span>
                                {:else}
                                    <span class="text-sm text-slate-600">
                                        Lifetime license
                                    </span>
                                {/if}
                            </div>
                        {:else}
                            <div class="flex items-center gap-2">
                                <span
                                    class="inline-flex items-center rounded-full bg-red-100 px-2.5 py-0.5 text-xs font-medium text-red-800"
                                >
                                    Expired
                                </span>
                                <span class="text-sm text-slate-600">
                                    Trial or license has expired
                                </span>
                            </div>
                        {/if}
                    </div>
                {/if}

                <!-- License Key Input -->
                <div class="mb-4">
                    <label
                        for="license-key-input"
                        class="block text-sm font-medium text-slate-700 mb-2"
                    >
                        Enter License Key
                    </label>
                    <input
                        id="license-key-input"
                        type="text"
                        bind:value={licenseKeyInput}
                        placeholder="XXXX-XXXX-XXXX-XXXX"
                        class="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm outline-none ring-indigo-500/25 placeholder:text-slate-400 focus:border-indigo-400 focus:ring-2"
                        disabled={isActivating}
                    />
                </div>

                <!-- Error Message -->
                {#if errorMessage}
                    <div
                        class="mb-4 rounded-lg bg-red-50 border border-red-200 p-3"
                    >
                        <p class="text-sm text-red-800">{errorMessage}</p>
                    </div>
                {/if}

                <!-- Success Message -->
                {#if successMessage}
                    <div
                        class="mb-4 rounded-lg bg-green-50 border border-green-200 p-3"
                    >
                        <p class="text-sm text-green-800">{successMessage}</p>
                    </div>
                {/if}

                <!-- Actions -->
                <div class="flex justify-end gap-3">
                    <button
                        type="button"
                        class="rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-700 shadow-sm transition-colors hover:bg-slate-50 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2"
                        onclick={close}
                        disabled={isActivating}
                    >
                        Cancel
                    </button>
                    <button
                        type="button"
                        class="rounded-xl bg-indigo-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed"
                        onclick={handleActivate}
                        disabled={isActivating || !licenseKeyInput.trim()}
                    >
                        {#if isActivating}
                            <span class="flex items-center gap-2">
                                <svg
                                    class="animate-spin h-4 w-4"
                                    xmlns="http://www.w3.org/2000/svg"
                                    fill="none"
                                    viewBox="0 0 24 24"
                                >
                                    <circle
                                        class="opacity-25"
                                        cx="12"
                                        cy="12"
                                        r="10"
                                        stroke="currentColor"
                                        stroke-width="4"
                                    ></circle>
                                    <path
                                        class="opacity-75"
                                        fill="currentColor"
                                        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                                    ></path>
                                </svg>
                                Activating...
                            </span>
                        {:else}
                            Activate License
                        {/if}
                    </button>
                </div>
            </div>
        </div>
    </div>
{/if}
