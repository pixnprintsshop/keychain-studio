<script lang="ts">
    import { goto } from "$app/navigation";
    import type { Session, User } from "@supabase/supabase-js";
    import { onDestroy, onMount } from "svelte";
    import BasicNameDesigner from "$lib/components/BasicNameDesigner.svelte";
    import BowKeychainDesigner from "$lib/components/BowKeychainDesigner.svelte";
    import BumpyTextDesigner from "$lib/components/BumpyTextDesigner.svelte";
    import CharmDesigner from "$lib/components/CharmDesigner.svelte";
    import CustomSVGDesigner from "$lib/components/CustomSVGDesigner.svelte";
    import DogTagDesigner from "$lib/components/DogTagDesigner.svelte";
    import FlowerDesigner from "$lib/components/FlowerDesigner.svelte";
    import HomeScreen from "$lib/components/HomeScreen.svelte";
    import InitialDesigner from "$lib/components/InitialDesigner.svelte";
    import KeycapDesigner from "$lib/components/KeycapDesigner.svelte";
    import LicenseInfoPage from "$lib/components/LicenseInfoPage.svelte";
    import LicenseModal from "$lib/components/LicenseModal.svelte";
    import LoginModal from "$lib/components/LoginModal.svelte";
    import MaintenancePage from "$lib/components/MaintenancePage.svelte";
    import StanleyTopperDesigner from "$lib/components/StanleyTopperDesigner.svelte";
    import TextOutlineDesigner from "$lib/components/TextOutlineDesigner.svelte";
    import ThankYouDialog from "$lib/components/ThankYouDialog.svelte";
    import WhistleDesigner from "$lib/components/WhistleDesigner.svelte";
    import { getSession, getUser, onAuthStateChange, signOut } from "$lib/auth";
    import { type LicenseStatus, checkLicenseStatus, clearLicense } from "$lib/licensing";

    /** When true, only the maintenance page is shown. Set via VITE_MAINTENANCE_MODE (e.g. "true" or "1"). */
    const MAINTENANCE_MODE =
        import.meta.env.VITE_MAINTENANCE_MODE === "true" ||
        import.meta.env.VITE_MAINTENANCE_MODE === "1";

    // ── Storage keys ────────────────────────────────────────────────────────
    const STORAGE_KEY_WELCOME = "designer-has-seen-welcome";
    const STORAGE_KEY_VIEW = "designer-current-view";

    /** Designers that require a paid license; trial and free-license users see them as locked. */
    const PAID_ONLY_DESIGNERS = new Set<ViewName>([
        "charm",
        "customSvg",
        "keycap",
    ]);

    /** Designers under maintenance; not accessible from home and redirect to home if selected. */
    const MAINTENANCE_VIEWS = new Set<ViewName>([]);

    // ── View / routing state ────────────────────────────────────────────────
    type ViewName =
        | "home"
        | "textOutline"
        | "initial"
        | "flower"
        | "basicName"
        | "customSvg"
        | "charm"
        | "keycap"
        | "whistle"
        | "stanleyTopper"
        | "dogtag"
        | "bumpyText"
        | "bowKeychain"
        | "licenseInfo";

    const VALID_VIEW_NAMES: ViewName[] = [
        "home",
        "textOutline",
        "initial",
        "flower",
        "basicName",
        "customSvg",
        "charm",
        "keycap",
        "whistle",
        "stanleyTopper",
        "dogtag",
        "bumpyText",
        "bowKeychain",
        "licenseInfo",
    ];

    /** True when the URL hash contains Supabase OAuth callback params (tokens or error). Do not overwrite hash until Supabase has processed it. */
    function isSupabaseAuthHash(): boolean {
        if (typeof window === "undefined") return false;
        const hash = (window.location.hash || "").replace(/^#/, "");
        return (
            hash.includes("access_token=") ||
            hash.includes("refresh_token=") ||
            hash.includes("error=")
        );
    }

    function getViewFromUrl(): ViewName | null {
        if (typeof window === "undefined") return null;
        const hash = (window.location.hash || "").replace(/^#/, "").trim();
        if (hash === "terms") {
            goto("/terms");
            return "home";
        }
        if (hash === "privacy") {
            goto("/privacy");
            return "home";
        }
        if (hash === "pricing") {
            goto("/pricing");
            return "home";
        }
        if (hash === "about") {
            goto("/about");
            return "home";
        }
        if (!hash || hash === "home") return "home";
        if (VALID_VIEW_NAMES.includes(hash as ViewName)) {
            const view = hash as ViewName;
            return MAINTENANCE_VIEWS.has(view) ? "home" : view;
        }
        return null;
    }

    let initialView: ViewName = "home";
    const urlView = getViewFromUrl();
    if (urlView) {
        initialView = urlView;
    } else {
        try {
            const stored = localStorage.getItem(STORAGE_KEY_VIEW);
            if (
                stored === "textOutline" ||
                stored === "initial" ||
                stored === "flower" ||
                stored === "basicName" ||
                stored === "customSvg" ||
                stored === "charm" ||
                stored === "keycap" ||
                stored === "whistle" ||
                stored === "stanleyTopper" ||
                stored === "dogtag" ||
                stored === "bumpyText" ||
                stored === "bowKeychain" ||
            stored === "licenseInfo" ||
            stored === "home"
            ) {
                initialView = MAINTENANCE_VIEWS.has(stored as ViewName)
                    ? "home"
                    : (stored as ViewName);
            }
        } catch (_) {}
    }
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
    let showThankYouDialog = $state(false);
    let authCleanup: (() => void) | null = null;
    let hashCleanup: (() => void) | null = null;

    // ── Persist view on change ──────────────────────────────────────────────
    $effect(() => {
        try {
            localStorage.setItem(STORAGE_KEY_VIEW, currentView);
        } catch (_) {}
    });

    // Sync view to URL hash (so e.g. /#textOutline is shareable and refreshable). Do not overwrite hash when it contains Supabase OAuth callback params.
    $effect(() => {
        if (typeof window === "undefined") return;
        if (isSupabaseAuthHash()) return;
        const h = currentView === "home" ? "" : currentView;
        if (window.location.hash.replace(/^#/, "") !== h) {
            window.location.hash = h;
        }
    });

    // Redirect away from views under maintenance
    $effect(() => {
        if (MAINTENANCE_VIEWS.has(currentView)) {
            currentView = "home";
        }
    });

    // ── Handlers ────────────────────────────────────────────────────────────
    function navigateTo(view: ViewName) {
        currentView = view;
    }

    function handleStyleSelect(
        style:
            | "textOutline"
            | "initial"
            | "flower"
            | "basicName"
            | "customSvg"
            | "charm"
            | "keycap"
            | "whistle"
            | "stanleyTopper"
            | "dogtag"
            | "bumpyText"
            | "bowKeychain",
    ) {
        if (MAINTENANCE_VIEWS.has(style)) return;
        navigateTo(style);
    }

    function handleBack() {
        navigateTo("home");
    }

    function openLicenseInfo() {
        currentView = "licenseInfo";
    }

    async function handleSignOut() {
        await signOut();
        user = null;
        session = null;
        licenseStatus = null;
        clearLicense();
        showLoginModal = true;
    }

    function closeWelcomeDialog() {
        showWelcomeDialog = false;
        localStorage.setItem(STORAGE_KEY_WELCOME, "true");
    }

    // ── Lifecycle ───────────────────────────────────────────────────────────
    onMount(() => {
        // URL hash -> view (back/forward or direct link)
        function syncViewFromHash() {
            const view = getViewFromUrl();
            if (view != null) currentView = view;
        }
        window.addEventListener("hashchange", syncViewFromHash);
        hashCleanup = () => window.removeEventListener("hashchange", syncViewFromHash);

        // Welcome dialog
        const hasSeenWelcome = localStorage.getItem(STORAGE_KEY_WELCOME);
        if (!hasSeenWelcome) showWelcomeDialog = true;

        // License: check once on sign-in; no periodic polling to avoid many requests
        async function initializeLicense() {
            if (!user) return;
            licenseStatus = await checkLicenseStatus(user);
        }

        // Auth initialization
        (async () => {
            const initialSession = await getSession();
            session = initialSession;
            user = initialSession?.user ?? null;
            if (user) await initializeLicense();
            const {
                data: { subscription },
            } =             onAuthStateChange(async (event, newSession) => {
                session = newSession;
                user = newSession?.user ?? null;
                if (event === "SIGNED_IN" && user) {
                    showLoginModal = false;
                    await initializeLicense();
                    // Clean OAuth callback hash from URL after Supabase has processed it
                    if (isSupabaseAuthHash()) {
                        const h = currentView === "home" ? "" : currentView;
                        setTimeout(() => {
                            window.location.hash = h;
                        }, 0);
                    }
                } else if (event === "SIGNED_OUT") {
                    licenseStatus = null;
                    clearLicense();
                }
            });
            authCleanup = () => subscription.unsubscribe();
        })();
    });

    onDestroy(() => {
        if (authCleanup) authCleanup();
        if (hashCleanup) hashCleanup();
    });
</script>

{#if MAINTENANCE_MODE}
    <MaintenancePage />
{:else}
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
            tabindex="-1">
            <!-- svelte-ignore a11y_click_events_have_key_events -->
            <!-- svelte-ignore a11y_no_static_element_interactions -->
            <div
                class="relative w-full max-w-md rounded-2xl border border-slate-200 bg-white shadow-xl"
                onclick={(e) => e.stopPropagation()}>
                <div class="p-6">
                    <!-- Logo -->
                    <div class="mb-4 flex justify-center">
                        <img
                            src="/app-logo.png"
                            alt="PixnPrints Logo"
                            class="h-16 w-auto object-contain" />
                    </div>

                    <div class="mb-4 flex items-center justify-center">
                        <h2
                            id="welcome-title"
                            class="text-2xl font-bold text-slate-900 text-center">
                            Welcome to Keychain Studio
                        </h2>
                    </div>

                    <div class="space-y-4 text-slate-600">
                        <p class="text-sm leading-relaxed">
                            Create custom 3D text keychains with personalized
                            fonts, colors, and styles. Export your designs as
                            STL files for 3D printing.
                        </p>

                        <div class="space-y-2">
                            <div class="flex items-start gap-3">
                                <div
                                    class="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-indigo-100 text-indigo-600">
                                    <svg
                                        class="h-3 w-3"
                                        fill="currentColor"
                                        viewBox="0 0 20 20">
                                        <path
                                            fill-rule="evenodd"
                                            d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                                            clip-rule="evenodd" />
                                    </svg>
                                </div>
                                <div>
                                    <p
                                        class="text-sm font-medium text-slate-900">
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
                                    class="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-indigo-100 text-indigo-600">
                                    <svg
                                        class="h-3 w-3"
                                        fill="currentColor"
                                        viewBox="0 0 20 20">
                                        <path
                                            fill-rule="evenodd"
                                            d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                                            clip-rule="evenodd" />
                                    </svg>
                                </div>
                                <div>
                                    <p
                                        class="text-sm font-medium text-slate-900">
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
                                    class="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-indigo-100 text-indigo-600">
                                    <svg
                                        class="h-3 w-3"
                                        fill="currentColor"
                                        viewBox="0 0 20 20">
                                        <path
                                            fill-rule="evenodd"
                                            d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                                            clip-rule="evenodd" />
                                    </svg>
                                </div>
                                <div>
                                    <p
                                        class="text-sm font-medium text-slate-900">
                                        Add Keyring & Export
                                    </p>
                                    <p class="text-xs text-slate-500">
                                        Position the keyring hole and export
                                        your design as STL
                                    </p>
                                </div>
                            </div>
                        </div>
                    </div>

                    <div class="mt-6 flex items-center justify-between">
                        <div
                            class="flex items-center gap-2 text-xs text-slate-500">
                            <span>By</span>
                            <img
                                src="/pixnprints-logo.png"
                                alt="PixnPrints"
                                class="h-4 w-auto object-contain" />
                        </div>
                        <button
                            type="button"
                            class="rounded-xl bg-indigo-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2"
                            onclick={closeWelcomeDialog}>
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
        }} />

    <!-- License Modal -->
    <LicenseModal
        bind:this={licenseModalRef}
        {user}
        onStatusChange={async () => {
            if (user) {
                licenseStatus = await checkLicenseStatus(user);
            }
        }} />

    <!-- Thank You Dialog -->
    <ThankYouDialog bind:isOpen={showThankYouDialog} />

    <!-- User & License Status Bar (home and designers) -->
    <div
        class="fixed top-5 right-5 z-40 flex items-center gap-3 rounded-xl border border-slate-200 bg-white/90 px-4 py-2 shadow-sm backdrop-blur">
        {#if user}
            <div class="flex items-center gap-2">
                <div
                    class="flex h-6 w-6 items-center justify-center rounded-full bg-indigo-100 text-xs font-medium text-indigo-600">
                    {(user.email || "U")[0].toUpperCase()}
                </div>
                <span
                    class="text-xs font-medium text-slate-700 truncate max-w-[160px]">
                    {user.email}
                </span>
            </div>
            {#if licenseStatus}
                {#if licenseStatus.type === "trial"}
                    <span
                        class="inline-flex items-center rounded-full bg-yellow-100 px-2 py-0.5 text-xs font-medium text-yellow-800">
                        Trial &middot; {licenseStatus.trialDaysRemaining}d
                    </span>
                {:else if licenseStatus.type === "licensed"}
                    <span
                        class="inline-flex items-center rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium text-green-800">
                        Licensed
                    </span>
                {:else}
                    <span
                        class="inline-flex items-center rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-800">
                        Expired
                    </span>
                {/if}
            {/if}
            <button
                type="button"
                class="text-xs font-medium text-indigo-600 hover:text-indigo-700 transition-colors"
                onclick={() => licenseModalRef?.open()}>
                {licenseStatus?.type === "licensed" ? "Manage" : "License"}
            </button>
            <button
                type="button"
                class="text-xs font-medium text-slate-500 hover:text-slate-700 transition-colors"
                onclick={handleSignOut}>
                Sign Out
            </button>
        {:else}
            <button
                type="button"
                class="rounded-lg cursor-pointer bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white shadow-sm hover:bg-indigo-700 transition-colors"
                onclick={() => (showLoginModal = true)}>
                Sign In
            </button>
        {/if}
    </div>

    <!-- Router -->
    {#if currentView === "home"}
        <HomeScreen
            paidOnlyDesigners={PAID_ONLY_DESIGNERS}
            {licenseStatus}
            onSelect={handleStyleSelect}
            onOpenLicenseInfo={openLicenseInfo} />
    {:else if currentView === "textOutline"}
        <TextOutlineDesigner
            {user}
            {session}
            {licenseStatus}
            {licenseModalRef}
            onBack={handleBack}
            onRequestLogin={() => (showLoginModal = true)}
            onShowThankYou={() => (showThankYouDialog = true)} />
    {:else if currentView === "initial"}
        <InitialDesigner
            {user}
            {session}
            {licenseStatus}
            {licenseModalRef}
            onBack={handleBack}
            onRequestLogin={() => (showLoginModal = true)}
            onShowThankYou={() => (showThankYouDialog = true)} />
    {:else if currentView === "flower"}
        <FlowerDesigner
            {user}
            {session}
            {licenseStatus}
            {licenseModalRef}
            onBack={handleBack}
            onRequestLogin={() => (showLoginModal = true)}
            onShowThankYou={() => (showThankYouDialog = true)} />
    {:else if currentView === "basicName"}
        <BasicNameDesigner
            {user}
            {session}
            {licenseStatus}
            {licenseModalRef}
            onBack={handleBack}
            onRequestLogin={() => (showLoginModal = true)}
            onShowThankYou={() => (showThankYouDialog = true)} />
    {:else if currentView === "customSvg"}
        <CustomSVGDesigner
            {user}
            {session}
            {licenseStatus}
            {licenseModalRef}
            onBack={handleBack}
            onRequestLogin={() => (showLoginModal = true)}
            onShowThankYou={() => (showThankYouDialog = true)} />
    {:else if currentView === "charm"}
        <CharmDesigner
            {user}
            {session}
            {licenseStatus}
            {licenseModalRef}
            onBack={handleBack}
            onRequestLogin={() => (showLoginModal = true)}
            onShowThankYou={() => (showThankYouDialog = true)} />
    {:else if currentView === "keycap"}
        <KeycapDesigner
            {user}
            {session}
            {licenseStatus}
            {licenseModalRef}
            onBack={handleBack}
            onRequestLogin={() => (showLoginModal = true)}
            onShowThankYou={() => (showThankYouDialog = true)} />
    {:else if currentView === "whistle"}
        <WhistleDesigner
            {user}
            {session}
            {licenseStatus}
            {licenseModalRef}
            onBack={handleBack}
            onRequestLogin={() => (showLoginModal = true)}
            onShowThankYou={() => (showThankYouDialog = true)} />
    {:else if currentView === "stanleyTopper"}
        <StanleyTopperDesigner
            {user}
            {session}
            {licenseStatus}
            {licenseModalRef}
            onBack={handleBack}
            onRequestLogin={() => (showLoginModal = true)}
            onShowThankYou={() => (showThankYouDialog = true)} />
    {:else if currentView === "dogtag"}
        <DogTagDesigner
            {user}
            {session}
            {licenseStatus}
            {licenseModalRef}
            onBack={handleBack}
            onRequestLogin={() => (showLoginModal = true)}
            onShowThankYou={() => (showThankYouDialog = true)} />
    {:else if currentView === "bumpyText"}
        <BumpyTextDesigner
            {user}
            {session}
            {licenseStatus}
            {licenseModalRef}
            onBack={handleBack}
            onRequestLogin={() => (showLoginModal = true)}
            onShowThankYou={() => (showThankYouDialog = true)} />
    {:else if currentView === "bowKeychain"}
        <BowKeychainDesigner
            {user}
            {session}
            {licenseStatus}
            {licenseModalRef}
            onBack={handleBack}
            onRequestLogin={() => (showLoginModal = true)}
            onShowThankYou={() => (showThankYouDialog = true)} />
    {:else if currentView === "licenseInfo"}
        <LicenseInfoPage onBack={handleBack as never} />
    {/if}
{/if}
