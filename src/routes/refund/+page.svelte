<script lang="ts">
    import { goto } from '$app/navigation';
    import RefundPolicyPage from '$lib/components/RefundPolicyPage.svelte';
</script>

<RefundPolicyPage onBack={() => goto('/')} />
