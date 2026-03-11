<script lang="ts">
    import { goto } from '$app/navigation';
    import AboutPage from '$lib/components/AboutPage.svelte';
</script>

<AboutPage onBack={() => goto('/')} />
