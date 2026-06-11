<script lang="ts">
	import { Button } from '$lib/components/ui/button';
	import * as Dialog from '$lib/components/ui/dialog';

	interface Props {
		open: boolean;
		onOpenChange: (open: boolean) => void;
		onTryIt: () => void;
	}

	let { open, onOpenChange, onTryIt }: Props = $props();

	const highlights = [
		{ icon: '↔', label: 'Fixed on the left center — no X/Y positioning' },
		{ icon: '↗', label: 'Extension slider controls how far the tab sticks out' },
		{ icon: '○', label: 'Adjustable tab width and hole size' },
		{ icon: '⛓', label: 'Stem bridges into the outline base for a solid print' }
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
				class="relative flex items-center justify-center overflow-hidden bg-linear-to-br from-pink-100 via-white to-indigo-50 p-4 sm:p-5"
			>
				<div
					class="pointer-events-none absolute -top-8 -right-8 size-32 rounded-full bg-pink-200/40 blur-2xl"
				></div>
				<div
					class="pointer-events-none absolute -bottom-6 -left-6 size-28 rounded-full bg-indigo-200/40 blur-2xl"
				></div>
				<span
					class="absolute top-3 left-3 z-10 rounded-full bg-pink-600 px-2 py-0.5 text-[9px] font-bold tracking-wide text-white uppercase sm:top-4 sm:left-4 sm:px-2.5 sm:text-[10px]"
				>
					New
				</span>
				<div
					class="relative w-full max-w-[240px] overflow-hidden rounded-2xl border border-pink-200/80 bg-white shadow-lg ring-1 ring-pink-100 sm:max-w-[260px]"
				>
					<div class="relative aspect-11/10 overflow-hidden bg-slate-50">
						<img
							src="/images/text-outline-side-tab-keyring-feature.png"
							alt="Text Only keychain with a side-tab keyring on the left"
							class="size-full object-cover object-center"
							width="1024"
							height="933"
							loading="eager"
							decoding="async"
						/>
						<div
							class="pointer-events-none absolute inset-0 bg-linear-to-t from-pink-950/10 via-transparent to-white/15"
						></div>
						<div
							class="pointer-events-none absolute top-[42%] left-2 rounded-md border border-pink-300/90 bg-white/95 px-1.5 py-0.5 text-[9px] font-semibold text-pink-900 shadow-sm backdrop-blur-sm sm:left-3 sm:px-2 sm:text-[10px]"
						>
							Side tab
						</div>
					</div>
					<div class="space-y-0.5 border-t border-slate-100 bg-white/95 px-2.5 py-2 sm:px-3 sm:py-2.5">
						<p class="text-xs font-semibold text-slate-900 sm:text-sm">Side-tab keyring</p>
						<p class="text-[10px] leading-snug text-slate-500 sm:text-xs">
							Bridges into the base — ready for your keyring.
						</p>
					</div>
				</div>
			</div>

			<div
				class="flex flex-col justify-center gap-3 border-slate-100 px-4 py-4 sm:gap-3.5 sm:px-5 sm:py-5"
			>
				<Dialog.Header class="space-y-1.5 text-left">
					<Dialog.Title class="text-base font-bold tracking-tight text-slate-900 sm:text-lg">
						Side-tab keyring
					</Dialog.Title>
					<Dialog.Description class="text-xs leading-relaxed text-slate-600 sm:text-sm">
						A new keyring style for Text Only keychains: a left-center tab with a round hole,
						merged into the outline base. The original round corner ring is still available.
					</Dialog.Description>
				</Dialog.Header>

				<ul
					class="grid gap-1.5 rounded-xl border border-pink-100 bg-pink-50/60 p-2.5 sm:gap-2 sm:p-3"
				>
					{#each highlights as item (item.label)}
						<li class="flex items-start gap-2 text-[11px] text-slate-700 sm:text-xs">
							<span
								class="flex size-5 shrink-0 items-center justify-center rounded-full bg-white text-[10px] font-bold text-pink-700 ring-1 ring-pink-200 sm:size-6 sm:text-[11px]"
								aria-hidden="true">{item.icon}</span
							>
							<span class="pt-0.5 font-medium text-slate-800">{item.label}</span>
						</li>
					{/each}
				</ul>

				<p class="text-[10px] leading-snug text-slate-500 sm:text-[11px]">
					Open <span class="font-medium text-slate-700">Keyring → Style</span> and choose
					<span class="font-medium text-slate-700">Side tab (left center)</span>.
				</p>
			</div>
		</div>

		<Dialog.Footer
			class="shrink-0 gap-2 border-t border-slate-100 bg-slate-50/80 px-4 py-3 sm:justify-between sm:px-5 sm:py-4"
		>
			<Button type="button" variant="ghost" class="text-slate-600" onclick={dismiss}>Got it</Button>
			<Button type="button" onclick={handleTryIt}>Try side-tab keyring</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
