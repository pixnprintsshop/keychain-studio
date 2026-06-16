<script lang="ts">
	import { goto } from '$app/navigation';
	import { navigating, page } from '$app/state';
	import { resolve } from '$app/paths';
	import { getSession, getUser, onAuthStateChange, signOut } from '$lib/auth';
	import LicenseActivationModal from '$lib/components/LicenseActivationModal.svelte';
	import LoginModal from '$lib/components/LoginModal.svelte';
	import MaintenancePage from '$lib/components/MaintenancePage.svelte';
	import PromotionDialog from '$lib/components/PromotionDialog.svelte';
	import RatingPromptModal from '$lib/components/RatingPromptModal.svelte';
	import SupportShareDialog from '$lib/components/SupportShareDialog.svelte';
	import ThankYouDialog from '$lib/components/ThankYouDialog.svelte';
	import { Button } from '$lib/components/ui/button';
	import * as Dialog from '$lib/components/ui/dialog';
	import * as Popover from '$lib/components/ui/popover/index.js';
	import DesignerLoadingScreen from '$lib/components/DesignerLoadingScreen.svelte';
	import { designerIdFromPathname, isDesignerId } from '$lib/designers/ids';
	import { setStudioContext } from '$lib/studio/context.svelte';
	import { preloadBrowserFingerprint } from '$lib/browserFingerprint';
	import {
		SHARE_PROMO_BONUS_CREDITS,
		freeTrial,
		getFingerprintBlockedMessage,
		loadFreeTrialForUser
	} from '$lib/freeTrial.svelte';
	import {
		clearLicenseCache,
		getSubscriptionStatus,
		type SubscriptionStatus
	} from '$lib/subscription';
	import {
		clearSubscriptionTrialState,
		loadSubscriptionTrialForDesigner,
		subscriptionTrial
	} from '$lib/subscriptionTrial.svelte';
	import { loadUserFeatureFlagsForUser } from '$lib/userFeatureFlags.svelte';
	import { favoriteDesigners, loadFavoriteDesigners } from '$lib/favoriteDesigners.svelte';
	import { loadExportStats } from '$lib/exportStats.svelte';
	import {
		clearPendingRatingPrompt,
		getDialogBlockingRevision,
		hasPendingRatingPrompt,
		isAnyDialogBlocking,
		isHomePath,
		setDialogBlocking,
		setPendingRatingPrompt
	} from '$lib/dialogCoordinator.svelte';
	import { notifyVisit } from '$lib/visitNotify';
	import {
		fetchUserPalette,
		getEffectivePalette,
		saveUserPalette,
		type PaletteColor
	} from '$lib/colorPalette';
	import type { Session, User } from '@supabase/supabase-js';
	import { onDestroy, onMount, type Snippet } from 'svelte';
	import * as analytics from '$lib/analytics';

	interface Props {
		children: Snippet;
	}

	let { children }: Props = $props();

	/** When true, only the maintenance page is shown. Set via VITE_MAINTENANCE_MODE (e.g. "true" or "1"). */
	const MAINTENANCE_MODE =
		import.meta.env.VITE_MAINTENANCE_MODE === 'true' ||
		import.meta.env.VITE_MAINTENANCE_MODE === '1';

	// ── Storage keys ────────────────────────────────────────────────────────
	const STORAGE_KEY_WELCOME = 'designer-has-seen-welcome';
	const STORAGE_KEY_SHARE_SHOWN = 'designer-share-dialog-shown';
	/** One-time share-for-credits promo for signed-in users without a subscription. */
	const STORAGE_KEY_SHARE_CREDITS_PROMO_DISMISSED = 'designer-has-seen-share-credits-promo-dialog';
	const SHARE_CREDITS_MESSENGER_URL = 'https://m.me/pixnprints.shop';
	/** Set when user submits a rating from the prompt — never show again. */
	const STORAGE_KEY_RATING_SUBMITTED = 'designer-rating-prompt-submitted';
	/** Local calendar day (YYYY-MM-DD) when user dismissed without submitting — show again next day. */
	const STORAGE_KEY_RATING_DISMISSED_DAY = 'designer-rating-prompt-dismissed-day';
	const LEGACY_STORAGE_KEY_RATING_PROMPT = 'designer-has-seen-rating-prompt';

	function getLocalDateString(d = new Date()): string {
		const y = d.getFullYear();
		const m = String(d.getMonth() + 1).padStart(2, '0');
		const day = String(d.getDate()).padStart(2, '0');
		return `${y}-${m}-${day}`;
	}

	function migrateRatingPromptStorage() {
		try {
			const legacy = localStorage.getItem(LEGACY_STORAGE_KEY_RATING_PROMPT);
			if (legacy === 'true' && !localStorage.getItem(STORAGE_KEY_RATING_SUBMITTED)) {
				localStorage.setItem(STORAGE_KEY_RATING_DISMISSED_DAY, getLocalDateString());
				localStorage.removeItem(LEGACY_STORAGE_KEY_RATING_PROMPT);
			}
		} catch {
			// localStorage can be unavailable in restricted browser contexts.
		}
	}

	function isRatingPromptEligible(): boolean {
		try {
			migrateRatingPromptStorage();
			if (localStorage.getItem(STORAGE_KEY_RATING_SUBMITTED) === 'true') return false;
			const dismissedDay = localStorage.getItem(STORAGE_KEY_RATING_DISMISSED_DAY);
			if (dismissedDay === getLocalDateString()) return false;
			return true;
		} catch {
			return false;
		}
	}

	/** Signed-in users on the free-trial path only — not subscribers or license holders. */
	function isFreeTrialOnlyUser(): boolean {
		if (!user?.id || !freeTrial.loaded) return false;
		if (subscriptionStatus === null) return false;
		return !subscriptionStatus.isActive;
	}

	let sessionBootstrapComplete = $state(false);
	let subscriptionBootstrapComplete = $state(true);
	let isMobile = $state(false);

	// ── Welcome dialog state ────────────────────────────────────────────────
	let showWelcomeDialog = $state(false);

	// ── Authentication state ────────────────────────────────────────────────
	let user: User | null = $state(null);
	let session: Session | null = $state(null);
	let subscriptionStatus: SubscriptionStatus | null = $state(null);
	let showLoginModal = $state(false);
	let showLicenseModal = $state(false);
	let showLogoutConfirm = $state(false);

	// ── Dialog state ────────────────────────────────────────────────────────
	let showThankYouDialog = $state(false);
	let showSupportShareDialog = $state(false);
	let showPromotionDialog = $state(false);
	let canShowShareCreditsPromo = $state(false);
	let showRatingPromptDialog = $state(false);
	/** Bumped when the local calendar day changes (visibility) so the daily rating prompt can re-evaluate. */
	let ratingPromptDayKey = $state(0);
	let menuOpen = $state(false);
	let userPalette: PaletteColor[] | null = $state(null);
	let authCleanup: (() => void) | null = null;
	let visibilityCleanup: (() => void) | null = null;
	let visitNotifyTimer: number | null = null;

	const authBootstrapComplete = $derived.by(() => {
		if (!sessionBootstrapComplete) return false;
		if (!favoriteDesigners.loaded) return false;
		const uid = user?.id;
		if (!uid) return true;
		return subscriptionBootstrapComplete && freeTrial.loaded;
	});

	const effectivePalette = $derived(getEffectivePalette(user, userPalette));

	const designerNavLoading = $derived(
		navigating.to != null && designerIdFromPathname(navigating.to.url.pathname) != null
	);

	// ── Handlers ────────────────────────────────────────────────────────────
	async function handleSavePalette(colors: PaletteColor[]) {
		if (!user?.id) return { success: false, error: 'Not signed in' };
		const result = await saveUserPalette(user.id, colors);
		if (result.success) {
			userPalette = colors;
		}
		return result;
	}

	function showPricing() {
		goto(resolve('/pricing'));
	}

	async function refreshAccessStatus() {
		if (!user?.id) {
			subscriptionStatus = null;
			return;
		}
		subscriptionStatus = await getSubscriptionStatus(user.id);
	}

	function openFeedback() {
		goto(resolve('/feedback'));
	}

	function openSettings() {
		goto(resolve('/settings'));
	}

	setStudioContext({
		get user() {
			return user;
		},
		get session() {
			return session;
		},
		get subscriptionStatus() {
			return subscriptionStatus;
		},
		get palette() {
			return effectivePalette;
		},
		get isMobile() {
			return isMobile;
		},
		get subscriptionBootstrapComplete() {
			return subscriptionBootstrapComplete;
		},
		get authBootstrapComplete() {
			return authBootstrapComplete;
		},
		requestLogin: () => {
			showLoginModal = true;
		},
		showPricing,
		showThankYou: () => {
			showThankYouDialog = true;
		},
		goHome: () => goto(resolve('/')),
		savePalette: handleSavePalette
	});

	// Fetch subscription status when user changes
	let subscriptionFetchUserId: string | null = null;
	$effect(() => {
		const u = user;
		if (!u?.id) {
			subscriptionStatus = null;
			subscriptionBootstrapComplete = true;
			subscriptionFetchUserId = null;
			return;
		}
		if (u.id === subscriptionFetchUserId) return;
		subscriptionFetchUserId = u.id;
		subscriptionBootstrapComplete = false;
		getSubscriptionStatus(u.id).then((s) => {
			if (subscriptionFetchUserId !== u.id) return;
			subscriptionStatus = s;
			subscriptionBootstrapComplete = true;
		});
	});

	// Sync free-trial state with the current account (id only — ignore token refresh object churn).
	$effect(() => {
		const uid = user?.id ?? null;
		void loadFreeTrialForUser(uid);
		if (!uid) clearSubscriptionTrialState();
	});

	// Per-user feature flags (admin-granted).
	$effect(() => {
		void loadUserFeatureFlagsForUser(user?.id ?? null);
	});

	// Per-designer LS subscription trial credits when on a designer route.
	$effect(() => {
		if (!subscriptionStatus?.onTrial) {
			clearSubscriptionTrialState();
			return;
		}
		const designerId = designerIdFromPathname(page.url.pathname);
		if (designerId) void loadSubscriptionTrialForDesigner(designerId);
	});

	// Favorite designers (home grid sort order).
	$effect(() => {
		const uid = user?.id ?? null;
		void loadFavoriteDesigners(uid);
	});

	// Platform + per-user export counters for home / stats UI.
	$effect(() => {
		const u = user;
		void loadExportStats(u?.id ?? null);
	});

	// Fetch user palette when user changes
	$effect(() => {
		const u = user;
		if (!u?.id) {
			userPalette = null;
			return;
		}
		fetchUserPalette(u.id).then((p) => {
			userPalette = p;
		});
	});

	async function handleSignOut() {
		const userId = user?.id ?? null;
		analytics.capture('user_signed_out');
		analytics.reset();
		await signOut();
		clearLicenseCache(userId);
		user = null;
		session = null;
		showLoginModal = true;
	}

	function closeWelcomeDialog() {
		showWelcomeDialog = false;
		localStorage.setItem(STORAGE_KEY_WELCOME, 'true');
	}

	function closePromotionDialog() {
		showPromotionDialog = false;
		try {
			localStorage.setItem(STORAGE_KEY_SHARE_CREDITS_PROMO_DISMISSED, 'true');
		} catch {
			// localStorage can be unavailable in restricted browser contexts.
		}
		analytics.capture('share_credits_promo_dismissed', {
			remaining_credits: freeTrial.credits
		});
	}

	async function handleShareCreditsPromoShare() {
		if (typeof window === 'undefined') return;
		const url = window.location.origin;
		const shareData = {
			title: 'PixnPrints – 3D print designer',
			text: 'I design and download 3D prints with PixnPrints — great for makers and small shops.',
			url
		};
		try {
			const nav = window.navigator as Navigator & {
				share?: (data: ShareData) => Promise<void>;
			};
			if (nav.share) {
				await nav.share(shareData);
			} else if (navigator.clipboard?.writeText) {
				await navigator.clipboard.writeText(`${shareData.text} ${url}`);
			}
			analytics.capture('share_credits_promo_shared');
		} catch {
			// user cancelled share sheet
		}
	}

	function handleShareCreditsPromoMessage() {
		analytics.capture('share_credits_promo_message_clicked');
		window.open(SHARE_CREDITS_MESSENGER_URL, '_blank', 'noopener,noreferrer');
		closePromotionDialog();
	}

	function closeRatingPrompt() {
		try {
			localStorage.setItem(STORAGE_KEY_RATING_DISMISSED_DAY, getLocalDateString());
		} catch {
			// localStorage can be unavailable in restricted browser contexts.
		}
		showRatingPromptDialog = false;
		analytics.capture('rating_prompt_dismissed');
	}

	function handleRatingSubmitted() {
		try {
			localStorage.setItem(STORAGE_KEY_RATING_SUBMITTED, 'true');
			localStorage.removeItem(STORAGE_KEY_RATING_DISMISSED_DAY);
		} catch {
			// localStorage can be unavailable in restricted browser contexts.
		}
		showRatingPromptDialog = false;
	}

	// Daily rating prompt until user submits (subscribed / licensed; after welcome)
	let ratingPromptFired = $state(false);
	$effect(() => {
		setDialogBlocking('welcome', showWelcomeDialog);
	});
	$effect(() => {
		setDialogBlocking('promotion', showPromotionDialog);
	});
	$effect(() => {
		setDialogBlocking('rating', showRatingPromptDialog);
	});
	$effect(() => {
		setDialogBlocking('login', showLoginModal);
	});
	$effect(() => {
		setDialogBlocking('license', showLicenseModal);
	});
	$effect(() => {
		setDialogBlocking('logout', showLogoutConfirm);
	});
	$effect(() => {
		setDialogBlocking('thankYou', showThankYouDialog);
	});
	$effect(() => {
		setDialogBlocking('supportShare', showSupportShareDialog);
	});

	// Share-for-credits promo: free-trial users only (after subscription/license check resolves).
	$effect(() => {
		getDialogBlockingRevision();
		if (!canShowShareCreditsPromo) return;
		if (!isFreeTrialOnlyUser()) return;
		if (showWelcomeDialog || showPromotionDialog) return;
		if (isAnyDialogBlocking()) return;
		showPromotionDialog = true;
		canShowShareCreditsPromo = false;
		analytics.capture('share_credits_promo_shown', {
			remaining_credits: freeTrial.credits,
			total_credits: freeTrial.totalCredits
		});
	});

	$effect(() => {
		if (typeof window === 'undefined') return;
		void ratingPromptDayKey;
		getDialogBlockingRevision();
		const pathname = page.url.pathname;
		const onHome = isHomePath(pathname);
		const pending = hasPendingRatingPrompt();

		if (!isRatingPromptEligible()) {
			ratingPromptFired = false;
			return;
		}
		if (!user?.id) return;
		if (!subscriptionStatus?.isActive || subscriptionStatus.licenseExpired) return;
		if (showWelcomeDialog || showRatingPromptDialog) return;

		if (pending && onHome) ratingPromptFired = false;
		if (pending && !onHome) return;
		if (!pending && !onHome) return;
		if (ratingPromptFired && !pending) return;

		if (isAnyDialogBlocking()) {
			setPendingRatingPrompt();
			return;
		}

		const delayMs = pending ? 800 : 5000;
		const id = window.setTimeout(() => {
			if (!isRatingPromptEligible() || !user?.id) return;
			if (!subscriptionStatus?.isActive || subscriptionStatus.licenseExpired) return;
			if (showWelcomeDialog || showRatingPromptDialog) return;
			if (isAnyDialogBlocking()) {
				setPendingRatingPrompt();
				return;
			}
			clearPendingRatingPrompt();
			ratingPromptFired = true;
			showRatingPromptDialog = true;
			analytics.capture('rating_prompt_shown');
		}, delayMs);
		return () => window.clearTimeout(id);
	});

	function isSupabaseAuthHash(): boolean {
		if (typeof window === 'undefined') return false;
		const hash = (window.location.hash || '').replace(/^#/, '');
		return (
			hash.includes('access_token=') || hash.includes('refresh_token=') || hash.includes('error=')
		);
	}

	function redirectLegacyHashRoute() {
		if (typeof window === 'undefined' || isSupabaseAuthHash()) return;
		const hash = (window.location.hash || '').replace(/^#/, '').trim();
		if (!hash || hash === 'home') return;
		if (hash === 'feedback') {
			goto(resolve('/feedback'), { replaceState: true });
			window.history.replaceState({}, '', window.location.pathname);
			return;
		}
		if (hash === 'settings') {
			goto(resolve('/settings'), { replaceState: true });
			window.history.replaceState({}, '', window.location.pathname);
			return;
		}
		if (hash === 'contact') {
			goto(resolve('/contact'), { replaceState: true });
			window.history.replaceState({}, '', window.location.pathname);
			return;
		}
		if (isDesignerId(hash)) {
			goto(`/${hash}` as `/${typeof hash}`, { replaceState: true });
			window.history.replaceState({}, '', window.location.pathname);
		}
	}

	// ── Lifecycle ───────────────────────────────────────────────────────────
	onMount(() => {
		preloadBrowserFingerprint();
		redirectLegacyHashRoute();

		// Mobile detection: show DesktopRequiredView when opening a designer on small screens
		const mq = window.matchMedia('(max-width: 768px)');
		isMobile = mq.matches;
		mq.addEventListener('change', (e) => {
			isMobile = e.matches;
		});

		// Refresh license status when tab becomes visible (ensures expired licenses are caught)
		let lastKnownDayForRatingPrompt = getLocalDateString();
		const onVisibilityChange = () => {
			if (document.visibilityState === 'visible') {
				const today = getLocalDateString();
				if (today !== lastKnownDayForRatingPrompt) {
					lastKnownDayForRatingPrompt = today;
					ratingPromptDayKey++;
				}
				if (user?.id) {
					getSubscriptionStatus(user.id).then((s) => {
						subscriptionStatus = s;
					});
				}
			}
		};
		document.addEventListener('visibilitychange', onVisibilityChange);
		visibilityCleanup = () => document.removeEventListener('visibilitychange', onVisibilityChange);

		// Welcome dialog
		const hasSeenWelcome = localStorage.getItem(STORAGE_KEY_WELCOME);
		if (!hasSeenWelcome) showWelcomeDialog = true;

		// Share-for-credits promo: once per signed-in free user (new storage key vs old subscription promo).
		canShowShareCreditsPromo = !localStorage.getItem(STORAGE_KEY_SHARE_CREDITS_PROMO_DISMISSED);

		// Open login modal if redirected from pricing with ?login=1
		if (
			typeof window !== 'undefined' &&
			new URL(window.location.href).searchParams.get('login') === '1'
		) {
			showLoginModal = true;
			// Clear the param from URL without full reload
			const url = new URL(window.location.href);
			url.searchParams.delete('login');
			window.history.replaceState({}, '', url.pathname + url.hash || '/');
		}

		// One-shot visit notification (Telegram). Fired ~1.5s after mount so auth +
		// subscription state has time to settle, giving the operator user info when
		// available. The helper itself dedupes via sessionStorage.
		visitNotifyTimer = window.setTimeout(() => {
			notifyVisit({
				email: user?.email,
				userId: user?.id,
				subscriptionStatus,
				view: page.url.pathname
			});
		}, 1500);

		// Auth initialization
		(async () => {
			const initialSession = await getSession();
			session = initialSession;
			user = initialSession?.user ?? null;
			sessionBootstrapComplete = true;
			if (!user) {
				// Guest users see the support dialog once ever (not while welcome is open)
				const hasSeenSupport = localStorage.getItem(STORAGE_KEY_SHARE_SHOWN);
				if (!showWelcomeDialog && !hasSeenSupport) showSupportShareDialog = true;
			}
			const {
				data: { subscription }
			} = onAuthStateChange(async (event, newSession) => {
				session = newSession;
				user = newSession?.user ?? null;
				if (event === 'SIGNED_IN' && user) {
					analytics.identify(user.id, { email: user.email });
					showLoginModal = false;
					if (isSupabaseAuthHash()) {
						setTimeout(() => {
							window.history.replaceState({}, '', window.location.pathname + window.location.search);
						}, 0);
					}
				}
			});
			authCleanup = () => subscription.unsubscribe();
		})();
	});

	onDestroy(() => {
		if (authCleanup) authCleanup();
		if (visibilityCleanup) visibilityCleanup();
		if (visitNotifyTimer != null) window.clearTimeout(visitNotifyTimer);
	});
</script>

{#if MAINTENANCE_MODE}
	<MaintenancePage />
{:else if !authBootstrapComplete}
	<DesignerLoadingScreen message="Loading Print Studio…" />
{:else}
	<!-- Welcome Dialog -->
	{#if showWelcomeDialog}
		<div
			class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm"
			onclick={closeWelcomeDialog}
			onkeydown={(e) => {
				if (e.key === 'Escape') closeWelcomeDialog();
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
						<img src="/app-logo.png" alt="PixnPrints Logo" class="h-16 w-auto object-contain" />
					</div>

					<div class="mb-4 flex items-center justify-center">
						<h2 id="welcome-title" class="text-center text-2xl font-bold text-slate-900">
							Welcome to Print Studio
						</h2>
					</div>

					<div class="space-y-4 text-slate-600">
						<p class="text-sm leading-relaxed">
							Create custom 3D text keychains with personalized fonts, colors, and styles. Export
							your designs as STL files for 3D printing.
						</p>

						<div class="space-y-2">
							<div class="flex items-start gap-3">
								<div
									class="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-indigo-100 text-indigo-600"
								>
									<svg class="h-3 w-3" fill="currentColor" viewBox="0 0 20 20">
										<path
											fill-rule="evenodd"
											d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
											clip-rule="evenodd"
										/>
									</svg>
								</div>
								<div>
									<p class="text-sm font-medium text-slate-900">Customize Text & Fonts</p>
									<p class="text-xs text-slate-500">
										Enter your text and choose from various fonts
									</p>
								</div>
							</div>

							<div class="flex items-start gap-3">
								<div
									class="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-indigo-100 text-indigo-600"
								>
									<svg class="h-3 w-3" fill="currentColor" viewBox="0 0 20 20">
										<path
											fill-rule="evenodd"
											d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
											clip-rule="evenodd"
										/>
									</svg>
								</div>
								<div>
									<p class="text-sm font-medium text-slate-900">Adjust Colors & Dimensions</p>
									<p class="text-xs text-slate-500">
										Fine-tune text size, depth, colors, and outline thickness
									</p>
								</div>
							</div>

							<div class="flex items-start gap-3">
								<div
									class="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-indigo-100 text-indigo-600"
								>
									<svg class="h-3 w-3" fill="currentColor" viewBox="0 0 20 20">
										<path
											fill-rule="evenodd"
											d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
											clip-rule="evenodd"
										/>
									</svg>
								</div>
								<div>
									<p class="text-sm font-medium text-slate-900">Add Keyring & Export</p>
									<p class="text-xs text-slate-500">
										Position the keyring hole and export your design as STL
									</p>
								</div>
							</div>
						</div>
					</div>

					<div class="mt-6 flex items-center justify-between">
						<div class="flex items-center gap-2 text-xs text-slate-500">
							<span>By</span>
							<img src="/pixnprints-logo.png" alt="PixnPrints" class="h-4 w-auto object-contain" />
						</div>
						<Button onclick={closeWelcomeDialog}>Get Started</Button>
					</div>
				</div>
			</div>
		</div>
	{/if}

	<PromotionDialog
		open={showPromotionDialog}
		remainingCredits={freeTrial.credits}
		totalCredits={freeTrial.totalCredits}
		bonusCredits={SHARE_PROMO_BONUS_CREDITS}
		onClose={closePromotionDialog}
		onShare={handleShareCreditsPromoShare}
		onMessageUs={handleShareCreditsPromoMessage}
	/>

	<RatingPromptModal
		open={showRatingPromptDialog}
		{user}
		onDismiss={closeRatingPrompt}
		onSubmitted={handleRatingSubmitted}
	/>

	<!-- Login Modal -->
	<LoginModal
		bind:isOpen={showLoginModal}
		onSuccess={async () => {
			const newUser = await getUser();
			user = newUser;
			if (newUser) {
				showLoginModal = false;
			}
		}}
	/>

	<!-- License Activation Modal -->
	<LicenseActivationModal bind:isOpen={showLicenseModal} onSuccess={refreshAccessStatus} />

	<!-- Thank You Dialog -->
	<ThankYouDialog bind:isOpen={showThankYouDialog} />

	<!-- Support / Share Dialog -->
	<SupportShareDialog
		bind:isOpen={showSupportShareDialog}
		onClose={() => localStorage.setItem(STORAGE_KEY_SHARE_SHOWN, 'true')}
	/>

	<!-- Logout confirmation -->
	<Dialog.Root
		bind:open={showLogoutConfirm}
		onOpenChange={(open) => {
			showLogoutConfirm = open;
		}}
	>
		<Dialog.Content showCloseButton={false} class="max-w-sm rounded-2xl border-slate-200 shadow-xl">
			<Dialog.Header>
				<Dialog.Title class="text-lg font-semibold text-slate-900">Sign out</Dialog.Title>
				<Dialog.Description class="mt-1 text-sm text-slate-600">
					Are you sure you want to sign out?
				</Dialog.Description>
			</Dialog.Header>
			<div class="mt-6 flex justify-end gap-3">
				<Dialog.Close
					class="rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-700 shadow-sm transition hover:bg-slate-50 focus:ring-2 focus:ring-indigo-500/50 focus:outline-none"
				>
					Cancel
				</Dialog.Close>
				<Button
					onclick={async () => {
						showLogoutConfirm = false;
						await handleSignOut();
					}}
				>
					Sign out
				</Button>
			</div>
		</Dialog.Content>
	</Dialog.Root>

	<!-- Desktop: status bar (original) -->
	<div
		class="fixed top-5 right-5 z-40 hidden flex-wrap items-center gap-3 rounded-xl border border-slate-200 bg-white/90 px-4 py-2 shadow-sm backdrop-blur sm:flex"
	>
		{#if user}
			<div class="flex items-center gap-2">
				<div
					class="flex h-6 w-6 items-center justify-center rounded-full bg-indigo-100 text-xs font-medium text-indigo-600"
				>
					{(user.email || 'U')[0].toUpperCase()}
				</div>
				<span class="max-w-[160px] truncate text-xs font-medium text-slate-700">
					{user.email}
				</span>
			</div>
			{#if subscriptionStatus}
				{#if subscriptionStatus?.isActive}
					{#if subscriptionStatus.onTrial}
						<a
							href={resolve('/subscription')}
							class="ml-2 inline-flex items-center gap-1.5 rounded-full border border-violet-200 bg-violet-50 px-3 py-1 text-[11px] font-medium text-violet-800 transition hover:bg-violet-100 focus:ring-2 focus:ring-violet-500/50 focus:outline-none"
							title={`Subscription trial: ${subscriptionTrial.remaining} of ${subscriptionTrial.maxPerDesign} downloads left for this design`}
						>
							Trial — {subscriptionTrial.remaining}/{subscriptionTrial.maxPerDesign} left
						</a>
					{:else}
						<a
							href={resolve('/subscription')}
							class="ml-2 inline-flex rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1 text-[11px] font-medium text-emerald-800 transition hover:bg-emerald-100 focus:ring-2 focus:ring-emerald-500/50 focus:outline-none"
						>
							{subscriptionStatus?.source === 'license' ? 'Licensed' : 'Subscribed'}
						</a>
					{/if}
				{:else if subscriptionStatus?.licenseExpired}
					<span
						class="ml-2 inline-flex rounded-full border border-amber-200 bg-amber-50 px-3 py-1 text-[11px] font-medium text-amber-800"
					>
						License expired
					</span>
				{:else if !subscriptionStatus?.isActive}
					{#if freeTrial.fingerprintBlocked}
						<span
							class="ml-2 inline-flex max-w-xs rounded-full border border-amber-200 bg-amber-50 px-3 py-1 text-[11px] font-medium text-amber-900"
							title={getFingerprintBlockedMessage()}
						>
							Device trial limit reached
						</span>
					{:else if freeTrial.credits > 0}
						<span
							class="ml-2 inline-flex items-center gap-1.5 rounded-full border border-blue-200 bg-blue-50 px-3 py-1 text-[11px] font-medium text-blue-800"
							title={`Free trial: ${freeTrial.credits} of ${freeTrial.totalCredits} downloads remaining. Subscribe for unlimited exports.`}
						>
							<svg class="h-3 w-3" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
								<path
									fill-rule="evenodd"
									d="M10 2a8 8 0 100 16 8 8 0 000-16zm0 3a1 1 0 011 1v3.586l2.707 2.707a1 1 0 01-1.414 1.414l-3-3A1 1 0 019 10V6a1 1 0 011-1z"
									clip-rule="evenodd"
								/>
							</svg>
							Free trial — {freeTrial.credits}/{freeTrial.totalCredits} left
						</span>
					{/if}
					<Button
						variant="secondary"
						size="xs"
						class="ml-2 rounded-full"
						onclick={() => (showLicenseModal = true)}
					>
						Activate license
					</Button>
				{/if}
			{/if}
			<Button variant="secondary" size="xs" class="rounded-full" onclick={openSettings}>
				Settings
			</Button>
			<Button variant="secondary" size="xs" class="rounded-full" onclick={openFeedback}>
				Feedback
			</Button>
			<Button
				variant="secondary"
				size="xs"
				class="rounded-full"
				onclick={() => (showSupportShareDialog = true)}
			>
				Support Print Studio
			</Button>
			<Button
				variant="outline"
				size="xs"
				class="rounded-full text-slate-700"
				onclick={() => (showLogoutConfirm = true)}
			>
				Sign Out
			</Button>
		{:else}
			<button
				type="button"
				onclick={() => (showLoginModal = true)}
				class="inline-flex items-center gap-1.5 rounded-full border border-blue-200 bg-blue-50 px-3 py-1 text-[11px] font-medium text-blue-800 transition hover:bg-blue-100 focus:ring-2 focus:ring-blue-500/50 focus:outline-none"
				title={`Sign in to claim ${freeTrial.totalCredits} free downloads.`}
			>
				<svg class="h-3 w-3" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
					<path
						fill-rule="evenodd"
						d="M10 2a8 8 0 100 16 8 8 0 000-16zm0 3a1 1 0 011 1v3.586l2.707 2.707a1 1 0 01-1.414 1.414l-3-3A1 1 0 019 10V6a1 1 0 011-1z"
						clip-rule="evenodd"
					/>
				</svg>
				Sign in for {freeTrial.totalCredits} free downloads
			</button>
			<Button size="xs" href="/pricing">View pricing</Button>
			<Button
				variant="secondary"
				size="xs"
				class="rounded-full"
				onclick={() => (showLoginModal = true)}
			>
				Sign In
			</Button>
			<Button variant="secondary" size="xs" class="rounded-full" onclick={openSettings}>
				Settings
			</Button>
			<Button
				variant="secondary"
				size="xs"
				class="rounded-full"
				onclick={() => (showSupportShareDialog = true)}
			>
				Support Print Studio
			</Button>
		{/if}
	</div>

	<!-- Mobile: burger menu + popover -->
	<div class="fixed top-5 right-5 z-40 sm:hidden">
		<Popover.Root bind:open={menuOpen}>
			<Popover.Trigger
				class="flex size-10 items-center justify-center rounded-xl border border-slate-200 bg-white/90 shadow-sm backdrop-blur transition hover:bg-slate-50 focus:ring-2 focus:ring-indigo-500/50 focus:outline-none"
				aria-label="Open menu"
			>
				<svg
					xmlns="http://www.w3.org/2000/svg"
					class="size-5 text-slate-600"
					fill="none"
					viewBox="0 0 24 24"
					stroke-width="2"
					stroke="currentColor"
					stroke-linecap="round"
					stroke-linejoin="round"
					aria-hidden="true"
				>
					<path d="M4 6h16M4 12h16M4 18h16" />
				</svg>
			</Popover.Trigger>
			<Popover.Content class="w-72 p-3" align="end" side="bottom" sideOffset={8}>
				<div class="flex flex-col gap-2">
					{#if user}
						<div class="flex items-center gap-2 border-b border-slate-200 pb-2">
							<div
								class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-indigo-100 text-sm font-medium text-indigo-600"
							>
								{(user.email || 'U')[0].toUpperCase()}
							</div>
							<div class="min-w-0 flex-1">
								<span class="block truncate text-sm font-medium text-slate-700">
									{user.email}
								</span>
								{#if subscriptionStatus}
									{#if subscriptionStatus?.isActive}
										{#if subscriptionStatus.onTrial}
											<a
												href={resolve('/subscription')}
												class="text-[11px] font-medium text-violet-700 hover:underline"
												onclick={() => (menuOpen = false)}
											>
												Trial — {subscriptionTrial.remaining}/{subscriptionTrial.maxPerDesign} left
											</a>
										{:else}
											<a
												href={resolve('/subscription')}
												class="text-[11px] font-medium text-emerald-700 hover:underline"
												onclick={() => (menuOpen = false)}
											>
												{subscriptionStatus?.source === 'license' ? 'Licensed' : 'Subscribed'}
											</a>
										{/if}
									{:else if subscriptionStatus?.licenseExpired}
										<span class="text-[11px] font-medium text-amber-700">License expired</span>
									{:else if !subscriptionStatus?.isActive}
										<Button
											variant="link"
											size="sm"
											class="mt-0.5 h-auto p-0 text-xs font-medium text-indigo-600"
											onclick={() => {
												menuOpen = false;
												showLicenseModal = true;
											}}
										>
											Activate license
										</Button>
									{/if}
								{/if}
							</div>
						</div>
						{#if subscriptionStatus?.onTrial}
							<div
								class="flex items-center justify-center gap-1.5 rounded-lg border border-violet-200 bg-violet-50 px-3 py-1.5 text-xs font-medium text-violet-800"
							>
								Trial — {subscriptionTrial.remaining}/{subscriptionTrial.maxPerDesign} left (this design)
							</div>
						{:else if !subscriptionStatus?.isActive && freeTrial.fingerprintBlocked}
							<div
								class="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-center text-xs font-medium text-amber-900"
								title={getFingerprintBlockedMessage()}
							>
								Device trial limit reached (2 accounts per device)
							</div>
						{:else if !subscriptionStatus?.isActive && freeTrial.credits > 0}
							<div
								class="flex items-center justify-center gap-1.5 rounded-lg border border-blue-200 bg-blue-50 px-3 py-1.5 text-xs font-medium text-blue-800"
							>
								<svg class="h-3 w-3" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
									<path
										fill-rule="evenodd"
										d="M10 2a8 8 0 100 16 8 8 0 000-16zm0 3a1 1 0 011 1v3.586l2.707 2.707a1 1 0 01-1.414 1.414l-3-3A1 1 0 019 10V6a1 1 0 011-1z"
										clip-rule="evenodd"
									/>
								</svg>
								Free trial — {freeTrial.credits}/{freeTrial.totalCredits} left
							</div>
						{/if}
						<Button
							variant="secondary"
							size="sm"
							class="w-full justify-start"
							onclick={() => {
								menuOpen = false;
								openSettings();
							}}
						>
							Settings
						</Button>
						<Button
							variant="secondary"
							size="sm"
							class="w-full justify-start"
							onclick={() => {
								menuOpen = false;
								openFeedback();
							}}
						>
							Feedback
						</Button>
						<Button
							variant="secondary"
							size="sm"
							class="w-full justify-start"
							onclick={() => {
								menuOpen = false;
								showSupportShareDialog = true;
							}}
						>
							Support Print Studio
						</Button>
						<Button
							variant="outline"
							size="sm"
							class="w-full justify-start text-slate-700"
							onclick={() => {
								menuOpen = false;
								showLogoutConfirm = true;
							}}
						>
							Sign Out
						</Button>
					{:else}
						<button
							type="button"
							onclick={() => {
								menuOpen = false;
								showLoginModal = true;
							}}
							class="flex items-center justify-center gap-1.5 rounded-lg border border-blue-200 bg-blue-50 px-3 py-1.5 text-xs font-medium text-blue-800 transition hover:bg-blue-100 focus:ring-2 focus:ring-blue-500/50 focus:outline-none"
						>
							<svg class="h-3 w-3" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
								<path
									fill-rule="evenodd"
									d="M10 2a8 8 0 100 16 8 8 0 000-16zm0 3a1 1 0 011 1v3.586l2.707 2.707a1 1 0 01-1.414 1.414l-3-3A1 1 0 019 10V6a1 1 0 011-1z"
									clip-rule="evenodd"
								/>
							</svg>
							Sign in for {freeTrial.totalCredits} free downloads
						</button>
						<Button size="sm" class="w-full" href="/pricing" onclick={() => (menuOpen = false)}>
							View pricing
						</Button>
						<Button
							variant="secondary"
							size="sm"
							class="w-full justify-start"
							onclick={() => {
								menuOpen = false;
								showLoginModal = true;
							}}
						>
							Sign In
						</Button>
						<Button
							variant="secondary"
							size="sm"
							class="w-full justify-start"
							onclick={() => {
								menuOpen = false;
								openSettings();
							}}
						>
							Settings
						</Button>
						<Button
							variant="secondary"
							size="sm"
							class="w-full justify-start"
							onclick={() => {
								menuOpen = false;
								showSupportShareDialog = true;
							}}
						>
							Support Print Studio
						</Button>
					{/if}
				</div>
			</Popover.Content>
		</Popover.Root>
	</div>

	<!-- Main content -->
	<div class="relative">
		{#if designerNavLoading}
			<div class="fixed inset-0 z-50">
				<DesignerLoadingScreen />
			</div>
		{/if}
		{@render children()}
	</div>
{/if}
