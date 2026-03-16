<script lang="ts">
	import { goto } from '$app/navigation';
	import SubscriptionPage from '$lib/components/SubscriptionPage.svelte';
</script>

<SubscriptionPage onBack={() => goto('/')} />
