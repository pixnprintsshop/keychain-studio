<script lang="ts">
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import HomeScreen from '$lib/components/HomeScreen.svelte';
	import { type DesignerId } from '$lib/designers';
	import { getStudioContext } from '$lib/studio/context.svelte';
	import { capture } from '$lib/analytics';

	const studio = getStudioContext();

	function handleStyleSelect(style: DesignerId) {
		capture('designer_selected', { designer: style });
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
