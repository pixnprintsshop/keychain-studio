<script lang="ts">
	import { Button } from '$lib/components/ui/button';
	import * as Dialog from '$lib/components/ui/dialog';

	interface Props {
		open: boolean;
		onOpenChange: (open: boolean) => void;
		onTryIt: () => void;
	}

	let { open, onOpenChange, onTryIt }: Props = $props();

	const heroSrc = '/images/textonly-rim-feature.png';

	const layers = [
		{ swatch: 'bg-violet-700', label: 'Text + border rim', detail: 'Top layer' },
		{ swatch: 'bg-violet-300', label: 'Text outline + matching rim', detail: 'Middle layer' },
		{ swatch: 'bg-violet-200', label: 'Base outline', detail: 'Foundation' }
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
	<Dialog.Content class="max-h-[min(92dvh,880px)] max-w-lg gap-0 overflow-hidden rounded-2xl border-slate-200 p-0 shadow-xl">
		<div class="relative overflow-hidden bg-linear-to-br from-violet-100 via-white to-indigo-50 px-5 pt-5 pb-4">
			<span
				class="absolute top-4 left-4 z-10 rounded-full bg-indigo-600 px-2.5 py-0.5 text-[10px] font-bold tracking-wide text-white uppercase"
			>
				New
			</span>
			<div
				class="relative mx-auto mt-1 max-w-[340px] overflow-hidden rounded-2xl border border-violet-200/80 bg-white shadow-md ring-1 ring-violet-100"
			>
				<img
					src={heroSrc}
					alt="Text Only keychain preview showing inset border rims on the text and text-outline layers"
					class="block h-auto w-full bg-white object-cover"
					width="680"
					height="520"
					loading="eager"
					decoding="async"
				/>
				<div class="pointer-events-none absolute inset-0 bg-linear-to-t from-violet-950/10 via-transparent to-transparent"></div>
				<div
					class="pointer-events-none absolute top-[18%] right-3 rounded-lg border border-violet-300/80 bg-white/95 px-2 py-1 text-[10px] font-semibold text-violet-900 shadow-sm backdrop-blur-sm"
				>
					Text + rim
				</div>
				<div
					class="pointer-events-none absolute top-[42%] left-3 rounded-lg border border-violet-200 bg-white/95 px-2 py-1 text-[10px] font-semibold text-violet-800 shadow-sm backdrop-blur-sm"
				>
					Outline + rim
				</div>
				<div
					class="pointer-events-none absolute bottom-[14%] right-4 rounded-lg border border-violet-200 bg-white/95 px-2 py-1 text-[10px] font-semibold text-violet-700 shadow-sm backdrop-blur-sm"
				>
					Base
				</div>
			</div>
		</div>

		<div class="space-y-4 px-5 py-4">
			<Dialog.Header class="space-y-2 text-left">
				<Dialog.Title class="text-xl font-bold tracking-tight text-slate-900">
					Inset border rim
				</Dialog.Title>
				<Dialog.Description class="text-sm leading-relaxed text-slate-600">
					Add a colored inset frame around your base outline. Turn on <span class="font-medium text-slate-800"
						>Text outline</span
					> too and get a matching rim on that middle layer — each part exports as its own color for
					multicolor prints.
				</Dialog.Description>
			</Dialog.Header>

			<ul class="grid gap-2 rounded-xl border border-violet-100 bg-violet-50/60 p-3">
				{#each layers as layer (layer.label)}
					<li class="flex items-center gap-2.5 text-xs text-slate-700">
						<span class={`h-3 w-3 shrink-0 rounded-sm ring-1 ring-black/10 ${layer.swatch}`}></span>
						<span class="font-medium text-slate-800">{layer.label}</span>
						<span class="ml-auto text-slate-500">{layer.detail}</span>
					</li>
				{/each}
			</ul>

			<p class="text-[11px] leading-snug text-slate-500">
				Find controls under <span class="font-medium text-slate-700">Border</span> and
				<span class="font-medium text-slate-700">Text outline</span> in the object settings panel.
			</p>
		</div>

		<Dialog.Footer class="gap-2 border-t border-slate-100 bg-slate-50/80 px-5 py-4 sm:justify-between">
			<Button type="button" variant="ghost" class="text-slate-600" onclick={dismiss}>Got it</Button>
			<Button type="button" onclick={handleTryIt}>Try border rim</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
