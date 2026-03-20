<script lang="ts">
	import { goto } from '$app/navigation';
	import { getSession, getUser, onAuthStateChange, signOut } from '$lib/auth';
	import BasicNameDesigner from '$lib/components/BasicNameDesigner.svelte';
	import BowKeychainDesigner from '$lib/components/BowKeychainDesigner.svelte';
	import BumpyTextDesigner from '$lib/components/BumpyTextDesigner.svelte';
	import CharmDesigner from '$lib/components/CharmDesigner.svelte';
	import CustomSVGDesigner from '$lib/components/CustomSVGDesigner.svelte';
	import DesktopRequiredView from '$lib/components/DesktopRequiredView.svelte';
	import DogTagDesigner from '$lib/components/DogTagDesigner.svelte';
	import FeedbackPage from '$lib/components/FeedbackPage.svelte';
	import FlowerDesigner from '$lib/components/FlowerDesigner.svelte';
	import SettingsPage from '$lib/components/SettingsPage.svelte';
	import HomeScreen from '$lib/components/HomeScreen.svelte';
	import InitialDesigner from '$lib/components/InitialDesigner.svelte';
	import KeycapDesigner from '$lib/components/KeycapDesigner.svelte';
	import LicenseActivationModal from '$lib/components/LicenseActivationModal.svelte';
	import LoginModal from '$lib/components/LoginModal.svelte';
	import MaintenancePage from '$lib/components/MaintenancePage.svelte';
	import PencilTopperDesigner from '$lib/components/PencilTopperDesigner.svelte';
	import StanleyTopperDesigner from '$lib/components/StanleyTopperDesigner.svelte';
	import StrawTopperDesigner from '$lib/components/StrawTopperDesigner.svelte';
	import SupportShareDialog from '$lib/components/SupportShareDialog.svelte';
	import TextOutlineDesigner from '$lib/components/TextOutlineDesigner.svelte';
	import ThankYouDialog from '$lib/components/ThankYouDialog.svelte';
	import WhistleDesigner from '$lib/components/WhistleDesigner.svelte';
	import { Button } from '$lib/components/ui/button';
	import * as Dialog from '$lib/components/ui/dialog';
	import * as Popover from '$lib/components/ui/popover/index.js';
	import type { SubscriptionStatus } from '$lib/subscription';
	import { clearLicenseCache, getSubscriptionStatus } from '$lib/subscription';
	import {
		fetchUserPalette,
		getEffectivePalette,
		saveUserPalette,
		type PaletteColor
	} from '$lib/colorPalette';
	import type { Session, User } from '@supabase/supabase-js';
	import { onDestroy, onMount } from 'svelte';
	import posthog from 'posthog-js';

	/** When true, only the maintenance page is shown. Set via VITE_MAINTENANCE_MODE (e.g. "true" or "1"). */
	const MAINTENANCE_MODE =
		import.meta.env.VITE_MAINTENANCE_MODE === 'true' ||
		import.meta.env.VITE_MAINTENANCE_MODE === '1';

	// ── Storage keys ────────────────────────────────────────────────────────
	const STORAGE_KEY_WELCOME = 'designer-has-seen-welcome';
	const STORAGE_KEY_VIEW = 'designer-current-view';
	const STORAGE_KEY_SHARE_SHOWN = 'designer-share-dialog-shown';
	const STORAGE_KEY_3MF_ANNOUNCEMENT = 'designer-has-seen-3mf-announcement';

	/** Designers under maintenance; not accessible from home and redirect to home if selected. */
	const MAINTENANCE_VIEWS = new Set<ViewName>([]);

	// ── View / routing state ────────────────────────────────────────────────
	type ViewName =
		| 'home'
		| 'textOutline'
		| 'initial'
		| 'flower'
		| 'basicName'
		| 'customSvg'
		| 'charm'
		| 'keycap'
		| 'whistle'
		| 'stanleyTopper'
		| 'strawTopper'
		| 'pencilTopper'
		| 'dogtag'
		| 'bumpyText'
		| 'bowKeychain'
		| 'feedback'
		| 'settings';

	const VALID_VIEW_NAMES: ViewName[] = [
		'home',
		'textOutline',
		'initial',
		'flower',
		'basicName',
		'customSvg',
		'charm',
		'keycap',
		'whistle',
		'stanleyTopper',
		'strawTopper',
		'pencilTopper',
		'dogtag',
		'bumpyText',
		'bowKeychain',
		'feedback',
		'settings'
	];

	/** Designer views that require desktop; on mobile we show DesktopRequiredView instead. */
	const DESIGNER_VIEWS = new Set<ViewName>([
		'textOutline',
		'initial',
		'flower',
		'basicName',
		'customSvg',
		'charm',
		'keycap',
		'whistle',
		'stanleyTopper',
		'strawTopper',
		'pencilTopper',
		'dogtag',
		'bumpyText',
		'bowKeychain'
	]);

	/** True when the URL hash contains Supabase OAuth callback params (tokens or error). Do not overwrite hash until Supabase has processed it. */
	function isSupabaseAuthHash(): boolean {
		if (typeof window === 'undefined') return false;
		const hash = (window.location.hash || '').replace(/^#/, '');
		return (
			hash.includes('access_token=') || hash.includes('refresh_token=') || hash.includes('error=')
		);
	}

	function getViewFromUrl(): ViewName | null {
		if (typeof window === 'undefined') return null;
		const hash = (window.location.hash || '').replace(/^#/, '').trim();
		if (hash === 'terms') {
			goto('/terms');
			return 'home';
		}
		if (hash === 'privacy') {
			goto('/privacy');
			return 'home';
		}
		if (hash === 'about') {
			goto('/about');
			return 'home';
		}
		if (!hash || hash === 'home') return 'home';
		if (VALID_VIEW_NAMES.includes(hash as ViewName)) {
			const view = hash as ViewName;
			return MAINTENANCE_VIEWS.has(view) ? 'home' : view;
		}
		return null;
	}

	let initialView: ViewName = 'home';
	const urlView = getViewFromUrl();
	if (urlView) {
		initialView = urlView;
	} else {
		try {
			const stored = localStorage.getItem(STORAGE_KEY_VIEW);
			if (
				stored === 'textOutline' ||
				stored === 'initial' ||
				stored === 'flower' ||
				stored === 'basicName' ||
				stored === 'customSvg' ||
				stored === 'charm' ||
				stored === 'keycap' ||
				stored === 'whistle' ||
				stored === 'stanleyTopper' ||
				stored === 'strawTopper' ||
				stored === 'pencilTopper' ||
				stored === 'dogtag' ||
				stored === 'bumpyText' ||
				stored === 'bowKeychain' ||
				stored === 'feedback' ||
				stored === 'settings' ||
				stored === 'home'
			) {
				initialView = MAINTENANCE_VIEWS.has(stored as ViewName) ? 'home' : (stored as ViewName);
			}
		} catch (_) {}
	}
	let currentView = $state<ViewName>(initialView);
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
	let show3MFAnnouncementDialog = $state(false);
	let menuOpen = $state(false);
	let userPalette: PaletteColor[] | null = $state(null);
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
		if (typeof window === 'undefined') return;
		if (isSupabaseAuthHash()) return;
		const h = currentView === 'home' ? '' : currentView;
		if (window.location.hash.replace(/^#/, '') !== h) {
			window.location.hash = h;
		}
	});

	// Redirect away from views under maintenance
	$effect(() => {
		if (MAINTENANCE_VIEWS.has(currentView)) {
			currentView = 'home';
		}
	});

	// Tawk chat: show only on home screen, hide on designers
	$effect(() => {
		if (typeof window === 'undefined') return;
		const onHome = currentView === 'home';
		(window as unknown as { __tawkViewIsHome?: boolean }).__tawkViewIsHome = onHome;
		const api = (
			window as unknown as { Tawk_API?: { showWidget?: () => void; hideWidget?: () => void } }
		).Tawk_API;
		if (api) {
			if (onHome) api.showWidget?.();
			else api.hideWidget?.();
		}
	});

	async function refreshAccessStatus() {
		if (!user?.id) {
			subscriptionStatus = null;
			return;
		}
		getSubscriptionStatus(user.id).then((s) => {
			subscriptionStatus = s;
		});
	}

	// Fetch subscription status when user changes
	$effect(() => {
		const u = user;
		if (!u?.id) {
			subscriptionStatus = null;
			return;
		}
		getSubscriptionStatus(u.id).then((s) => {
			subscriptionStatus = s;
		});
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

	const effectivePalette = $derived(getEffectivePalette(user, userPalette));

	// Tawk chat: pass logged-in user name and email when available
	$effect(() => {
		if (typeof window === 'undefined') return;
		const w = window as unknown as {
			Tawk_API?: {
				setAttributes: (
					attrs: Record<string, string | number | boolean | undefined>,
					cb?: () => void
				) => void;
			};
			__tawkSetVisitorAttributes?: () => void;
		};
		const u = user;
		const setTawkVisitor = () => {
			if (!u?.email) return;
			const name =
				(u as User & { user_metadata?: { full_name?: string; name?: string } }).user_metadata
					?.full_name ??
				(u as User & { user_metadata?: { full_name?: string; name?: string } }).user_metadata
					?.name ??
				u.email.split('@')[0] ??
				'';
			const attrs: Record<string, string | number | boolean | undefined> = {
				name: name || undefined,
				email: u.email
			};
			if (w.Tawk_API?.setAttributes) {
				w.Tawk_API.setAttributes(attrs);
			}
		};
		w.__tawkSetVisitorAttributes = setTawkVisitor;
		if (u?.email && w.Tawk_API?.setAttributes) setTawkVisitor();
	});

	// ── Handlers ────────────────────────────────────────────────────────────
	function navigateTo(view: ViewName) {
		currentView = view;
	}

	function handleStyleSelect(
		style:
			| 'textOutline'
			| 'initial'
			| 'flower'
			| 'basicName'
			| 'customSvg'
			| 'charm'
			| 'keycap'
			| 'whistle'
			| 'stanleyTopper'
			| 'strawTopper'
			| 'pencilTopper'
			| 'dogtag'
			| 'bumpyText'
			| 'bowKeychain'
	) {
		if (MAINTENANCE_VIEWS.has(style)) return;
		posthog.capture('designer_selected', { designer: style });
		navigateTo(style);
	}

	function handleBack() {
		navigateTo('home');
	}

	function openFeedback() {
		currentView = 'feedback';
	}

	function openSettings() {
		currentView = 'settings';
	}

	async function handleSavePalette(colors: PaletteColor[]) {
		if (!user?.id) return { success: false, error: 'Not signed in' };
		const result = await saveUserPalette(user.id, colors);
		if (result.success) {
			userPalette = colors;
		}
		return result;
	}

	function showPricing() {
		goto('/pricing');
	}

	async function handleSignOut() {
		const userId = user?.id ?? null;
		posthog.capture('user_signed_out');
		posthog.reset();
		await signOut();
		clearLicenseCache(userId);
		user = null;
		session = null;
		showLoginModal = true;
	}

	function closeWelcomeDialog() {
		showWelcomeDialog = false;
		localStorage.setItem(STORAGE_KEY_WELCOME, 'true');
		if (!localStorage.getItem(STORAGE_KEY_3MF_ANNOUNCEMENT)) {
			show3MFAnnouncementDialog = true;
		}
	}

	function close3MFAnnouncementDialog() {
		show3MFAnnouncementDialog = false;
		localStorage.setItem(STORAGE_KEY_3MF_ANNOUNCEMENT, 'true');
	}

	// ── Lifecycle ───────────────────────────────────────────────────────────
	onMount(() => {
		// Mobile detection: show DesktopRequiredView when opening a designer on small screens
		const mq = window.matchMedia('(max-width: 768px)');
		isMobile = mq.matches;
		mq.addEventListener('change', (e) => {
			isMobile = e.matches;
		});

		// URL hash -> view (back/forward or direct link)
		function syncViewFromHash() {
			const view = getViewFromUrl();
			if (view != null) currentView = view;
		}
		window.addEventListener('hashchange', syncViewFromHash);
		hashCleanup = () => window.removeEventListener('hashchange', syncViewFromHash);

		// Welcome dialog
		const hasSeenWelcome = localStorage.getItem(STORAGE_KEY_WELCOME);
		if (!hasSeenWelcome) showWelcomeDialog = true;

		// 3MF announcement: show once for returning users (who've seen welcome)
		if (hasSeenWelcome && !localStorage.getItem(STORAGE_KEY_3MF_ANNOUNCEMENT)) {
			show3MFAnnouncementDialog = true;
		}

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

		// Auth initialization
		(async () => {
			const initialSession = await getSession();
			session = initialSession;
			user = initialSession?.user ?? null;
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
					posthog.identify(user.id, { email: user.email });
					showLoginModal = false;
					// Clean OAuth callback hash from URL after Supabase has processed it
					if (isSupabaseAuthHash()) {
						const h = currentView === 'home' ? '' : currentView;
						setTimeout(() => {
							window.location.hash = h;
						}, 0);
					}
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

	<!-- 3MF announcement dialog (show once) -->
	{#if show3MFAnnouncementDialog}
		<div
			class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm"
			onclick={close3MFAnnouncementDialog}
			onkeydown={(e) => {
				if (e.key === 'Escape') close3MFAnnouncementDialog();
			}}
			role="dialog"
			aria-modal="true"
			aria-labelledby="3mf-announcement-title"
			tabindex="-1"
		>
			<!-- svelte-ignore a11y_click_events_have_key_events -->
			<!-- svelte-ignore a11y_no_static_element_interactions -->
			<div
				class="relative w-full max-w-md rounded-2xl border border-slate-200 bg-white shadow-xl"
				onclick={(e) => e.stopPropagation()}
			>
				<div class="p-6">
					<div class="mb-4 flex justify-center">
						<div
							class="flex h-12 w-12 items-center justify-center rounded-full bg-emerald-100 text-emerald-600"
							aria-hidden="true"
						>
							<svg
								xmlns="http://www.w3.org/2000/svg"
								class="size-6"
								fill="none"
								viewBox="0 0 24 24"
								stroke-width="2"
								stroke="currentColor"
								stroke-linecap="round"
								stroke-linejoin="round"
							>
								<path d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
							</svg>
						</div>
					</div>
					<h2 id="3mf-announcement-title" class="text-center text-xl font-bold text-slate-900">
						3MF export is now available
					</h2>
					<p class="mt-3 text-center text-sm text-slate-600">
						Export your designs as 3MF for better slicer compatibility and multi-material printing.
						Look for the "Export 3MF" button in any designer.
					</p>
					<div class="mt-6 flex justify-center">
						<Button onclick={close3MFAnnouncementDialog}>Got it</Button>
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
					<a
						href="/subscription"
						class="ml-2 inline-flex rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1 text-[11px] font-medium text-emerald-800 transition hover:bg-emerald-100 focus:ring-2 focus:ring-emerald-500/50 focus:outline-none"
					>
						{subscriptionStatus?.source === 'license' ? 'Licensed' : 'Subscribed'}
					</a>
				{:else if !subscriptionStatus?.isActive}
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
										<a
											href="/subscription"
											class="text-[11px] font-medium text-emerald-700 hover:underline"
											onclick={() => (menuOpen = false)}
										>
											{subscriptionStatus?.source === 'license' ? 'Licensed' : 'Subscribed'}
										</a>
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
	<div>
		<!-- Router -->
		{#if currentView === 'home'}
			<HomeScreen onSelect={handleStyleSelect} {user} {subscriptionStatus} />
		{:else if isMobile && DESIGNER_VIEWS.has(currentView)}
			<DesktopRequiredView onBack={handleBack} />
		{:else if currentView === 'textOutline'}
			<TextOutlineDesigner
				{user}
				{session}
				{subscriptionStatus}
				palette={effectivePalette}
				onBack={handleBack}
				onRequestLogin={() => (showLoginModal = true)}
				onShowThankYou={() => (showThankYouDialog = true)}
				onShowPricing={showPricing}
			/>
		{:else if currentView === 'initial'}
			<InitialDesigner
				{user}
				{session}
				{subscriptionStatus}
				palette={effectivePalette}
				onBack={handleBack}
				onRequestLogin={() => (showLoginModal = true)}
				onShowThankYou={() => (showThankYouDialog = true)}
				onShowPricing={showPricing}
			/>
		{:else if currentView === 'flower'}
			<FlowerDesigner
				{user}
				{session}
				{subscriptionStatus}
				palette={effectivePalette}
				onBack={handleBack}
				onRequestLogin={() => (showLoginModal = true)}
				onShowThankYou={() => (showThankYouDialog = true)}
				onShowPricing={showPricing}
			/>
		{:else if currentView === 'basicName'}
			<BasicNameDesigner
				{user}
				{session}
				{subscriptionStatus}
				palette={effectivePalette}
				onBack={handleBack}
				onRequestLogin={() => (showLoginModal = true)}
				onShowThankYou={() => (showThankYouDialog = true)}
				onShowPricing={showPricing}
			/>
		{:else if currentView === 'customSvg'}
			<CustomSVGDesigner
				{user}
				{session}
				{subscriptionStatus}
				palette={effectivePalette}
				onBack={handleBack}
				onRequestLogin={() => (showLoginModal = true)}
				onShowThankYou={() => (showThankYouDialog = true)}
				onShowPricing={showPricing}
			/>
		{:else if currentView === 'charm'}
			<CharmDesigner
				{user}
				{session}
				{subscriptionStatus}
				palette={effectivePalette}
				onBack={handleBack}
				onRequestLogin={() => (showLoginModal = true)}
				onShowThankYou={() => (showThankYouDialog = true)}
				onShowPricing={showPricing}
			/>
		{:else if currentView === 'keycap'}
			<KeycapDesigner
				{user}
				{session}
				{subscriptionStatus}
				palette={effectivePalette}
				onBack={handleBack}
				onRequestLogin={() => (showLoginModal = true)}
				onShowThankYou={() => (showThankYouDialog = true)}
				onShowPricing={showPricing}
			/>
		{:else if currentView === 'whistle'}
			<WhistleDesigner
				{user}
				{session}
				{subscriptionStatus}
				palette={effectivePalette}
				onBack={handleBack}
				onRequestLogin={() => (showLoginModal = true)}
				onShowThankYou={() => (showThankYouDialog = true)}
				onShowPricing={showPricing}
			/>
		{:else if currentView === 'stanleyTopper'}
			<StanleyTopperDesigner
				{user}
				{session}
				{subscriptionStatus}
				palette={effectivePalette}
				onBack={handleBack}
				onRequestLogin={() => (showLoginModal = true)}
				onShowThankYou={() => (showThankYouDialog = true)}
				onShowPricing={showPricing}
			/>
		{:else if currentView === 'strawTopper'}
			<StrawTopperDesigner
				{user}
				{session}
				{subscriptionStatus}
				palette={effectivePalette}
				onBack={handleBack}
				onRequestLogin={() => (showLoginModal = true)}
				onShowThankYou={() => (showThankYouDialog = true)}
				onShowPricing={showPricing}
			/>
		{:else if currentView === 'pencilTopper'}
			<PencilTopperDesigner
				{user}
				{session}
				{subscriptionStatus}
				palette={effectivePalette}
				onBack={handleBack}
				onRequestLogin={() => (showLoginModal = true)}
				onShowThankYou={() => (showThankYouDialog = true)}
				onShowPricing={showPricing}
			/>
		{:else if currentView === 'dogtag'}
			<DogTagDesigner
				{user}
				{session}
				{subscriptionStatus}
				palette={effectivePalette}
				onBack={handleBack}
				onRequestLogin={() => (showLoginModal = true)}
				onShowThankYou={() => (showThankYouDialog = true)}
				onShowPricing={showPricing}
			/>
		{:else if currentView === 'bumpyText'}
			<BumpyTextDesigner
				{user}
				{session}
				{subscriptionStatus}
				palette={effectivePalette}
				onBack={handleBack}
				onRequestLogin={() => (showLoginModal = true)}
				onShowThankYou={() => (showThankYouDialog = true)}
				onShowPricing={showPricing}
			/>
		{:else if currentView === 'bowKeychain'}
			<BowKeychainDesigner
				{user}
				{session}
				{subscriptionStatus}
				palette={effectivePalette}
				onBack={handleBack}
				onRequestLogin={() => (showLoginModal = true)}
				onShowThankYou={() => (showThankYouDialog = true)}
				onShowPricing={showPricing}
			/>
		{:else if currentView === 'feedback'}
			<FeedbackPage {user} onBack={handleBack} onRequestLogin={() => (showLoginModal = true)} />
		{:else if currentView === 'settings'}
			<SettingsPage
				{user}
				palette={effectivePalette}
				onBack={handleBack}
				onRequestLogin={() => (showLoginModal = true)}
				onSavePalette={handleSavePalette}
			/>
		{/if}
	</div>
{/if}
