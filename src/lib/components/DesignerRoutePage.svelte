<script lang="ts">
	import DesignerLoadingScreen from '$lib/components/DesignerLoadingScreen.svelte';
	import DesktopRequiredView from '$lib/components/DesktopRequiredView.svelte';
	import { Button } from '$lib/components/ui/button';
	import { loadDesignerComponent } from '$lib/designers/components';
	import type { DesignerId } from '$lib/designers/ids';
	import { getStudioContext } from '$lib/studio/context.svelte';

	let { designerId }: { designerId: DesignerId } = $props();

	const studio = getStudioContext();
	const designerModule = $derived(loadDesignerComponent(designerId));
</script>

{#if studio.isMobile}
	<DesktopRequiredView onBack={studio.goHome} />
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
