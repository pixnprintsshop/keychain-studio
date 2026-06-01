<script lang="ts">
	import ContactPage from '$lib/components/ContactPage.svelte';
	import { getStudioContext } from '$lib/studio/context.svelte';

	const studio = getStudioContext();
</script>

<ContactPage user={studio.user} onBack={studio.goHome} />
