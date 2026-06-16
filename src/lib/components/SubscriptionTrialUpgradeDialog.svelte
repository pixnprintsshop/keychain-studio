<script lang="ts">
	import { Button } from '$lib/components/ui/button';
	import * as Dialog from '$lib/components/ui/dialog';
	import { convertSubscriptionTrial } from '$lib/convertSubscriptionTrial';
	import { subscriptionTrial } from '$lib/subscriptionTrial.svelte';
	import type { SubscriptionStatus } from '$lib/subscription';
	import type { Session } from '@supabase/supabase-js';
	import { capture } from '$lib/analytics';

	interface Props {
		open: boolean;
		onOpenChange: (open: boolean) => void;
		session: Session | null;
		subscriptionStatus: SubscriptionStatus | null;
		onConverted?: () => void | Promise<void>;
		onViewPricing?: () => void;
	}

	let {
		open,
		onOpenChange,
		session,
		subscriptionStatus,
		onConverted,
		onViewPricing
	}: Props = $props();

	let loading = $state(false);
	let error = $state<string | null>(null);
	let step = $state<'upgrade' | 'success'>('upgrade');
	let portalUrl = $state<string | null>(null);

	const plan = $derived(subscriptionStatus?.plan ?? 'monthly');
	const maxPerDesign = $derived(subscriptionTrial.maxPerDesign);

	$effect(() => {
		if (!open) {
			step = 'upgrade';
			error = null;
			portalUrl = null;
		}
	});

	async function handlePurchaseNow() {
		if (!session?.access_token) return;
		loading = true;
		error = null;
		portalUrl = null;
		capture('subscription_trial_upgrade_clicked', { source: 'dialog', plan });
		const result = await convertSubscriptionTrial(session.access_token, { plan });
		loading = false;

		if (result.requiresPortal && result.url) {
			portalUrl = result.url;
			window.open(result.url, '_blank', 'noopener,noreferrer');
			error =
				result.message ??
				'Complete your payment in the Lemon Squeezy tab, then return here and try again if exports are still locked.';
			return;
		}

		if (!result.success) {
			error = result.error ?? 'Could not complete upgrade. Please try again.';
			return;
		}

		capture('subscription_trial_converted', { plan, source: 'dialog' });
		step = 'success';
		await onConverted?.();
	}

	function handleContinue() {
		onOpenChange(false);
	}

	function handleViewPricing() {
		onOpenChange(false);
		onViewPricing?.();
	}
</script>

<Dialog.Root {open} {onOpenChange}>
	<Dialog.Content class="max-w-md gap-0 overflow-hidden rounded-2xl border-slate-200 p-0 shadow-xl">
		{#if step === 'success'}
			<div class="bg-linear-to-br from-emerald-100 via-white to-teal-50 px-6 pt-6 pb-4">
				<Dialog.Header class="space-y-2 text-left">
					<div
						class="mb-1 flex h-12 w-12 items-center justify-center rounded-full bg-emerald-100 text-emerald-700"
						aria-hidden="true"
					>
						<svg class="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
							<path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7" />
						</svg>
					</div>
					<Dialog.Title class="text-xl font-bold tracking-tight text-slate-900">
						You're all set!
					</Dialog.Title>
					<Dialog.Description class="text-sm leading-relaxed text-slate-600">
						Your subscription is active and unlimited exports are unlocked. You can keep designing
						right where you left off.
					</Dialog.Description>
				</Dialog.Header>
			</div>
			<div class="px-6 py-5">
				<Button class="w-full" onclick={handleContinue}>Continue designing</Button>
			</div>
		{:else}
			<div class="bg-linear-to-br from-violet-100 via-white to-indigo-50 px-6 pt-6 pb-4">
				<Dialog.Header class="space-y-2 text-left">
					<Dialog.Title class="text-xl font-bold tracking-tight text-slate-900">
						Trial downloads used
					</Dialog.Title>
					<Dialog.Description class="text-sm leading-relaxed text-slate-600">
						You've used all {maxPerDesign} trial download{maxPerDesign === 1 ? '' : 's'} for this
						design. Purchase now to end your free trial and unlock unlimited exports across every
						designer.
					</Dialog.Description>
				</Dialog.Header>
			</div>

			<div class="space-y-4 px-6 py-5">
				<div class="rounded-xl border border-violet-100 bg-violet-50/70 p-4 text-sm text-violet-950">
					<p class="font-medium">What happens when you purchase now</p>
					<ul class="mt-2 list-disc space-y-1 pl-4 text-violet-900/90">
						<li>Your Lemon Squeezy trial ends immediately</li>
						<li>You're charged for your {plan} plan today</li>
						<li>Unlimited exports unlock right away</li>
					</ul>
				</div>

				{#if error}
					<div class="space-y-2">
						<p class="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800" role="alert">{error}</p>
						{#if portalUrl}
							<Button
								class="w-full"
								variant="outline"
								onclick={() => window.open(portalUrl!, '_blank', 'noopener,noreferrer')}
							>
								Open billing portal again
							</Button>
						{/if}
					</div>
				{/if}

				<div class="space-y-2">
					<Button class="w-full" disabled={loading || !session} onclick={handlePurchaseNow}>
						{loading ? 'Processing…' : 'Purchase now — unlock unlimited'}
					</Button>
					<Button class="w-full" variant="outline" disabled={loading} onclick={handleViewPricing}>
						View pricing & plans
					</Button>
				</div>
			</div>
		{/if}
	</Dialog.Content>
</Dialog.Root>
