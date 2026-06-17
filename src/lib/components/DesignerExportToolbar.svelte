<script lang="ts">
	import { Button } from '$lib/components/ui/button';
	import * as Popover from '$lib/components/ui/popover';
	import { freeTrial, getFingerprintBlockedMessage } from '$lib/freeTrial.svelte';
	import { subscriptionTrial } from '$lib/subscriptionTrial.svelte';
	import { getStudioContext } from '$lib/studio/context.svelte';
	import { capture } from '$lib/analytics';
	import type { OpenWithSlicerId } from '$lib/openInSlicer';

	interface Props {
		onSnapshot: () => void;
		onExport: () => void;
		exportDisabled: boolean;
		exportTitle: string;
		exportLoading?: boolean;
		/** True when the caller has determined the user has no active subscription/license.
		 * When the user still has free-trial credits we suppress the lock icon and show a
		 * "Free trial" chip instead — buttons remain functional. When credits run out we
		 * fall back to the original locked appearance. */
		showLockIcon?: boolean;
		/** Optional: when provided, show a second "Export 3MF" button for multipart 3MF export (base, border, text). */
		onExport3MF?: () => void;
		/** Optional: uploads 3MF and opens via the chosen slicer deeplink. */
		onOpenWithSlicer?: (slicer: OpenWithSlicerId) => void;
		/** When true, "Open With" shows loading state. */
		openWithSlicerLoading?: boolean;
	}

	let {
		onSnapshot,
		onExport,
		exportDisabled,
		exportTitle,
		exportLoading = false,
		showLockIcon = false,
		onExport3MF,
		onOpenWithSlicer,
		openWithSlicerLoading = false,
	}: Props = $props();

	let openWithMenuOpen = $state(false);

	/** True only when export is blocked (exhausted credits or device cap). */
	const lockedForReal = $derived(
		showLockIcon &&
			(subscriptionTrial.onTrial
				? !subscriptionTrial.hasCredits
				: freeTrial.credits === 0 || freeTrial.fingerprintBlocked)
	);
	/** Show the free-trial chip while the visitor is on the unsigned-in credit path. */
	const showFreeTrialChip = $derived(
		showLockIcon &&
			!subscriptionTrial.onTrial &&
			freeTrial.credits > 0 &&
			!freeTrial.fingerprintBlocked
	);
	const showSubscriptionTrialChip = $derived(
		subscriptionTrial.onTrial && subscriptionTrial.hasCredits
	);
	const showSubscriptionTrialExhausted = $derived(
		subscriptionTrial.onTrial && subscriptionTrial.loaded && !subscriptionTrial.hasCredits
	);
	const showFingerprintBlockedChip = $derived(showLockIcon && freeTrial.fingerprintBlocked);

	const openWithDisabled = $derived(
		exportDisabled || exportLoading || openWithSlicerLoading
	);

	function handlePurchaseNow() {
		capture('subscription_trial_upgrade_clicked', { source: 'export_toolbar' });
		getStudioContext().showPricing();
	}

	function handleSnapshot() {
		capture('snapshot_downloaded');
		onSnapshot();
	}

	function handleExportSTL() {
		if (!exportDisabled) capture('design_exported_stl', { format: 'stl' });
		onExport();
	}

	function handleExport3MF() {
		if (!exportDisabled) capture('design_exported_3mf', { format: '3mf' });
		onExport3MF?.();
	}

	function handleOpenWithSlicer(slicer: OpenWithSlicerId) {
		if (openWithDisabled) return;
		openWithMenuOpen = false;
		if (slicer === 'bambu_studio') {
			capture('design_opened_bambu_studio');
		} else {
			capture('design_opened_orca_slicer');
		}
		onOpenWithSlicer?.(slicer);
	}
</script>

