<script lang="ts">
	import ChevronDownIcon from '@lucide/svelte/icons/chevron-down';
	import * as Dialog from '$lib/components/ui/dialog';
	import {
		getPickleballIconLabel,
		iconifyPreviewUrl,
		PICKLEBALL_KEYCHAIN_ICONS
	} from '$lib/pickleball-keychain-icons';
	import { cn } from '$lib/utils';

	interface Props {
		value: string;
		previewColor?: string;
	}

	let { value = $bindable(), previewColor = '#111111' }: Props = $props();

	let open = $state(false);

	const selectedLabel = $derived(getPickleballIconLabel(value));

	function selectIcon(nextId: string) {
		value = nextId;
		open = false;
	}
</script>

<div class="min-w-0 w-full">
	<button
		type="button"
		class="flex w-full min-w-0 items-center gap-2.5 rounded-xl border border-slate-200 bg-white px-3 py-2 text-left text-sm text-slate-900 shadow-sm outline-none ring-indigo-500/25 transition hover:border-indigo-300 hover:bg-slate-50 focus:border-indigo-400 focus:ring-2"
		aria-haspopup="dialog"
		aria-expanded={open}
		onclick={() => (open = true)}>
		<span
			class="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-slate-200 bg-slate-50">
			<img
				src={iconifyPreviewUrl(value, previewColor, 32)}
				alt=""
				class="h-7 w-7 object-contain"
				loading="lazy"
				decoding="async" />
		</span>
		<span class="min-w-0 flex-1 truncate font-medium">{selectedLabel}</span>
		<ChevronDownIcon class="h-4 w-4 shrink-0 text-slate-500" />
	</button>
</div>

<Dialog.Root bind:open>
	<Dialog.Content class="max-w-lg rounded-2xl border-slate-200 shadow-xl">
		<Dialog.Header>
			<Dialog.Title>Choose an icon</Dialog.Title>
			<Dialog.Description class="text-sm text-slate-600">
				{PICKLEBALL_KEYCHAIN_ICONS.length} icons — previews use your decor color.
			</Dialog.Description>
		</Dialog.Header>
		<div class="grid max-h-[min(65vh,26rem)] grid-cols-4 gap-2 overflow-y-auto pr-1 sm:grid-cols-5">
			{#each PICKLEBALL_KEYCHAIN_ICONS as icon (icon.id)}
				<button
					type="button"
					class={cn(
						'flex flex-col items-center gap-1.5 rounded-xl border p-2 text-center outline-none transition focus-visible:ring-2 focus-visible:ring-indigo-500/40',
						value === icon.id
							? 'border-indigo-400 bg-indigo-50/80 ring-2 ring-indigo-400/30'
							: 'border-slate-200 bg-white hover:border-indigo-300 hover:bg-slate-50'
					)}
					aria-pressed={value === icon.id}
					aria-label={icon.label}
					onclick={() => selectIcon(icon.id)}>
					<span
						class="flex h-12 w-12 items-center justify-center rounded-lg border border-slate-200 bg-slate-50">
						<img
							src={iconifyPreviewUrl(icon.id, previewColor, 40)}
							alt=""
							class="h-9 w-9 object-contain"
							loading="lazy"
							decoding="async" />
					</span>
					<span class="line-clamp-2 text-[10px] leading-tight font-medium text-slate-700">
						{icon.label}
					</span>
				</button>
			{/each}
		</div>
	</Dialog.Content>
</Dialog.Root>
