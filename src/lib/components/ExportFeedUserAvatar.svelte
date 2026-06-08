<script lang="ts">
	interface Props {
		emailObscured?: string | null;
		avatarUrl?: string | null;
		size?: 'sm' | 'md';
	}

	let { emailObscured = 'Maker', avatarUrl = null, size = 'sm' }: Props = $props();

	const dimension = $derived(size === 'md' ? 'size-9' : 'size-8');
	const initial = $derived((emailObscured?.trim()?.[0] ?? 'M').toUpperCase());
</script>

<div
	class="relative shrink-0 overflow-hidden rounded-full bg-slate-200 ring-1 ring-slate-200/80 {dimension}"
	aria-hidden="true"
>
	{#if avatarUrl}
		<img
			src={avatarUrl}
			alt=""
			class="h-full w-full scale-110 object-cover blur-[3px]"
			loading="lazy"
			decoding="async"
			referrerpolicy="no-referrer"
		/>
	{:else}
		<div
			class="flex h-full w-full items-center justify-center bg-indigo-100 text-[10px] font-semibold text-indigo-600 blur-[1.5px] {size ===
			'md'
				? 'text-xs'
				: ''}"
		>
			{initial}
		</div>
	{/if}
</div>
