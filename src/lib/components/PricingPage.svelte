<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import { Button } from '$lib/components/ui/button';
	import LicenseActivationModal from '$lib/components/LicenseActivationModal.svelte';
	import { getSession, onAuthStateChange } from '$lib/auth';
	import { convertSubscriptionTrial } from '$lib/convertSubscriptionTrial';
	import {
		getSubscriptionStatus,
		setLicenseCache,
		type SubscriptionStatus
	} from '$lib/subscription';
	import type { Session } from '@supabase/supabase-js';
	import { capture } from '$lib/analytics';

	interface Props {
		onBack: () => void;
		onRequestLogin?: () => void;
		/** When true, emphasize upgrading from an active LS trial. */
		upgradeTrial?: boolean;
	}
	let { onBack, onRequestLogin, upgradeTrial = false }: Props = $props();

	let session = $state<Session | null>(null);
	let pricing = $state<{
		monthly: {
			name: string;
			priceFormatted: string;
			description: string;
			trialLabel?: string | null;
		};
		yearly: {
			name: string;
			priceFormatted: string;
			monthlyEquivalentFormatted: string;
			savingsFormatted: string;
			trialLabel?: string | null;
		};
	} | null>(null);
	let pricingError = $state<string | null>(null);
	let showLicenseModal = $state(false);
	let subscriptionStatus = $state<SubscriptionStatus | null>(null);
	let convertLoading = $state(false);
	let convertError = $state<string | null>(null);
	let convertSuccess = $state(false);
	let checkoutLoading = $state<'monthly' | 'yearly' | null>(null);

	const PRICING_CACHE_KEY = 'pixnprints-pricing-v2';
	const PRICING_CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes

	function getCachedPricing(): typeof pricing {
		try {
			const raw = sessionStorage.getItem(PRICING_CACHE_KEY);
			if (!raw) return null;
			const { data, timestamp } = JSON.parse(raw) as {
				data: NonNullable<typeof pricing>;
				timestamp: number;
			};
			if (Date.now() - timestamp > PRICING_CACHE_TTL_MS) return null;
			return data;
		} catch {
			return null;
		}
	}

	function setCachedPricing(data: NonNullable<typeof pricing>) {
		try {
			sessionStorage.setItem(PRICING_CACHE_KEY, JSON.stringify({ data, timestamp: Date.now() }));
		} catch {
			// ignore storage errors
		}
	}

	async function refreshSubscriptionStatus() {
		if (!session?.user?.id) {
			subscriptionStatus = null;
			return;
		}
		subscriptionStatus = await getSubscriptionStatus(session.user.id);
	}

	let authUnsubscribe: (() => void) | null = null;
	onMount(async () => {
		const cached = getCachedPricing();
		if (cached) {
			pricing = cached;
		}

		session = await getSession();
		await refreshSubscriptionStatus();

		const listener = onAuthStateChange(async (_event, newSession) => {
			session = newSession;
			await refreshSubscriptionStatus();
		});
		authUnsubscribe = () => listener.data.subscription.unsubscribe();

		if (cached) return;

		try {
			const res = await fetch('/api/lemonsqueezy/pricing');
			if (!res.ok) {
				const data = (await res.json()) as { error?: string };
				throw new Error(data?.error ?? 'Failed to load pricing');
			}
			const data = (await res.json()) as {
				monthly: {
					name: string;
					priceFormatted: string;
					description: string;
					trialLabel?: string | null;
				};
				yearly: {
					name: string;
					priceFormatted: string;
					monthlyEquivalentFormatted: string;
					savingsFormatted: string;
					trialLabel?: string | null;
				};
			};
			const parsed = {
				monthly: {
					name: data.monthly.name,
					priceFormatted: data.monthly.priceFormatted,
					description: data.monthly.description,
					trialLabel: data.monthly.trialLabel ?? null
				},
				yearly: {
					name: data.yearly.name,
					priceFormatted: data.yearly.priceFormatted,
					monthlyEquivalentFormatted: data.yearly.monthlyEquivalentFormatted,
					savingsFormatted: data.yearly.savingsFormatted,
					trialLabel: data.yearly.trialLabel ?? null
				}
			};
			pricing = parsed;
			setCachedPricing(parsed);
		} catch (err) {
			pricingError = err instanceof Error ? err.message : 'Failed to load pricing';
			pricing = {
				monthly: {
					name: 'Monthly',
					priceFormatted: '₱300',
					description: 'Billed every month. Cancel anytime.',
					trialLabel: '7-day free trial'
				},
				yearly: {
					name: 'Yearly',
					priceFormatted: '₱3,000',
					monthlyEquivalentFormatted: '₱250',
					savingsFormatted: '₱600',
					trialLabel: '7-day free trial'
				}
			};
		}
	});
	onDestroy(() => authUnsubscribe?.());

	const user = $derived(session?.user ?? null);
	const onLsTrial = $derived(Boolean(subscriptionStatus?.onTrial && subscriptionStatus?.isActive));
	const currentPlan = $derived(subscriptionStatus?.plan ?? 'monthly');

	async function convertTrial(plan?: 'monthly' | 'yearly') {
		if (!user?.id || !session?.access_token) {
			onRequestLogin?.();
			return;
		}
		convertLoading = true;
		convertError = null;
		convertSuccess = false;
		capture('subscription_trial_upgrade_clicked', { source: 'pricing', plan: plan ?? currentPlan });
		const result = await convertSubscriptionTrial(session.access_token, { plan: plan ?? currentPlan });
		convertLoading = false;

		if (result.requiresPortal && result.url) {
			window.open(result.url, '_blank', 'noopener,noreferrer');
			convertError =
				result.message ??
				'Complete your payment in the Lemon Squeezy tab, then return here.';
			return;
		}

		if (!result.success) {
			convertError = result.error ?? 'Could not complete upgrade. Please try again.';
			return;
		}

		capture('subscription_trial_converted', { plan: plan ?? currentPlan, source: 'pricing' });
		convertSuccess = true;
		await refreshSubscriptionStatus();
	}

	async function startCheckout(plan: 'monthly' | 'yearly') {
		if (!user?.id || !session?.access_token) {
			onRequestLogin?.();
			return;
		}
		if (onLsTrial) {
			await convertTrial(plan);
			return;
		}
		checkoutLoading = plan;
		capture('checkout_initiated', { plan });
		try {
			const res = await fetch('/api/lemonsqueezy/checkout', {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					Authorization: `Bearer ${session.access_token}`
				},
				body: JSON.stringify({ plan })
			});
			if (!res.ok) {
				const err = (await res.json()) as { error?: string };
				console.error('Failed to start checkout', err.error ?? (await res.text()));
				return;
			}
			const data = (await res.json()) as { url?: string };
			if (data.url) {
				window.location.href = data.url;
			}
		} catch (err) {
			console.error('Error starting checkout', err);
		} finally {
			checkoutLoading = null;
		}
	}

	function monthlyButtonLabel(): string {
		if (!user) return 'Sign in to subscribe';
		if (onLsTrial) return currentPlan === 'monthly' ? 'Purchase now' : 'Switch to monthly';
		return pricing?.monthly.trialLabel ? 'Start trial' : 'Start monthly subscription';
	}

	function yearlyButtonLabel(): string {
		if (!user) return 'Sign in to subscribe';
		if (onLsTrial) return currentPlan === 'yearly' ? 'Purchase now' : 'Switch to yearly';
		return pricing?.yearly.trialLabel ? 'Start trial' : 'Start yearly subscription';
	}
