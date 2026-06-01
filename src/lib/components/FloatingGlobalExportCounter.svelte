<script lang="ts">
	import { exportStats, formatExportCount } from '$lib/exportStats.svelte';

	const showPill = $derived(
		exportStats.displayBase > 0 ||
			!exportStats.loaded ||
			(exportStats.loaded && exportStats.platformTotal > 0)
	);
</script>

{#if showPill}
	<div
		class="pointer-events-none fixed top-5 left-5 z-40 max-[380px]:top-4 max-[380px]:left-3"
		aria-live="polite"
	>
		<div
			class="pointer-events-auto flex items-center gap-2.5 rounded-xl border border-slate-200/90 bg-white/90 px-3 py-2 shadow-sm backdrop-blur-sm sm:gap-3 sm:px-3.5 sm:py-2.5"
			title="Total successful exports from all users"
			aria-busy={!exportStats.loaded}
		>
			<div
				class="flex size-8 shrink-0 items-center justify-center rounded-lg bg-indigo-50 text-indigo-600 sm:size-9"
				aria-hidden="true"
			>
				<svg
					xmlns="http://www.w3.org/2000/svg"
					class="size-4 sm:size-[18px]"
					fill="none"
					viewBox="0 0 24 24"
					stroke="currentColor"
					stroke-width="2"
					stroke-linecap="round"
					stroke-linejoin="round"
				>
					<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
					<polyline points="7 10 12 15 17 10" />
					<line x1="12" y1="15" x2="12" y2="3" />
				</svg>
			</div>
			<div class="min-w-0 leading-tight">
				{#if !exportStats.loaded}
					<div class="animate-pulse" aria-hidden="true">
						<div class="h-4 w-18 rounded-md bg-slate-200 sm:h-4.5 sm:w-20"></div>
						<div class="mt-1.5 h-2.5 w-24 rounded-md bg-slate-100 sm:h-3 sm:w-28"></div>
					</div>
					<span class="sr-only">Loading export count</span>
				{:else}
					<p class="text-sm font-semibold tracking-tight text-slate-800 tabular-nums sm:text-base">
						{formatExportCount(exportStats.platformTotal)}
					</p>
					<p class="text-[10px] text-slate-500 sm:text-xs">models exported</p>
				{/if}
			</div>
		</div>
	</div>
{/if}
