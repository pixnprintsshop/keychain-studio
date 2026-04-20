<script lang="ts">
	interface Props {
		sizes: { x: number; y: number; z: number } | null;
	}

	let { sizes }: Props = $props();

	function fmt(n: number): string {
		if (!Number.isFinite(n)) return '—';
		return n < 10 ? n.toFixed(2) : n.toFixed(1);
	}
</script>

{#if sizes}
	<div
		class="pointer-events-none absolute top-4 left-4 z-10 max-w-[min(100%,14rem)] rounded-xl border border-slate-200/90 bg-white/90 px-3 py-2 text-xs text-slate-700 shadow-lg backdrop-blur-sm"
		aria-live="polite"
	>
		<div class="font-semibold tracking-tight text-slate-900">Size (mm)</div>
		<div class="mt-1 grid grid-cols-[2.5rem_1fr] gap-x-2 gap-y-0.5 tabular-nums">
			<span class="text-slate-500">X</span>
			<span>{fmt(sizes.x)}</span>
			<span class="text-slate-500">Y</span>
			<span>{fmt(sizes.y)}</span>
			<span class="text-slate-500">Z</span>
			<span>{fmt(sizes.z)}</span>
		</div>
	</div>
{/if}
