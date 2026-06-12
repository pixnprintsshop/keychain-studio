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
		{ icon: '🏀', label: 'Backboard tag with rim, net, and raised text' },
		{ icon: '🔢', label: 'Custom name or number — up to 12 characters' },
		{ icon: '🎨', label: 'Multi Pass or Layer Based multi-color printing' },
		{ icon: '⛓', label: 'Keyring tab left, center, or right — STL or 3MF export' }
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
				class="relative flex items-center justify-center overflow-hidden bg-linear-to-br from-orange-100 via-white to-slate-100 p-4 sm:p-5"
			>
				<div
					class="pointer-events-none absolute -top-8 -right-8 size-32 rounded-full bg-orange-200/50 blur-2xl"
				></div>
				<div
					class="pointer-events-none absolute -bottom-6 -left-6 size-28 rounded-full bg-slate-300/40 blur-2xl"
				></div>
				<span
					class="absolute top-3 left-3 z-10 rounded-full bg-orange-600 px-2 py-0.5 text-[9px] font-bold tracking-wide text-white uppercase sm:top-4 sm:left-4 sm:px-2.5 sm:text-[10px]"
				>
					New designer
				</span>
				<div
					class="relative w-full max-w-[240px] overflow-hidden rounded-2xl border border-orange-200/80 bg-white shadow-lg ring-1 ring-orange-100 sm:max-w-[260px]"
				>
					<div class="relative aspect-5/3 overflow-hidden bg-slate-900">
						<img
							src="/images/hoop-tag.png"
							alt="HoopTag basketball keychain preview — backboard with rim, net, and custom text"
							class="size-full object-cover object-center"
							width="1024"
							height="645"
							loading="eager"
							decoding="async"
						/>
						<div
							class="pointer-events-none absolute inset-0 bg-linear-to-t from-slate-950/25 via-transparent to-white/10"
						></div>
					</div>
					<div class="space-y-0.5 border-t border-slate-100 bg-white/95 px-2.5 py-2 sm:px-3 sm:py-2.5">
						<p class="text-xs font-semibold text-slate-900 sm:text-sm">HoopTag</p>
						<p class="text-[10px] leading-snug text-slate-500 sm:text-xs">
							Basketball keychain — colors, text, and keyring placement.
						</p>
					</div>
				</div>
			</div>

			<div
				class="flex flex-col justify-center gap-3 border-slate-100 px-4 py-4 sm:gap-3.5 sm:px-5 sm:py-5"
			>
				<Dialog.Header class="space-y-1.5 text-left">
					<Dialog.Title class="text-base font-bold tracking-tight text-slate-900 sm:text-lg">
						HoopTag keychain
					</Dialog.Title>
					<Dialog.Description class="text-xs leading-relaxed text-slate-600 sm:text-sm">
						Design a basketball hoop keychain with layered rim and net artwork, custom raised text,
						and a keyring tab tuned for the curved tag top.
					</Dialog.Description>
				</Dialog.Header>

				<ul
					class="grid gap-1.5 rounded-xl border border-orange-100 bg-orange-50/60 p-2.5 sm:gap-2 sm:p-3"
				>
					{#each highlights as item (item.label)}
						<li class="flex items-start gap-2 text-[11px] text-slate-700 sm:text-xs">
							<span
								class="flex size-5 shrink-0 items-center justify-center rounded-full bg-white text-[10px] ring-1 ring-orange-200 sm:size-6 sm:text-[11px]"
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
			<Button type="button" onclick={handleTryIt}>Try HoopTag</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