<div class="flex items-center gap-2">
	{#if showFingerprintBlockedChip}
		<span
			class="inline-flex max-w-[14rem] items-center gap-1.5 rounded-full border border-amber-200 bg-amber-50/95 px-3 py-1.5 text-[11px] font-medium text-amber-900 shadow-sm backdrop-blur"
			title={getFingerprintBlockedMessage()}
		>
			Device trial limit (2 accounts)
		</span>
	{/if}
	{#if showSubscriptionTrialChip}
		<span
			class="inline-flex items-center gap-1.5 rounded-full border border-violet-200 bg-violet-50/95 px-3 py-1.5 text-[11px] font-medium text-violet-800 shadow-sm backdrop-blur"
			title={`Subscription trial: ${subscriptionTrial.remaining} of ${subscriptionTrial.maxPerDesign} downloads remaining for this design`}
		>
			<svg class="h-3 w-3" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
				<path
					fill-rule="evenodd"
					d="M10 2a8 8 0 100 16 8 8 0 000-16zm0 3a1 1 0 011 1v3.586l2.707 2.707a1 1 0 01-1.414 1.414l-3-3A1 1 0 019 10V6a1 1 0 011-1z"
					clip-rule="evenodd"
				/>
			</svg>
			Trial — {subscriptionTrial.remaining}/{subscriptionTrial.maxPerDesign} left (this design)
		</span>
	{/if}
	{#if showSubscriptionTrialExhausted}
		<Button
			variant="outline"
			size="sm"
			class="rounded-full border-violet-300 bg-violet-50/95 px-3 py-1.5 text-[11px] font-semibold text-violet-900 shadow-sm backdrop-blur hover:bg-violet-100"
			onclick={handlePurchaseNow}
			title="End trial and unlock unlimited exports"
		>
			Purchase now
		</Button>
	{/if}
	{#if showFreeTrialChip}
		<span
			class="inline-flex items-center gap-1.5 rounded-full border border-blue-200 bg-blue-50/95 px-3 py-1.5 text-[11px] font-medium text-blue-700 shadow-sm backdrop-blur"
			title={`Free trial: ${freeTrial.credits} of ${freeTrial.totalCredits} downloads remaining`}
		>
			<svg class="h-3 w-3" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
				<path
					fill-rule="evenodd"
					d="M10 2a8 8 0 100 16 8 8 0 000-16zm0 3a1 1 0 011 1v3.586l2.707 2.707a1 1 0 01-1.414 1.414l-3-3A1 1 0 019 10V6a1 1 0 011-1z"
					clip-rule="evenodd"
				/>
			</svg>
			{freeTrial.credits} free download{freeTrial.credits === 1 ? '' : 's'} left
		</span>
	{/if}
	<Button
		variant="outline"
		size="icon"
		class="rounded-full bg-white/90 shadow-lg backdrop-blur transition hover:-translate-y-0.5 hover:shadow-xl"
		onclick={handleSnapshot}
		aria-label="Download snapshot"
		title="Download snapshot"
	>
		<svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
			<path
				stroke-linecap="round"
				stroke-linejoin="round"
				d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z"
			/>
			<circle cx="12" cy="13" r="3" />
		</svg>
	</Button>
	<Button
		variant="outline"
		class="rounded-full bg-white/90 shadow-lg backdrop-blur transition hover:-translate-y-0.5 hover:shadow-xl"
		onclick={handleExportSTL}
		aria-label="Download STL"
		disabled={openWithDisabled}
		title={exportTitle}
	>
		{#if lockedForReal}
			<span class="flex items-center gap-2">
				<svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
					<path
						stroke-linecap="round"
						stroke-linejoin="round"
						stroke-width="2"
						d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"
					/>
				</svg>
				Export STL
			</span>
		{:else if exportLoading}
			Exporting…
		{:else}
			Export STL
		{/if}
	</Button>
	{#if onExport3MF}
		<Button
			variant="outline"
			class="rounded-full bg-white/90 shadow-lg backdrop-blur transition hover:-translate-y-0.5 hover:shadow-xl"
			onclick={handleExport3MF}
			aria-label="Download 3MF (multipart)"
			disabled={openWithDisabled}
			title="Export 3MF with separate parts (base, border, text) for multi-material printing"
		>
			{#if exportLoading}
				Exporting…
			{:else}
				Export 3MF
			{/if}
		</Button>
	{/if}
	{#if onOpenWithSlicer}
		<Popover.Root bind:open={openWithMenuOpen}>
			<Popover.Trigger>
				{#snippet child({ props })}
					<Button
						{...props}
						variant="outline"
						class="rounded-full border-slate-700 bg-slate-800 text-white shadow-lg backdrop-blur transition hover:-translate-y-0.5 hover:border-slate-600 hover:bg-slate-700 hover:text-white hover:shadow-xl disabled:opacity-50"
						aria-label="Open With"
						disabled={openWithDisabled}
						title="Upload 3MF and open in Bambu Studio or Orca Slicer"
					>
						{#if openWithSlicerLoading}
							Opening…
						{:else}
							Open With
						{/if}
					</Button>
				{/snippet}
			</Popover.Trigger>
			<Popover.Content class="w-52 p-1" align="end" side="top">
				<button
					type="button"
					class="flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-left text-sm text-slate-700 hover:bg-slate-100"
					onclick={() => handleOpenWithSlicer('bambu_studio')}
				>
					<img
						src="/images/bambu.png"
						alt=""
						class="h-5 w-5 shrink-0 rounded-sm object-contain"
						width="20"
						height="20"
					/>
					Bambu Studio
				</button>
				<button
					type="button"
					class="flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-left text-sm text-slate-700 hover:bg-slate-100"
					onclick={() => handleOpenWithSlicer('orca_slicer')}
				>
					<img
						src="/images/orca.png"
						alt=""
						class="h-5 w-5 shrink-0 rounded-sm object-contain"
						width="20"
						height="20"
					/>
					Orca Slicer
				</button>
			</Popover.Content>
		</Popover.Root>
	{/if}
</div>
