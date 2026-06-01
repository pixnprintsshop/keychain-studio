<script lang="ts">
	import DesignerRoutePage from '$lib/components/DesignerRoutePage.svelte';
	import type { DesignerId } from '$lib/designers';

	let { params }: { params: { designer: DesignerId } } = $props();
</script>

<DesignerRoutePage designerId={params.designer} />
