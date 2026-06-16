<script lang="ts">
	import { goto } from '$app/navigation';
	import DesignerRoutePage from '$lib/components/DesignerRoutePage.svelte';
	import { designerPath, resolveDesignerId, type DesignerId } from '$lib/designers/ids';

	let { params }: { params: { designer: string } } = $props();

	const designerId = $derived(resolveDesignerId(params.designer) as DesignerId | null);

	$effect(() => {
		if (!designerId || params.designer === designerId) return;
		void goto(designerPath(designerId), { replaceState: true, noScroll: true });
	});
</script>

{#if designerId}
	<DesignerRoutePage {designerId} />
{/if}
