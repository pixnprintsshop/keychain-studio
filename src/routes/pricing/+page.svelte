<script lang="ts">
    import { goto } from '$app/navigation';
    import PricingPage from '$lib/components/PricingPage.svelte';
</script>

<PricingPage onBack={() => goto('/')} />
