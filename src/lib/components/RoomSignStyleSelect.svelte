<script lang="ts">
	import ChevronDownIcon from '@lucide/svelte/icons/chevron-down';
	import { cn } from '$lib/utils';
	import {
		ROOM_SIGN_STYLE_IDS,
		ROOM_SIGN_STYLES,
		type RoomSignStyleId
	} from '$lib/roomSignStyles';
	import { tick } from 'svelte';
	import * as Popover from './ui/popover/index.js';

	interface Props {
		value: RoomSignStyleId;
		id?: string;
		triggerClass?: string;
	}

	let { value = $bindable(), id, triggerClass = 'min-w-0 flex-1' }: Props = $props();

	let open = $state(false);

	const selectedStyle = $derived(ROOM_SIGN_STYLES[value]);

	async function selectStyle(next: RoomSignStyleId) {
		open = false;
		if (next === value) return;
		await tick();
		value = next;
	}
</script>

<Popover.Root bind:open>
	<Popover.Trigger>
		{#snippet child({ props })}
			<button
				{id}
				type="button"
				{...props}
				class={cn(
					'flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-left text-xs text-slate-900 shadow-sm outline-none ring-indigo-500/25 focus:border-indigo-400 focus:ring-2',
					triggerClass
				)}
				role="combobox"
				aria-expanded={open}
				aria-label="Select room sign style"
			>
				<img
					src={selectedStyle.previewImageUrl}
					alt=""
					class="h-8 w-10 shrink-0 rounded border border-slate-200 object-cover object-center"
				/>
				<span class="min-w-0 flex-1 truncate font-medium">{selectedStyle.label}</span>
				<ChevronDownIcon
					class={cn(
						'h-3.5 w-3.5 shrink-0 text-slate-500 transition-transform',
						open && 'rotate-180'
					)}
				/>
			</button>
		{/snippet}
	</Popover.Trigger>
	<Popover.Content
		class="w-[min(100vw-2rem,18rem)] p-2 animate-none data-[state=open]:animate-none data-[state=closed]:animate-none data-[state=closed]:zoom-out-100 data-[state=open]:zoom-in-100"
		align="start"
		onOpenAutoFocus={(e) => e.preventDefault()}
		onCloseAutoFocus={(e) => e.preventDefault()}
	>
		<div class="grid grid-cols-3 gap-2">
			{#each ROOM_SIGN_STYLE_IDS as styleId (styleId)}
				{@const style = ROOM_SIGN_STYLES[styleId]}
				<button
					type="button"
					class={cn(
						'flex flex-col items-center gap-1 rounded-lg border p-1.5 text-center outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/40',
						value === styleId
							? 'border-indigo-400 bg-indigo-50/80'
							: 'border-slate-200 bg-white hover:border-indigo-300 hover:bg-slate-50'
					)}
					onclick={() => selectStyle(styleId)}
					aria-pressed={value === styleId}
					aria-label={style.label}
				>
					<img
						src={style.previewImageUrl}
						alt=""
						class="aspect-5/4 w-full rounded border border-slate-200 object-cover object-center"
					/>
					<span class="line-clamp-2 text-[10px] leading-tight font-medium text-slate-700">
						{style.label}
					</span>
				</button>
			{/each}
		</div>
	</Popover.Content>
</Popover.Root>
