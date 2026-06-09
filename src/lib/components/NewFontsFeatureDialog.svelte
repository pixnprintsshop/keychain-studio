<script lang="ts">
	import { Button } from '$lib/components/ui/button';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Input } from '$lib/components/ui/input';
	import { notifyFontRecommendation } from '$lib/fontRecommendationNotify';
	import { getNewFontOptions } from '$lib/newFonts';
	import type { SubscriptionStatus } from '$lib/subscription';

	interface Props {
		open: boolean;
		onOpenChange: (open: boolean) => void;
		onTryIt: () => void;
		subscriptionStatus?: SubscriptionStatus | null;
	}

	let {
		open,
		onOpenChange,
		onTryIt,
		subscriptionStatus = null
	}: Props = $props();

	const newFonts = getNewFontOptions();

	let fontRecommendation = $state('');
	let recommendationSending = $state(false);
	let recommendationSent = $state(false);
	let recommendationError = $state<string | null>(null);

	const canSendRecommendation = $derived(
		fontRecommendation.trim().length >= 2 && !recommendationSending && !recommendationSent
	);

	$effect(() => {
		if (!open) {
			fontRecommendation = '';
			recommendationSending = false;
			recommendationSent = false;
			recommendationError = null;
		}
	});

	function dismiss() {
		onOpenChange(false);
	}

	function handleTryIt() {
		onTryIt();
		onOpenChange(false);
	}

	async function submitRecommendation() {
		const value = fontRecommendation.trim();
		if (value.length < 2 || recommendationSending || recommendationSent) return;

		recommendationSending = true;
		recommendationError = null;

		const ok = await notifyFontRecommendation({
			recommendation: value,
			subscriptionStatus
		});

		recommendationSending = false;
		if (ok) {
			recommendationSent = true;
			fontRecommendation = '';
		} else {
			recommendationError = 'Could not send — try again in a moment.';
		}
	}
</script>

<Dialog.Root {open} {onOpenChange}>
	<Dialog.Content
		class="flex max-h-[min(90vh,600px)] max-w-2xl flex-col gap-0 overflow-hidden rounded-2xl border-slate-200 p-0 shadow-xl sm:max-w-2xl"
	>
		<div class="grid min-h-0 flex-1 grid-cols-2">
			<div
				class="relative flex min-h-0 flex-col overflow-hidden bg-linear-to-br from-indigo-100 via-white to-violet-50 p-3 sm:p-4"
			>
				<span
					class="absolute top-2.5 left-2.5 z-10 rounded-full bg-indigo-600 px-2 py-0.5 text-[9px] font-bold tracking-wide text-white uppercase sm:top-3 sm:left-3 sm:px-2.5 sm:text-[10px]"
				>
					New
				</span>
				<div
					class="mt-5 min-h-0 flex-1 overflow-y-auto rounded-xl border border-indigo-200/80 bg-white/90 p-2 shadow-md ring-1 ring-indigo-100 sm:mt-6"
				>
					<ul class="grid grid-cols-2 gap-1.5 sm:gap-2">
						{#each newFonts as font (font.key)}
							<li
								class="min-w-0 rounded-lg border border-slate-100 bg-white px-2 py-1.5 sm:px-2.5 sm:py-2"
							>
								<p
									class="truncate text-sm leading-none text-slate-900 sm:text-base"
									style="font-family: {font.fontFamily}"
								>
									Aa
								</p>
								<p class="mt-1 truncate text-[9px] leading-tight text-slate-500 sm:text-[10px]">
									{font.label.replace(' (Regular)', '')}
								</p>
							</li>
						{/each}
					</ul>
				</div>
			</div>

			<div
				class="flex min-h-0 flex-col gap-2.5 overflow-y-auto border-slate-100 px-3 py-3 sm:gap-3 sm:px-4 sm:py-4"
			>
				<Dialog.Header class="space-y-1 text-left">
					<Dialog.Title class="text-base font-bold tracking-tight text-slate-900 sm:text-lg">
						New fonts
					</Dialog.Title>
					<Dialog.Description class="text-xs leading-relaxed text-slate-600 sm:text-sm">
						{newFonts.length} new display fonts are ready in the font picker — from bold stencil styles
						to playful script and retro looks. Open any text designer and choose
						<span class="font-medium text-slate-700">Font</span> to try them.
					</Dialog.Description>
				</Dialog.Header>

				<div class="rounded-xl border border-slate-200 bg-white p-2.5 sm:p-3">
					<p class="text-[11px] font-medium text-slate-800 sm:text-xs">
						Have a font we should add?
					</p>
					<p class="mt-0.5 text-[10px] leading-snug text-slate-500 sm:text-[11px]">
						Send the font name or a Google Fonts link.
					</p>
					<form
						class="mt-2 flex flex-col gap-2"
						onsubmit={(e) => {
							e.preventDefault();
							void submitRecommendation();
						}}
					>
						<Input
							bind:value={fontRecommendation}
							placeholder="e.g. Poppins or fonts.google.com/…"
							maxlength={500}
							disabled={recommendationSending || recommendationSent}
							class="h-8 text-xs sm:text-sm"
							aria-label="Recommended font name or link"
						/>
						{#if recommendationSent}
							<p class="text-[10px] font-medium text-emerald-600 sm:text-[11px]">
								Thanks — we got your suggestion.
							</p>
						{:else if recommendationError}
							<p class="text-[10px] text-rose-600 sm:text-[11px]">{recommendationError}</p>
						{/if}
						<Button
							type="submit"
							variant="outline"
							size="sm"
							class="h-8 w-full text-xs"
							disabled={!canSendRecommendation}
						>
							{#if recommendationSending}
								Sending…
							{:else}
								Send suggestion
							{/if}
						</Button>
					</form>
				</div>
			</div>
		</div>

		<Dialog.Footer
			class="shrink-0 gap-2 border-t border-slate-100 bg-slate-50/80 px-4 py-3 sm:justify-between sm:px-5 sm:py-3"
		>
			<Button type="button" variant="ghost" class="text-slate-600" onclick={dismiss}>Got it</Button>
			<Button type="button" onclick={handleTryIt}>Try it</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
