<script lang="ts">
	import SettingsPage from '$lib/components/SettingsPage.svelte';
	import { getStudioContext } from '$lib/studio/context.svelte';

	const studio = getStudioContext();
</script>

<SettingsPage
	user={studio.user}
	palette={studio.palette}
	onBack={studio.goHome}
	onRequestLogin={studio.requestLogin}
	onSavePalette={studio.savePalette}
/>
