<script lang="ts">
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import HomeScreen from '$lib/components/HomeScreen.svelte';
	import { type DesignerId } from '$lib/designers';
	import { getStudioContext } from '$lib/studio/context.svelte';
	import posthog from 'posthog-js';

	const studio = getStudioContext();

	function handleStyleSelect(style: DesignerId) {
		posthog.capture('designer_selected', { designer: style });
		goto(`/${style}` as `/${typeof style}`);
	}
</script>

<HomeScreen
	onSelect={handleStyleSelect}
	user={studio.user}
	subscriptionStatus={studio.subscriptionStatus}
	onShowPricing={studio.showPricing}
	onRequestLogin={studio.requestLogin}
/>
