<script lang="ts">
	import { Button } from '$lib/components/ui/button';
	import * as Dialog from '$lib/components/ui/dialog';

	interface Props {
		open: boolean;
		onOpenChange: (open: boolean) => void;
		onTryIt: () => void;
	}

	let { open, onOpenChange, onTryIt }: Props = $props();

	const tips = [
		{ icon: '★', label: 'Tap the star on any card' },
		{ icon: '↑', label: 'Pinned designers stay on top' },
		{ icon: '☁', label: 'Syncs when you sign in' }
	];

	function dismiss() {
		onOpenChange(false);
	}

	function handleTryIt() {
		onTryIt();
		onOpenChange(false);
	}
</script>

<Dialog.Root {open} {onOpenChange}>
	<Dialog.Content
		class="flex max-w-2xl flex-col gap-0 overflow-hidden rounded-2xl border-slate-200 p-0 shadow-xl sm:max-w-2xl"
	>
		<div class="grid grid-cols-2">
			<div
				class="relative flex items-center justify-center overflow-hidden bg-linear-to-br from-amber-100 via-white to-orange-50 p-4 sm:p-5"
			>
				<span
					class="absolute top-3 left-3 z-10 rounded-full bg-amber-600 px-2 py-0.5 text-[9px] font-bold tracking-wide text-white uppercase sm:top-4 sm:left-4 sm:px-2.5 sm:text-[10px]"
				>
					New
				</span>
				<div
					class="w-full max-w-[200px] overflow-hidden rounded-xl border border-amber-200/80 bg-white shadow-md ring-1 ring-amber-100 sm:max-w-[220px] sm:rounded-2xl"
				>
					<div class="relative aspect-4/3 overflow-hidden bg-slate-100">
						<div
							class="absolute inset-0 bg-linear-to-br from-indigo-200 via-violet-100 to-amber-100"
						></div>
						<div
							class="pointer-events-none absolute top-2 left-2 rounded bg-emerald-100 px-1 py-0.5 text-[9px] font-semibold text-emerald-800 sm:text-[10px]"
						>
							New
						</div>
						<Button
							variant="ghost"
							size="icon"
							tabindex={-1}
							aria-hidden="true"
							class="pointer-events-none absolute right-2 bottom-2 size-7 rounded-full border border-amber-300 bg-white text-amber-500 shadow-md ring-2 ring-white/90 sm:right-2.5 sm:bottom-2.5 sm:size-8"
						>
							<svg
								xmlns="http://www.w3.org/2000/svg"
								class="size-3.5 sm:size-4"
								viewBox="0 0 24 24"
								fill="currentColor"
								stroke="currentColor"
								stroke-width="2"
								stroke-linecap="round"
								stroke-linejoin="round"
							>
								<polygon
									points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"
								/>
							</svg>
						</Button>
						<div
							class="pointer-events-none absolute top-[36%] left-1/2 -translate-x-1/2 rounded-md border border-amber-300/90 bg-white/95 px-1.5 py-0.5 text-[9px] font-semibold text-amber-900 shadow-sm backdrop-blur-sm sm:text-[10px]"
						>
							Tap to pin
						</div>
					</div>
					<div class="space-y-0.5 border-t border-slate-100 p-2 sm:p-2.5">
						<p class="text-xs font-semibold text-slate-900 sm:text-sm">Basic Name</p>
						<p class="text-[10px] leading-snug text-slate-500 sm:text-xs">Pinned to the top.</p>
					</div>
				</div>
			</div>

			<div class="flex flex-col justify-center gap-3 border-slate-100 px-4 py-4 sm:gap-3.5 sm:px-5 sm:py-5">
				<Dialog.Header class="space-y-1.5 text-left">
					<Dialog.Title class="text-base font-bold tracking-tight text-slate-900 sm:text-lg">
						Favorite designers
					</Dialog.Title>
					<Dialog.Description class="text-xs leading-relaxed text-slate-600 sm:text-sm">
						Star the designers you use most. Favorites jump to the top of your home screen — newest
						pin first.
					</Dialog.Description>
				</Dialog.Header>

				<ul class="grid gap-1.5 rounded-xl border border-amber-100 bg-amber-50/60 p-2.5 sm:gap-2 sm:p-3">
					{#each tips as tip (tip.label)}
						<li class="flex items-center gap-2 text-[11px] text-slate-700 sm:text-xs">
							<span
								class="flex size-5 shrink-0 items-center justify-center rounded-full bg-white text-[10px] font-bold text-amber-700 ring-1 ring-amber-200 sm:size-6 sm:text-[11px]"
								>{tip.icon}</span
							>
							<span class="font-medium text-slate-800">{tip.label}</span>
						</li>
					{/each}
				</ul>
			</div>
		</div>

		<Dialog.Footer
			class="shrink-0 gap-2 border-t border-slate-100 bg-slate-50/80 px-4 py-3 sm:justify-between sm:px-5 sm:py-4"
		>
			<Button type="button" variant="ghost" class="text-slate-600" onclick={dismiss}>Got it</Button>
			<Button type="button" onclick={handleTryIt}>Try favorites</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
