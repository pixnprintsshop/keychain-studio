<script lang="ts">
	interface Props {
		onSnapshot: () => void;
		onExport: () => void;
		exportDisabled: boolean;
		exportTitle: string;
		exportLoading?: boolean;
		/** When true, show lock icon + "Export STL" on the export button (e.g. when login/license required). */
		showLockIcon?: boolean;
		/** Optional: when provided, show a second "Export 3MF" button for multipart 3MF export (base, border, text). */
		onExport3MF?: () => void;
		/** Optional: when provided, show a second STL button (e.g. "Bow+text STL"). */
		onExportSTL2?: () => void;
		exportSTL2Label?: string;
	}

	let {
		onSnapshot,
		onExport,
		exportDisabled,
		exportTitle,
		exportLoading = false,
		showLockIcon = false,
		onExport3MF,
		onExportSTL2,
		exportSTL2Label = 'Bow+text STL'
	}: Props = $props();
</script>

<div class="flex items-center gap-2">
	<button
		class="rounded-full border border-slate-200 bg-white/90 p-2.5 text-slate-600 shadow-lg backdrop-blur transition hover:-translate-y-0.5 hover:text-slate-900 hover:shadow-xl focus:ring-2 focus:ring-indigo-500/30 focus:outline-none"
		type="button"
		onclick={onSnapshot}
		aria-label="Download snapshot"
		title="Download snapshot"
	>
		<svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
			<path
				stroke-linecap="round"
				stroke-linejoin="round"
				d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z"
			/>
			<circle cx="12" cy="13" r="3" />
		</svg>
	</button>
	<button
		class="rounded-full border border-slate-200 bg-white/90 px-4 py-2 text-sm font-semibold tracking-tight text-slate-900 shadow-lg backdrop-blur transition hover:-translate-y-0.5 hover:shadow-xl focus:ring-2 focus:ring-indigo-500/30 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
		type="button"
		onclick={onExport}
		aria-label="Download STL"
		disabled={exportDisabled}
		title={exportTitle}
	>
		{#if showLockIcon}
			<span class="flex items-center gap-2">
				<svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
					<path
						stroke-linecap="round"
						stroke-linejoin="round"
						stroke-width="2"
						d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"
					/>
				</svg>
				Export STL
			</span>
		{:else if exportLoading}
			Exporting…
		{:else}
			Export STL
		{/if}
	</button>
	{#if onExportSTL2}
		<button
			class="rounded-full border border-slate-200 bg-white/90 px-3 py-2 text-sm font-semibold tracking-tight text-slate-900 shadow-lg backdrop-blur transition hover:-translate-y-0.5 hover:shadow-xl focus:ring-2 focus:ring-indigo-500/30 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
			type="button"
			onclick={onExportSTL2}
			disabled={exportDisabled}
			title="Export bow + text as one STL"
		>
			{#if exportLoading}
				Exporting…
			{:else}
				{exportSTL2Label}
			{/if}
		</button>
	{/if}
	<!-- {#if onExport3MF}
		<button
			class="rounded-full border border-slate-200 bg-white/90 px-4 py-2 text-sm font-semibold tracking-tight text-slate-900 shadow-lg backdrop-blur transition hover:-translate-y-0.5 hover:shadow-xl focus:ring-2 focus:ring-indigo-500/30 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
			type="button"
			onclick={onExport3MF}
			aria-label="Download 3MF (multipart)"
			disabled={exportDisabled}
			title="Export 3MF with separate parts (base, border, text) for multi-material printing"
		>
			{#if exportLoading}
				Exporting…
			{:else}
				Export 3MF
			{/if}
		</button>
	{/if} -->
</div>
