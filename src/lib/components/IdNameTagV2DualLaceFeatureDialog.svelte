<script lang="ts">
	import { Button } from '$lib/components/ui/button';
	import * as Dialog from '$lib/components/ui/dialog';

	interface Props {
		open: boolean;
		onOpenChange: (open: boolean) => void;
		onTryIt: () => void;
	}

	let { open, onOpenChange, onTryIt }: Props = $props();

	const heroSrc = '/images/idnametag-v2-dual-lace-feature.jpg';

	const styles = [
		{
			id: 'single',
			label: 'Single',
			detail: 'One center loop'
		},
		{
			id: 'dual',
			label: 'Dual',
			detail: 'Left and right loops'
		}
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
				class="relative flex items-center justify-center overflow-hidden bg-linear-to-br from-fuchsia-100 via-white to-rose-50 p-4 sm:p-5"
			>
				<span
					class="absolute top-3 left-3 z-10 rounded-full bg-fuchsia-600 px-2 py-0.5 text-[9px] font-bold tracking-wide text-white uppercase sm:top-4 sm:left-4 sm:px-2.5 sm:text-[10px]"
				>
					New
				</span>
				<div
					class="w-full max-w-[220px] overflow-hidden rounded-xl border border-fuchsia-200/80 bg-white shadow-md ring-1 ring-fuchsia-100 sm:max-w-[240px] sm:rounded-2xl"
				>
					<div class="relative aspect-4/3 overflow-hidden bg-white">
						<img
							src={heroSrc}
							alt="ID Name Tag v2 preview with dual lace holders on the left and right of the top edge"
							class="block h-full w-full object-cover object-top"
							width="1024"
							height="718"
							loading="eager"
							decoding="async"
						/>
						<div
							class="pointer-events-none absolute inset-0 bg-linear-to-t from-fuchsia-950/10 via-transparent to-transparent"
						></div>
						<div
							class="pointer-events-none absolute top-[6%] left-[10%] rounded-md border border-fuchsia-300/90 bg-white/95 px-1.5 py-0.5 text-[9px] font-semibold text-fuchsia-900 shadow-sm backdrop-blur-sm sm:text-[10px]"
						>
							Left loop
						</div>
						<div
							class="pointer-events-none absolute top-[6%] right-[10%] rounded-md border border-fuchsia-300/90 bg-white/95 px-1.5 py-0.5 text-[9px] font-semibold text-fuchsia-900 shadow-sm backdrop-blur-sm sm:text-[10px]"
						>
							Right loop
						</div>
					</div>
					<div class="space-y-0.5 border-t border-slate-100 p-2 sm:p-2.5">
						<p class="text-xs font-semibold text-slate-900 sm:text-sm">Dual lace base</p>
						<p class="text-[10px] leading-snug text-slate-500 sm:text-xs">
							Same border and text on every shape.
						</p>
					</div>
				</div>
			</div>

			<div
				class="flex flex-col justify-center gap-3 border-slate-100 px-4 py-4 sm:gap-3.5 sm:px-5 sm:py-5"
			>
				<Dialog.Header class="space-y-1.5 text-left">
					<Dialog.Title class="text-base font-bold tracking-tight text-slate-900 sm:text-lg">
						Dual lace holders
					</Dialog.Title>
					<Dialog.Description class="text-xs leading-relaxed text-slate-600 sm:text-sm">
						Every tag shape now has a second base: swap from a single center loop to matching left
						and right loops. Only the base STL changes.
					</Dialog.Description>
				</Dialog.Header>

				<ul class="grid gap-1.5 rounded-xl border border-fuchsia-100 bg-fuchsia-50/60 p-2.5 sm:gap-2 sm:p-3">
					{#each styles as style (style.id)}
						<li class="flex items-center gap-2 text-[11px] text-slate-700 sm:text-xs">
							<span
								class={`flex size-5 shrink-0 items-center justify-center rounded-full text-[10px] font-bold ring-1 ring-black/10 sm:size-6 sm:text-[11px] ${
									style.id === 'dual'
										? 'bg-fuchsia-600 text-white'
										: 'bg-white text-fuchsia-700'
								}`}
							>
								{style.id === 'dual' ? '2' : '1'}
							</span>
							<span>
								<span class="font-medium text-slate-800">{style.label}</span>
								<span class="text-slate-500"> — {style.detail}</span>
							</span>
						</li>
					{/each}
				</ul>

				<p class="text-[10px] leading-snug text-slate-500 sm:text-[11px]">
					Under <span class="font-medium text-slate-700">Model</span>, choose
					<span class="font-medium text-slate-700">Dual</span> in Lace holder.
				</p>
			</div>
		</div>

		<Dialog.Footer
			class="shrink-0 gap-2 border-t border-slate-100 bg-slate-50/80 px-4 py-3 sm:justify-between sm:px-5 sm:py-4"
		>
			<Button type="button" variant="ghost" class="text-slate-600" onclick={dismiss}>Got it</Button>
			<Button type="button" onclick={handleTryIt}>Try dual lace</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
