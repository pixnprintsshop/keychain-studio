<script lang="ts">
	import DesignerLoadingScreen from '$lib/components/DesignerLoadingScreen.svelte';
	import DesktopRequiredView from '$lib/components/DesktopRequiredView.svelte';
	import { Button } from '$lib/components/ui/button';
	import {
		canAccessComingSoonDesigner,
		isComingSoonDesignerId
	} from '$lib/comingSoonDesigners';
	import { setCurrentDesignerId } from '$lib/currentDesigner.svelte';
	import { getDesignerDisplayName } from '$lib/designerDisplayNames';
	import { loadDesignerComponent } from '$lib/designers/components';
	import type { DesignerId } from '$lib/designers/ids';
	import {
		canAccessExclusiveDesigner,
		isExclusiveDesigner
	} from '$lib/exclusiveDesigners';
	import { getStudioContext } from '$lib/studio/context.svelte';
	import { loadSubscriptionTrialForDesigner } from '$lib/subscriptionTrial.svelte';
	import { userFeatureFlags } from '$lib/userFeatureFlags.svelte';
	import { onDestroy } from 'svelte';

	let { designerId }: { designerId: DesignerId } = $props();

	const studio = getStudioContext();
	const hasFeature = (key: string) => userFeatureFlags.has(key);
	const designerModule = $derived(loadDesignerComponent(designerId));
	const exclusiveAccess = $derived(canAccessExclusiveDesigner(designerId, hasFeature));
	const comingSoonAccess = $derived(canAccessComingSoonDesigner(designerId, hasFeature));
	const needsFeatureFlags = $derived(
		isExclusiveDesigner(designerId) || isComingSoonDesignerId(designerId)
	);
	const flagsPending = $derived(needsFeatureFlags && !userFeatureFlags.loaded);
	const exclusiveBlocked = $derived(
		isExclusiveDesigner(designerId) && userFeatureFlags.loaded && !exclusiveAccess
	);
	const comingSoonBlocked = $derived(
		isComingSoonDesignerId(designerId) && userFeatureFlags.loaded && !comingSoonAccess
	);

	$effect(() => {
		setCurrentDesignerId(designerId);
		if (studio.subscriptionStatus?.onTrial) {
			void loadSubscriptionTrialForDesigner(designerId);
		}
	});

	onDestroy(() => {
		setCurrentDesignerId(null);
	});
</script>

{#if studio.isMobile}
	<DesktopRequiredView onBack={studio.goHome} />
{:else if flagsPending}
	<DesignerLoadingScreen />
{:else if exclusiveBlocked}
	<main class="flex h-dvh w-dvw flex-col items-center justify-center gap-4 bg-slate-50 p-4">
		<div class="max-w-md space-y-2 text-center">
			<p class="text-lg font-semibold text-slate-900">Invite only</p>
			<p class="text-sm text-slate-600">
				{getDesignerDisplayName(designerId)} is exclusive and not available on your account yet.
				Contact us if you believe you should have access.
			</p>
		</div>
		<Button variant="outline" onclick={studio.goHome}>Back to home</Button>
	</main>
{:else if comingSoonBlocked}
	<main class="flex h-dvh w-dvw flex-col items-center justify-center gap-4 bg-slate-50 p-4">
		<div class="max-w-md space-y-2 text-center">
			<p class="text-lg font-semibold text-slate-900">Coming soon</p>
			<p class="text-sm text-slate-600">
				{getDesignerDisplayName(designerId)} is not available yet. Early access is granted by invite
				— contact us if you believe you should have access.
			</p>
		</div>
		<Button variant="outline" onclick={studio.goHome}>Back to home</Button>
	</main>
{:else}
	{#await designerModule}
		<DesignerLoadingScreen />
	{:then Designer}
		<Designer
			user={studio.user}
			session={studio.session}
			subscriptionStatus={studio.subscriptionStatus}
			palette={studio.palette}
			onBack={studio.goHome}
			onRequestLogin={studio.requestLogin}
			onShowThankYou={studio.showThankYou}
			onShowPricing={studio.showPricing}
		/>
	{:catch}
		<main class="flex h-dvh w-dvw flex-col items-center justify-center gap-4 bg-slate-50 p-4">
			<p class="text-sm font-medium text-slate-600">Could not load this designer.</p>
			<Button variant="outline" onclick={studio.goHome}>Back to home</Button>
		</main>
	{/await}
{/if}
