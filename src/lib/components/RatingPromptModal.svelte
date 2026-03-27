<script lang="ts">
	import type { User } from '@supabase/supabase-js';
	import { Button } from '$lib/components/ui/button';
	import { submitAppRating } from '$lib/app-rating';
	import posthog from 'posthog-js';

	interface Props {
		open: boolean;
		user: User | null;
		onDismiss: () => void;
		onSubmitted: () => void;
	}

	let { open, user, onDismiss, onSubmitted }: Props = $props();

	const reviewUrl = String(import.meta.env.PUBLIC_APP_REVIEW_URL ?? '').trim();

	let stars = $state(0);
	let hoverStar = $state(0);
	let comment = $state('');
	let submitting = $state(false);
	let submitError: string | null = $state(null);
	let phase = $state<'form' | 'thanks'>('form');

	const displayStar = $derived(hoverStar || stars);

	$effect(() => {
		if (open) {
			phase = 'form';
			stars = 0;
			hoverStar = 0;
			comment = '';
			submitting = false;
			submitError = null;
		}
	});

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape') onDismiss();
	}

	async function handleSubmit(e: SubmitEvent) {
		e.preventDefault();
		if (!user) {
			submitError = 'You must be signed in to submit a rating.';
			return;
		}
		if (stars < 1 || stars > 5) {
			submitError = 'Please tap the stars to choose a rating.';
			return;
		}
		submitting = true;
		submitError = null;
		const result = await submitAppRating({
			user,
			stars,
			comment
		});
		submitting = false;
		if (!result.success) {
			submitError = result.error;
			return;
		}
		posthog.capture('rating_submitted', { stars });
		phase = 'thanks';
	}

	function handleThanksClose() {
		onSubmitted();
	}
</script>

{#if open}
	<div
		class="fixed inset-0 z-60 flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm"
		onclick={onDismiss}
		onkeydown={handleKeydown}
		role="dialog"
		aria-modal="true"
		aria-labelledby="rating-prompt-title"
		tabindex="-1"
	>
		<!-- svelte-ignore a11y_click_events_have_key_events -->
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div
			class="relative w-full max-w-md rounded-2xl border border-slate-200 bg-white shadow-xl"
			onclick={(e) => e.stopPropagation()}
		>
			<div class="p-6">
				{#if phase === 'form'}
					<div class="mb-4 flex justify-center" aria-hidden="true">
						<div
							class="flex h-14 w-14 items-center justify-center rounded-full bg-amber-100 text-amber-600"
						>
							<svg class="h-8 w-8" fill="currentColor" viewBox="0 0 24 24">
								<path
									d="M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z"
								/>
							</svg>
						</div>
					</div>
				{/if}
				<h2 id="rating-prompt-title" class="text-center text-xl font-bold text-slate-900">
					{#if phase === 'form'}
						How’s Print Studio?
					{:else}
						Thank you!
					{/if}
				</h2>
				{#if phase === 'form'}
					<p class="mt-3 text-center text-sm leading-relaxed text-slate-600">
						Tap a star rating, optionally add a short note.
					</p>

					<form class="mt-6 space-y-4" onsubmit={handleSubmit}>
						<div class="flex flex-col items-center gap-2">
							<span class="text-xs font-medium text-slate-600" id="rating-stars-label"
								>Your rating</span
							>
							<div
								class="flex gap-1"
								role="group"
								aria-labelledby="rating-stars-label"
								onmouseleave={() => (hoverStar = 0)}
							>
								{#each [1, 2, 3, 4, 5] as n (n)}
									<button
										type="button"
										class="rounded cursor-pointer p-0.5 transition hover:scale-110 focus:ring-2 focus:ring-indigo-400 focus:ring-offset-2 focus:outline-none {n <= displayStar
											? 'text-amber-500'
											: 'text-slate-300'}"
										aria-label={`Rate ${n} out of 5 stars`}
										onmouseenter={() => (hoverStar = n)}
										onclick={() => {
											stars = n;
										}}
									>
										<svg class="h-9 w-9" viewBox="0 0 24 24" aria-hidden="true">
											<path
												fill="currentColor"
												d="M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z"
											/>
										</svg>
									</button>
								{/each}
							</div>
						</div>

						<label class="grid gap-1.5">
							<div class="flex items-center justify-between gap-2">
								<span class="text-xs font-medium text-slate-700">Comment (optional)</span>
								<span class="text-[10px] text-slate-400">{comment.length}/2000</span>
							</div>
							<textarea
								class="min-h-[88px] min-w-0 resize-y rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-slate-900 shadow-sm ring-indigo-500/25 outline-none focus:border-indigo-400 focus:ring-2"
								maxlength="2000"
								rows="3"
								bind:value={comment}
								placeholder="What would make it even better?"
							></textarea>
						</label>

						{#if submitError}
							<p class="text-[11px] text-red-600">{submitError}</p>
						{/if}

						<div class="flex flex-col gap-2 sm:flex-row sm:justify-end">
							<Button type="button" variant="outline" class="w-full sm:w-auto" onclick={onDismiss}>
								Maybe later
							</Button>
							<Button
								type="submit"
								class="w-full sm:w-auto"
								disabled={submitting || stars < 1 || !user}
							>
								{#if submitting}
									Sending…
								{:else}
									Submit rating
								{/if}
							</Button>
						</div>
					</form>
				{:else}
					<p class="mt-3 text-center text-sm text-slate-600">
						We appreciate you taking the time to rate Print Studio.
					</p>
					{#if reviewUrl}
						<p class="mt-4 text-center text-xs text-slate-500">
							<a
								href={reviewUrl}
								target="_blank"
								rel="noopener noreferrer"
								class="font-medium text-indigo-600 underline hover:text-indigo-800"
							>
								Leave a public review
							</a>
						</p>
					{/if}
					<div class="mt-6 flex justify-center">
						<Button onclick={handleThanksClose}>Close</Button>
					</div>
				{/if}
			</div>
		</div>
	</div>
{/if}
