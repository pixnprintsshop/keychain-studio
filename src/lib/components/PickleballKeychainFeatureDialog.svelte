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
		{ icon: '🎾', label: 'Paddle + ball silhouette with decor rim' },
		{ icon: '✿', label: '60+ center icons — flowers, sports, emoji & more' },
		{ icon: '🎨', label: 'Separate base and decor colors for multi-material' },
		{ icon: '⛓', label: 'Built-in keyring tab — export STL or 3MF' }
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
				class="relative flex items-center justify-center overflow-hidden bg-linear-to-br from-pink-100 via-white to-lime-50 p-4 sm:p-5"
			>
				<div
					class="pointer-events-none absolute -top-8 -right-8 size-32 rounded-full bg-pink-200/40 blur-2xl"
				></div>
				<div
					class="pointer-events-none absolute -bottom-6 -left-6 size-28 rounded-full bg-lime-200/50 blur-2xl"
				></div>
				<span
					class="absolute top-3 left-3 z-10 rounded-full bg-pink-600 px-2 py-0.5 text-[9px] font-bold tracking-wide text-white uppercase sm:top-4 sm:left-4 sm:px-2.5 sm:text-[10px]"
				>
					New designer
				</span>
				<div
					class="relative w-full max-w-[240px] overflow-hidden rounded-2xl border border-pink-200/80 bg-white shadow-lg ring-1 ring-pink-100 sm:max-w-[260px]"
				>
					<div class="relative aspect-5/3 overflow-hidden bg-slate-50">
						<img
							src="/images/pickleball-keychain-feature-dialog.png"
							alt="Pickleball keychain preview — paddle with flower icon and ball detail"
							class="size-full object-cover object-center"
							width="1024"
							height="645"
							loading="eager"
							decoding="async"
						/>
						<div
							class="pointer-events-none absolute inset-0 bg-linear-to-t from-pink-950/10 via-transparent to-white/20"
						></div>
					</div>
					<div class="space-y-0.5 border-t border-slate-100 bg-white/95 px-2.5 py-2 sm:px-3 sm:py-2.5">
						<p class="text-xs font-semibold text-slate-900 sm:text-sm">Pickleball keychain</p>
						<p class="text-[10px] leading-snug text-slate-500 sm:text-xs">
							Custom icon, colors, and scale — ready to print.
						</p>
					</div>
				</div>
			</div>

			<div
				class="flex flex-col justify-center gap-3 border-slate-100 px-4 py-4 sm:gap-3.5 sm:px-5 sm:py-5"
			>
				<Dialog.Header class="space-y-1.5 text-left">
					<Dialog.Title class="text-base font-bold tracking-tight text-slate-900 sm:text-lg">
						Pickleball keychain
					</Dialog.Title>
					<Dialog.Description class="text-xs leading-relaxed text-slate-600 sm:text-sm">
						Design a paddle-and-ball keychain with a raised center icon, two-color layers, and an
						optional keyring tab. Perfect for gifts, bag tags, and team swag.
					</Dialog.Description>
				</Dialog.Header>

				<ul
					class="grid gap-1.5 rounded-xl border border-pink-100 bg-pink-50/60 p-2.5 sm:gap-2 sm:p-3"
				>
					{#each highlights as item (item.label)}
						<li class="flex items-start gap-2 text-[11px] text-slate-700 sm:text-xs">
							<span
								class="flex size-5 shrink-0 items-center justify-center rounded-full bg-white text-[10px] ring-1 ring-pink-200 sm:size-6 sm:text-[11px]"
								aria-hidden="true">{item.icon}</span
							>
							<span class="pt-0.5 font-medium text-slate-800">{item.label}</span>
						</li>
					{/each}
				</ul>
			</div>
		</div>

		<Dialog.Footer
			class="shrink-0 gap-2 border-t border-slate-100 bg-slate-50/80 px-4 py-3 sm:justify-between sm:px-5 sm:py-4"
		>
			<Button type="button" variant="ghost" class="text-slate-600" onclick={dismiss}>Got it</Button>
			<Button type="button" onclick={handleTryIt}>Try Pickleball keychain</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
