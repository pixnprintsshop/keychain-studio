<script lang="ts">
    import { goto } from '$app/navigation';
    import TermsPage from '$lib/components/TermsPage.svelte';
</script>

<TermsPage onBack={() => goto('/')} />
