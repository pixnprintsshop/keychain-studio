<script lang="ts">
	import * as Popover from '$lib/components/ui/popover/index.js';
	import type { PaletteColor } from '$lib/colorPalette';

	interface Props {
		value?: string;
		palette: PaletteColor[];
		label?: string;
		disabled?: boolean;
		id?: string;
	}

	let { value = $bindable('#ffffff'), palette, label, disabled = false, id }: Props = $props();

	let open = $state(false);

	function normalizeHex(hex: string): string {
		const h = (hex || '').replace(/^#/, '').trim();
		if (!h) return '#ffffff';
		if (h.length === 3) return '#' + h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
		return h.startsWith('#') ? hex : '#' + h;
	}

	const displayValue = $derived(normalizeHex(value));

	const isInPalette = $derived(palette.some((c) => normalizeHex(c.hex) === displayValue));

	const displayColors = $derived.by(() => {
		const normalized = palette.map((c) => ({ ...c, hex: normalizeHex(c.hex) }));
		if (!isInPalette && displayValue) {
			return [{ hex: displayValue, name: 'Current' }, ...normalized];
		}
		return normalized;
	});

	function selectColor(hex: string) {
		value = normalizeHex(hex);
		open = false;
	}
</script>

<label class="grid gap-1.5" for={id}>
	{#if label}
		<span class="text-xs font-medium text-slate-700">{label}</span>
	{/if}
	<Popover.Root bind:open>
		<Popover.Trigger>
			{#snippet child({ props })}
				<button
					{id}
					type="button"
					{disabled}
					{...props}
					class="flex min-w-0 items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2 text-left text-xs font-medium text-slate-900 shadow-sm outline-none ring-indigo-500/25 focus:border-indigo-400 focus:ring-2 disabled:cursor-not-allowed disabled:opacity-50"
					aria-label="Select color"
				>
					<span
						class="h-8 w-8 shrink-0 rounded-lg border border-slate-200"
						style="background-color: {displayValue}"
					></span>
					<span class="min-w-0 truncate tabular-nums">{displayValue}</span>
				</button>
			{/snippet}
		</Popover.Trigger>
		<Popover.Content class="w-72 p-3" align="start">
			<div class="grid grid-cols-5 gap-2">
				{#each displayColors as color (color.hex)}
					<button
						type="button"
						class="flex cursor-pointer flex-col items-center gap-1 rounded-lg p-1 transition hover:bg-slate-100 focus:outline-none focus:ring-2 focus:ring-indigo-500/50"
						onclick={() => selectColor(color.hex)}
						title={color.name ?? color.hex}
					>
						<span
							class="aspect-3/2 w-full min-h-8 rounded border border-slate-300/80"
							style="background-color: {color.hex}"
						></span>
						{#if color.name}
							<span class="max-w-full truncate text-[10px] text-slate-600">{color.name}</span>
						{/if}
					</button>
				{/each}
			</div>
		</Popover.Content>
	</Popover.Root>
</label>
