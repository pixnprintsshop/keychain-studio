<script lang="ts">
	import { cn } from '$lib/utils.js';

	interface Props {
		value: number;
		min: number;
		max: number;
		step?: number;
		decimals?: number;
		suffix?: string;
		onChange: (value: number) => void;
		class?: string;
	}

	let {
		value,
		min,
		max,
		step = 1,
		decimals = 1,
		suffix = '',
		onChange,
		class: className = ''
	}: Props = $props();

	let editing = $state(false);
	let draft = $state('');
	let inputEl = $state<HTMLInputElement | null>(null);

	function formatDisplay(v: number) {
		return `${v.toFixed(decimals)}${suffix}`;
	}

	function snapToStep(v: number) {
		if (step <= 0) return v;
		const snapped = Math.round(v / step) * step;
		const stepDecimals = `${step}`.includes('.') ? `${step}`.split('.')[1]?.length ?? 0 : 0;
		return Number(snapped.toFixed(stepDecimals));
	}

	function startEdit() {
		draft = value.toFixed(decimals);
		editing = true;
	}

	function cancelEdit() {
		editing = false;
	}

	function commitEdit() {
		editing = false;
		const parsed = Number.parseFloat(draft.trim());
		if (!Number.isFinite(parsed)) return;
		const clamped = Math.min(max, Math.max(min, snapToStep(parsed)));
		onChange(clamped);
	}

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter') {
			e.preventDefault();
			(e.currentTarget as HTMLInputElement).blur();
		} else if (e.key === 'Escape') {
			e.preventDefault();
			cancelEdit();
		}
	}

	$effect(() => {
		if (editing && inputEl) {
			inputEl.focus();
			inputEl.select();
		}
	});
</script>

{#if editing}
	<input
		bind:this={inputEl}
		type="text"
		inputmode="decimal"
		class={cn(
			'h-5 min-w-[3.5rem] rounded border border-indigo-300 bg-white px-1 text-right text-xs tabular-nums text-slate-700 outline-none ring-indigo-500/30 focus:ring-1',
			className
		)}
		bind:value={draft}
		onblur={commitEdit}
		onkeydown={handleKeydown}
	/>
{:else}
	<button
		type="button"
		class={cn(
			'cursor-text text-xs tabular-nums text-slate-600 underline-offset-2 hover:text-indigo-700 hover:underline',
			className
		)}
		onclick={(e) => {
			e.stopPropagation();
			startEdit();
		}}
		title="Click to enter a value"
	>
		{formatDisplay(value)}
	</button>
{/if}
