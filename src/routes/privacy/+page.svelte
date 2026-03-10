<script lang="ts">
    import { goto } from '$app/navigation';
    import PrivacyPage from '$lib/components/PrivacyPage.svelte';
</script>

<PrivacyPage onBack={() => goto('/')} />
