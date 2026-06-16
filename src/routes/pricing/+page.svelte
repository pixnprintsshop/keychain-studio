<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import PricingPage from '$lib/components/PricingPage.svelte';

	const upgradeTrial = $derived(page.url.searchParams.get('upgrade') === 'trial');
</script>

<PricingPage
	onBack={() => goto('/')}
	onRequestLogin={() => goto('/?login=1')}
	{upgradeTrial}
/>
