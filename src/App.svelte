<script lang="ts">
    import type { Session, User } from "@supabase/supabase-js";
    import { onDestroy, onMount } from "svelte";
    import "./app.css";
    import BasicNameDesigner from "./components/BasicNameDesigner.svelte";
    import FlowerDesigner from "./components/FlowerDesigner.svelte";
    import HomeScreen from "./components/HomeScreen.svelte";
    import InitialDesigner from "./components/InitialDesigner.svelte";
    import LicenseModal from "./components/LicenseModal.svelte";
    import LoginModal from "./components/LoginModal.svelte";
    import TextOutlineDesigner from "./components/TextOutlineDesigner.svelte";
    import ThankYouDialog from "./components/ThankYouDialog.svelte";
    import {
        getSession,
        getUser,
        onAuthStateChange,
        signOut,
    } from "./lib/auth";
    import {
        type LicenseStatus,
        checkLicenseStatus,
        validateDeviceActivation,
    } from "./lib/licensing";

    // ── Storage keys ────────────────────────────────────────────────────────
    const STORAGE_KEY_WELCOME = "designer-has-seen-welcome";
    const STORAGE_KEY_VIEW = "designer-current-view";

    // ── View / routing state ────────────────────────────────────────────────
    type ViewName =
        | "home"
        | "textOutline"
        | "initial"
        | "flower"
        | "bone"
        | "basicName";
    let initialView: ViewName = "home";
    try {
        const stored = localStorage.getItem(STORAGE_KEY_VIEW);
        if (
            stored === "textOutline" ||
            stored === "initial" ||
            stored === "flower" ||
            stored === "bone" ||
            stored === "basicName" ||
            stored === "home"
        ) {
            initialView = stored;
        }
    } catch (_) {}
    let currentView = $state<ViewName>(initialView);

    // ── Welcome dialog state ────────────────────────────────────────────────
    let showWelcomeDialog = $state(false);

    // ── Authentication state ────────────────────────────────────────────────
    let user: User | null = $state(null);
    let session: Session | null = $state(null);
    let showLoginModal = $state(false);

    // ── Licensing state ─────────────────────────────────────────────────────
    let licenseStatus: LicenseStatus | null = $state(null);
    let licenseModalRef: LicenseModal | null = $state(null);
    let licenseValidationInterval: number | null = null;
    let showThankYouDialog = $state(false);
    let authCleanup: (() => void) | null = null;

    // ── Persist view on change ──────────────────────────────────────────────
    $effect(() => {
        try {
            localStorage.setItem(STORAGE_KEY_VIEW, currentView);
        } catch (_) {}
    });

    // ── Handlers ────────────────────────────────────────────────────────────
    function navigateTo(view: ViewName) {
        currentView = view;
    }

    function handleStyleSelect(
        style: "textOutline" | "initial" | "flower" | "bone" | "basicName",
    ) {
        navigateTo(style);
    }

    function handleBack() {
        navigateTo("home");
    }

    async function handleSignOut() {
        await signOut();
        user = null;
        session = null;
        licenseStatus = null;
        showLoginModal = true;
    }

    function closeWelcomeDialog() {
        showWelcomeDialog = false;
        localStorage.setItem(STORAGE_KEY_WELCOME, "true");
    }

    // ── Lifecycle ───────────────────────────────────────────────────────────
    onMount(() => {
        // Welcome dialog
        const hasSeenWelcome = localStorage.getItem(STORAGE_KEY_WELCOME);
        if (!hasSeenWelcome) showWelcomeDialog = true;

        // License initialization helper
        async function initializeLicense() {
            if (!user) return;
            licenseStatus = await checkLicenseStatus(user);
            if (licenseValidationInterval !== null)
                clearInterval(licenseValidationInterval);
            licenseValidationInterval = window.setInterval(
                async () => {
                    if (!user) return;
                    try {
                        await validateDeviceActivation(user.id);
                        licenseStatus = await checkLicenseStatus(user);
                    } catch (error) {
                        console.error("License validation error:", error);
                    }
                },
                5 * 60 * 1000,
            );
        }

        // Auth initialization
        (async () => {
            const initialSession = await getSession();
            session = initialSession;
            user = initialSession?.user ?? null;
            if (user) await initializeLicense();
            const {
                data: { subscription },
            } = onAuthStateChange(async (event, newSession) => {
                session = newSession;
                user = newSession?.user ?? null;
                if (event === "SIGNED_IN" && user) {
                    showLoginModal = false;
                    await initializeLicense();
                } else if (event === "SIGNED_OUT") {
                    licenseStatus = null;
                    if (licenseValidationInterval !== null) {
                        clearInterval(licenseValidationInterval);
                        licenseValidationInterval = null;
                    }
                }
            });
            authCleanup = () => subscription.unsubscribe();
        })();
    });

    onDestroy(() => {
        if (licenseValidationInterval !== null) {
            clearInterval(licenseValidationInterval);
            licenseValidationInterval = null;
        }
        if (authCleanup) authCleanup();
    });
