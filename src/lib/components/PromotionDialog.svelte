<script lang="ts">
	import { Button } from '$lib/components/ui/button';

	interface Props {
		open: boolean;
		remainingCredits?: number;
		totalCredits?: number;
		bonusCredits?: number;
		onClose: () => void;
		onShare: () => void | Promise<void>;
		onMessageUs: () => void;
	}

	let {
		open,
		remainingCredits = 0,
		totalCredits = 10,
		bonusCredits = 20,
		onClose,
		onShare,
		onMessageUs
	}: Props = $props();

	const messengerUrl = 'https://m.me/pixnprints.shop';

	const headline = $derived(
		remainingCredits <= 0
			? 'Out of free download credits'
			: remainingCredits <= 2
				? 'Running low on download credits'
				: 'Earn more free downloads'
	);

	function handleOverlayKeydown(event: KeyboardEvent) {
		if (event.key === 'Escape') onClose();
	}
</script>

{#if open}
	<div
		class="fixed inset-0 z-60 flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm"
		onclick={onClose}
		onkeydown={handleOverlayKeydown}
		role="dialog"
		aria-modal="true"
		aria-labelledby="share-credits-promo-title"
		tabindex="-1"
	>
		<!-- svelte-ignore a11y_click_events_have_key_events -->
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div
			class="relative w-full max-w-md rounded-2xl border border-slate-200 bg-white shadow-xl"
			onclick={(event) => event.stopPropagation()}
		>
			<div class="p-6">
				<div class="mb-4 flex justify-center" aria-hidden="true">
					<div
						class="flex h-12 w-12 items-center justify-center rounded-full bg-amber-100 text-amber-700"
					>
						<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 24 24"
							><g
								fill="none"
								stroke="currentColor"
								stroke-linecap="round"
								stroke-linejoin="round"
								stroke-width="2"
								><path
									d="M12 3v12m0 0l4-4m-4 4l-4-4M5 21h14"
								/></g
							></svg
						>
					</div>
				</div>
				<h2 id="share-credits-promo-title" class="text-center text-xl font-bold text-slate-900">
					{headline}
				</h2>
				<p class="mt-3 text-center text-sm leading-relaxed text-slate-600">
					{#if remainingCredits <= 0}
						You've used your {totalCredits} free trial download{totalCredits === 1 ? '' : 's'}.
					{:else}
						You have <span class="font-semibold text-slate-800">{remainingCredits}</span> of
						{totalCredits} free download{totalCredits === 1 ? '' : 's'} left.
					{/if}
					Share something you made, mention <span class="font-semibold">PixnPrints</span>, and we'll add
					<span class="font-semibold text-emerald-700">{bonusCredits} more download credits</span> to your
					account.
				</p>
				<div class="mt-4 rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-900">
					<p class="font-semibold">How it works</p>
					<ol class="mt-2 list-decimal space-y-1.5 pl-4 text-emerald-800">
						<li>Post your print or design on social media or a group.</li>
						<li>Tag or mention PixnPrints so others can find the app.</li>
						<li>Send us a link or screenshot — we add {bonusCredits} credits within a day.</li>
					</ol>
				</div>
				<div class="mt-6 space-y-3">
					<Button class="w-full" onclick={onShare}>Share my work</Button>
					<Button class="w-full" variant="secondary" onclick={onMessageUs}>
						Message us with your post
					</Button>
					<div class="flex justify-center">
						<Button onclick={onClose} variant="outline">Maybe later</Button>
					</div>
					<p class="text-center text-[11px] text-slate-500">
						<a
							href={messengerUrl}
							target="_blank"
							rel="noopener noreferrer"
							class="underline hover:text-slate-700">{messengerUrl.replace('https://', '')}</a
						>
					</p>
				</div>
			</div>
		</div>
	</div>
{/if}