</script>

<main class="min-h-dvh w-dvw bg-slate-50">
	<div class="mx-auto max-w-3xl px-4 py-8">
		<div class="mb-6 flex items-center justify-between">
			<Button variant="outline" size="sm" onclick={onBack}>Back</Button>
		</div>
		<div class="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm sm:p-8">
			<h1 class="text-2xl font-bold tracking-tight text-slate-900">Pricing</h1>
			<p class="mt-1 text-sm text-slate-500">Print Studio by PixnPrints</p>

			{#if convertSuccess}
				<div class="mt-6 rounded-xl border border-emerald-200 bg-emerald-50/90 p-4">
					<div class="flex items-start gap-3">
						<div
							class="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-emerald-100 text-emerald-700"
							aria-hidden="true"
						>
							<svg class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
								<path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7" />
							</svg>
						</div>
						<div>
							<p class="text-sm font-semibold text-emerald-950">Subscription active</p>
							<p class="mt-1 text-sm text-emerald-900/90">
								Thank you! Unlimited exports are unlocked. Head back to the designer to keep
								creating.
							</p>
							<Button class="mt-3" size="sm" onclick={onBack}>Back to designing</Button>
						</div>
					</div>
				</div>
			{:else if onLsTrial}
				<div
					class="mt-6 rounded-xl border border-violet-200 bg-violet-50/80 p-4"
					class:ring-2={upgradeTrial}
					class:ring-violet-300={upgradeTrial}
				>
					<p class="text-sm font-semibold text-violet-950">
						{upgradeTrial ? 'Trial downloads used for this design' : "You're on a free trial"}
					</p>
					<p class="mt-1 text-sm text-violet-900/90">
						{#if upgradeTrial}
							Purchase now to end your trial and unlock unlimited exports. You'll be charged for
							your {currentPlan} plan today.
						{:else}
							You can upgrade early anytime — your trial ends immediately and billing starts today
							for unlimited exports.
						{/if}
					</p>
					<Button
						class="mt-3"
						size="sm"
						disabled={convertLoading}
						onclick={() => convertTrial()}
					>
						{convertLoading ? 'Processing…' : 'Purchase now — unlock unlimited'}
					</Button>
					{#if convertError}
						<p class="mt-2 text-sm text-red-700" role="alert">{convertError}</p>
					{/if}
				</div>
			{/if}

			{#if pricing}
				{#if pricingError}
					<p class="mt-4 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">
						Using fallback pricing. {pricingError}
					</p>
				{/if}
				<div class="mt-8 grid gap-4 sm:grid-cols-2">
					<div class="flex flex-col rounded-xl border border-slate-200 bg-slate-50/50 p-6">
						<h2 class="text-lg font-semibold text-slate-900">
							{pricing.monthly.name}
						</h2>
						{#if pricing.monthly.trialLabel && !onLsTrial}
							<span
								class="mt-2 inline-block w-fit rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-800"
							>
								{pricing.monthly.trialLabel}
							</span>
						{/if}
						<p class="mt-2 text-2xl font-bold text-slate-900">
							{pricing.monthly.priceFormatted}
							<span class="text-sm font-normal text-slate-500">/month</span>
						</p>
						<p class="mt-2 text-sm text-slate-600">
							{pricing.monthly.description}
						</p>
						<div class="flex-1"></div>
						<Button
							class="mt-4 w-full"
							disabled={convertLoading || checkoutLoading !== null}
							onclick={() => (user ? startCheckout('monthly') : onRequestLogin?.())}
						>
							{convertLoading || checkoutLoading === 'monthly' ? 'Processing…' : monthlyButtonLabel()}
						</Button>
					</div>
					<div class="rounded-xl border-2 border-indigo-200 bg-indigo-50/30 p-6">
						<span
							class="inline-block rounded-full bg-indigo-100 px-2 py-0.5 text-xs font-medium text-indigo-800"
						>
							Best value
						</span>
						<h2 class="mt-2 text-lg font-semibold text-slate-900">
							{pricing.yearly.name}
						</h2>
						{#if pricing.yearly.trialLabel && !onLsTrial}
							<span
								class="mt-2 inline-block w-fit rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-800"
							>
								{pricing.yearly.trialLabel}
							</span>
						{/if}
						<p class="mt-2 text-2xl font-bold text-slate-900">
							{pricing.yearly.priceFormatted}
							<span class="text-sm font-normal text-slate-500">/year</span>
						</p>
						<p class="mt-1 text-sm text-slate-600">
							{pricing.yearly.monthlyEquivalentFormatted}/month — save {pricing.yearly
								.savingsFormatted} per year
						</p>
						<Button
							class="mt-4 w-full"
							disabled={convertLoading || checkoutLoading !== null}
							onclick={() => (user ? startCheckout('yearly') : onRequestLogin?.())}
						>
							{convertLoading || checkoutLoading === 'yearly' ? 'Processing…' : yearlyButtonLabel()}
						</Button>
					</div>
				</div>
			{:else}
				<div class="mt-8 flex items-center justify-center py-12">
					<div
						class="h-8 w-8 animate-spin rounded-full border-2 border-indigo-600 border-t-transparent"
					></div>
				</div>
			{/if}

			<p class="mt-6 text-sm text-slate-600">
				Subscriptions unlock full export access and all designers. You can manage your subscription
				and billing details from your account after subscribing.
			</p>

			{#if subscriptionStatus}
				{#if subscriptionStatus?.licenseExpired}
					<div class="mt-8 rounded-xl border border-amber-200 bg-amber-50/80 p-4">
						<p class="text-sm font-medium text-amber-900">License expired</p>
						<p class="mt-1 text-sm text-amber-800">
							Your license has expired. Subscribe above or activate a new license code to restore access.
						</p>
						<Button
							variant="outline"
							size="sm"
							class="mt-3"
							onclick={() => (showLicenseModal = true)}
						>
							Activate new license
						</Button>
					</div>
				{:else if subscriptionStatus?.isActive && subscriptionStatus.onTrial}
					<div class="mt-8 rounded-xl border border-slate-200 bg-slate-50/80 p-4">
						<p class="text-sm font-medium text-slate-900">Subscription trial active</p>
						<p class="mt-1 text-sm text-slate-600">
							You're subscribed on a free trial. Limited trial downloads apply per design — purchase
							now above for unlimited exports.
						</p>
					</div>
				{:else if subscriptionStatus?.isActive && subscriptionStatus.source === 'subscription'}
					<div class="mt-8 rounded-xl border border-emerald-200 bg-emerald-50/80 p-4">
						<p class="text-sm font-medium text-emerald-900">Subscription active</p>
						<p class="mt-1 text-sm text-emerald-700">
							You have full export access via your subscription.
						</p>
					</div>
				{:else if !subscriptionStatus?.isActive}
					<div class="mt-8 rounded-xl border border-slate-200 bg-slate-50/80 p-4">
						<p class="text-sm font-medium text-slate-900">Already have a license code?</p>
						<p class="mt-1 text-sm text-slate-600">
							If you purchased a license manually (e.g. direct payment), enter your license key
							below to activate full access.
						</p>
						<Button
							variant="outline"
							size="sm"
							class="mt-3"
							onclick={() => (showLicenseModal = true)}
						>
							Activate license
						</Button>
					</div>
				{:else if subscriptionStatus?.source === 'license'}
					<div class="mt-8 rounded-xl border border-emerald-200 bg-emerald-50/80 p-4">
						<p class="text-sm font-medium text-emerald-900">License active</p>
						<p class="mt-1 text-sm text-emerald-700">
							You have full export access via your license.
						</p>
					</div>
				{/if}
			{/if}
		</div>
	</div>

	{#if !subscriptionStatus?.isActive}
		<LicenseActivationModal
			bind:isOpen={showLicenseModal}
			onSuccess={() => {
				showLicenseModal = false;
				subscriptionStatus = { isActive: true, source: 'license' };
				if (session?.user?.id) setLicenseCache(session.user.id);
			}}
		/>
	{/if}
</main>