</script>

<!-- Welcome Dialog -->
{#if showWelcomeDialog}
    <div
        class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4"
        onclick={closeWelcomeDialog}
        onkeydown={(e) => {
            if (e.key === "Escape") closeWelcomeDialog();
        }}
        role="dialog"
        aria-modal="true"
        aria-labelledby="welcome-title"
        tabindex="-1"
    >
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div
            class="relative w-full max-w-md rounded-2xl border border-slate-200 bg-white shadow-xl"
            onclick={(e) => e.stopPropagation()}
        >
            <div class="p-6">
                <!-- Logo -->
                <div class="mb-4 flex justify-center">
                    <img
                        src="/app-logo.png"
                        alt="PixnPrints Logo"
                        class="h-16 w-auto object-contain"
                    />
                </div>

                <div class="mb-4 flex items-center justify-center">
                    <h2
                        id="welcome-title"
                        class="text-2xl font-bold text-slate-900 text-center"
                    >
                        Welcome to Keychain Studio
                    </h2>
                </div>

                <div class="space-y-4 text-slate-600">
                    <p class="text-sm leading-relaxed">
                        Create custom 3D text keychains with personalized fonts,
                        colors, and styles. Export your designs as STL files for
                        3D printing.
                    </p>

                    <div class="space-y-2">
                        <div class="flex items-start gap-3">
                            <div
                                class="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-indigo-100 text-indigo-600"
                            >
                                <svg
                                    class="h-3 w-3"
                                    fill="currentColor"
                                    viewBox="0 0 20 20"
                                >
                                    <path
                                        fill-rule="evenodd"
                                        d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                                        clip-rule="evenodd"
                                    />
                                </svg>
                            </div>
                            <div>
                                <p class="text-sm font-medium text-slate-900">
                                    Customize Text & Fonts
                                </p>
                                <p class="text-xs text-slate-500">
                                    Enter your text and choose from various
                                    fonts
                                </p>
                            </div>
                        </div>

                        <div class="flex items-start gap-3">
                            <div
                                class="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-indigo-100 text-indigo-600"
                            >
                                <svg
                                    class="h-3 w-3"
                                    fill="currentColor"
                                    viewBox="0 0 20 20"
                                >
                                    <path
                                        fill-rule="evenodd"
                                        d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                                        clip-rule="evenodd"
                                    />
                                </svg>
                            </div>
                            <div>
                                <p class="text-sm font-medium text-slate-900">
                                    Adjust Colors & Dimensions
                                </p>
                                <p class="text-xs text-slate-500">
                                    Fine-tune text size, depth, colors, and
                                    outline thickness
                                </p>
                            </div>
                        </div>

                        <div class="flex items-start gap-3">
                            <div
                                class="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-indigo-100 text-indigo-600"
                            >
                                <svg
                                    class="h-3 w-3"
                                    fill="currentColor"
                                    viewBox="0 0 20 20"
                                >
                                    <path
                                        fill-rule="evenodd"
                                        d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                                        clip-rule="evenodd"
                                    />
                                </svg>
                            </div>
                            <div>
                                <p class="text-sm font-medium text-slate-900">
                                    Add Keyring & Export
                                </p>
                                <p class="text-xs text-slate-500">
                                    Position the keyring hole and export your
                                    design as STL
                                </p>
                            </div>
                        </div>
                    </div>
                </div>

                <div class="mt-6 flex items-center justify-between">
                    <div class="flex items-center gap-2 text-xs text-slate-500">
                        <span>By</span>
                        <img
                            src="/pixnprints-logo.png"
                            alt="PixnPrints"
                            class="h-4 w-auto object-contain"
                        />
                    </div>
                    <button
                        type="button"
                        class="rounded-xl bg-indigo-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2"
                        onclick={closeWelcomeDialog}
                    >
                        Get Started
                    </button>
                </div>
            </div>
        </div>
    </div>
{/if}

<!-- Login Modal -->
<LoginModal
    bind:isOpen={showLoginModal}
    onSuccess={async () => {
        const newUser = await getUser();
        user = newUser;
        if (newUser) {
            showLoginModal = false;
            licenseStatus = await checkLicenseStatus(newUser);
        }
    }}
/>

<!-- License Modal -->
<LicenseModal
    bind:this={licenseModalRef}
    {user}
    onStatusChange={async () => {
        if (user) {
            licenseStatus = await checkLicenseStatus(user);
        }
    }}
/>

<!-- Thank You Dialog -->
<ThankYouDialog bind:isOpen={showThankYouDialog} />

<!-- User & License Status Bar (shown when in a designer) -->
{#if currentView !== "home"}
    <div
        class="fixed top-5 right-5 z-40 flex items-center gap-3 rounded-xl border border-slate-200 bg-white/90 px-4 py-2 shadow-sm backdrop-blur"
    >
        {#if user}
            <div class="flex items-center gap-2">
                <div
                    class="flex h-6 w-6 items-center justify-center rounded-full bg-indigo-100 text-xs font-medium text-indigo-600"
                >
                    {(user.email || "U")[0].toUpperCase()}
                </div>
                <span
                    class="text-xs font-medium text-slate-700 truncate max-w-[160px]"
                >
                    {user.email}
                </span>
            </div>
            {#if licenseStatus}
                {#if licenseStatus.type === "trial"}
                    <span
                        class="inline-flex items-center rounded-full bg-yellow-100 px-2 py-0.5 text-xs font-medium text-yellow-800"
                    >
                        Trial &middot; {licenseStatus.trialDaysRemaining}d
                    </span>
                {:else if licenseStatus.type === "licensed"}
                    <span
                        class="inline-flex items-center rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium text-green-800"
                    >
                        Licensed
                    </span>
                {:else}
                    <span
                        class="inline-flex items-center rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-800"
                    >
                        Expired
                    </span>
                {/if}
            {/if}
            <button
                type="button"
                class="text-xs font-medium text-indigo-600 hover:text-indigo-700 transition-colors"
                onclick={() => licenseModalRef?.open()}
            >
                {licenseStatus?.type === "licensed" ? "Manage" : "License"}
            </button>
            <button
                type="button"
                class="text-xs font-medium text-slate-500 hover:text-slate-700 transition-colors"
                onclick={handleSignOut}
            >
                Sign Out
            </button>
        {:else}
            <button
                type="button"
                class="rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white shadow-sm hover:bg-indigo-700 transition-colors"
                onclick={() => (showLoginModal = true)}
            >
                Sign In
            </button>
        {/if}
    </div>
{/if}

<!-- Router -->
{#if currentView === "home"}
    <HomeScreen onSelect={handleStyleSelect} />
{:else if currentView === "textOutline"}
    <TextOutlineDesigner
        {user}
        {session}
        {licenseStatus}
        {licenseModalRef}
        onBack={handleBack}
        onRequestLogin={() => (showLoginModal = true)}
        onShowThankYou={() => (showThankYouDialog = true)}
    />
{:else if currentView === "initial"}
    <InitialDesigner
        {user}
        {session}
        {licenseStatus}
        {licenseModalRef}
        onBack={handleBack}
        onRequestLogin={() => (showLoginModal = true)}
        onShowThankYou={() => (showThankYouDialog = true)}
    />
{:else if currentView === "flower"}
    <FlowerDesigner
        {user}
        {session}
        {licenseStatus}
        {licenseModalRef}
        onBack={handleBack}
        onRequestLogin={() => (showLoginModal = true)}
        onShowThankYou={() => (showThankYouDialog = true)}
    />
{:else if currentView === "basicName"}
    <BasicNameDesigner
        {user}
        {session}
        {licenseStatus}
        {licenseModalRef}
        onBack={handleBack}
        onRequestLogin={() => (showLoginModal = true)}
        onShowThankYou={() => (showThankYouDialog = true)}
    />
{/if}
