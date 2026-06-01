<script lang="ts">
	import FeedbackPage from '$lib/components/FeedbackPage.svelte';
	import { getStudioContext } from '$lib/studio/context.svelte';

	const studio = getStudioContext();
</script>

<FeedbackPage
	user={studio.user}
	onBack={studio.goHome}
	onRequestLogin={studio.requestLogin}
/>
