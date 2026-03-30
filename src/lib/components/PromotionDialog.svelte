<script lang="ts">
	import { Button } from '$lib/components/ui/button';

	interface Props {
		open: boolean;
		onClose: () => void;
		onClaim: () => void | Promise<void>;
	}

	let { open, onClose, onClaim }: Props = $props();
	const PROMO_CODE = 'IWNZC1MW';
	let copyFeedback = $state<'success' | 'failure' | null>(null);

	function handleOverlayKeydown(event: KeyboardEvent) {
		if (event.key === 'Escape') onClose();
	}

	async function handleCopyCode() {
		try {
			if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
				await navigator.clipboard.writeText(PROMO_CODE);
				copyFeedback = 'success';
				return;
			}

			if (typeof document === 'undefined') {
				copyFeedback = 'failure';
				return;
			}

			const textarea = document.createElement('textarea');
			textarea.value = PROMO_CODE;
			textarea.setAttribute('readonly', '');
			textarea.style.position = 'fixed';
			textarea.style.opacity = '0';
			document.body.appendChild(textarea);
			textarea.select();

			const copied = document.execCommand('copy');
			document.body.removeChild(textarea);
			copyFeedback = copied ? 'success' : 'failure';
		} catch {
			copyFeedback = 'failure';
		}
	}
</script>

{#if open}
	<div
		class="fixed inset-0 z-60 flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm"
		onclick={onClose}
		onkeydown={handleOverlayKeydown}
		role="dialog"
		aria-modal="true"
		aria-labelledby="promotion-dialog-title"
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
						class="flex h-12 w-12 items-center justify-center rounded-full bg-emerald-100 text-emerald-700"
					>
						<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24"
							><!-- Icon from Tabler Icons by Paweł Kuna - https://github.com/tabler/tabler-icons/blob/master/LICENSE --><g
								fill="none"
								stroke="currentColor"
								stroke-linecap="round"
								stroke-linejoin="round"
								stroke-width="2"
								><path d="m9 15l6-6" /><circle
									cx="9.5"
									cy="9.5"
									r=".5"
									fill="currentColor"
								/><circle cx="14.5" cy="14.5" r=".5" fill="currentColor" /><path
									d="M5 7.2A2.2 2.2 0 0 1 7.2 5h1a2.2 2.2 0 0 0 1.55-.64l.7-.7a2.2 2.2 0 0 1 3.12 0l.7.7a2.2 2.2 0 0 0 1.55.64h1a2.2 2.2 0 0 1 2.2 2.2v1a2.2 2.2 0 0 0 .64 1.55l.7.7a2.2 2.2 0 0 1 0 3.12l-.7.7a2.2 2.2 0 0 0-.64 1.55v1a2.2 2.2 0 0 1-2.2 2.2h-1a2.2 2.2 0 0 0-1.55.64l-.7.7a2.2 2.2 0 0 1-3.12 0l-.7-.7a2.2 2.2 0 0 0-1.55-.64h-1a2.2 2.2 0 0 1-2.2-2.2v-1a2.2 2.2 0 0 0-.64-1.55l-.7-.7a2.2 2.2 0 0 1 0-3.12l.7-.7A2.2 2.2 0 0 0 5 8.2z"
								/></g
							></svg
						>
					</div>
				</div>
				<h2 id="promotion-dialog-title" class="text-center text-xl font-bold text-slate-900">
					Special subscription offer
				</h2>
				<p class="mt-3 text-center text-sm leading-relaxed text-slate-600">
					Unlock premium access with <span class="font-semibold">20% on subscription forever</span>.
				</p>
				<div class="mt-4 rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-center">
					<p class="text-xs font-semibold tracking-wide text-emerald-800 uppercase">
						Limited offer only
					</p>
					<div class="mt-2 flex items-center justify-center gap-2 text-sm text-emerald-900">
						<p>
							Code: <span class="font-mono font-semibold">{PROMO_CODE}</span>
						</p>
						<Button onclick={handleCopyCode} variant="ghost" size="icon">
							<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24"
								><!-- Icon from Tabler Icons by Paweł Kuna - https://github.com/tabler/tabler-icons/blob/master/LICENSE --><g
									fill="none"
									stroke="currentColor"
									stroke-linecap="round"
									stroke-linejoin="round"
									stroke-width="2"
									><path
										d="M7 9.667A2.667 2.667 0 0 1 9.667 7h8.666A2.667 2.667 0 0 1 21 9.667v8.666A2.667 2.667 0 0 1 18.333 21H9.667A2.667 2.667 0 0 1 7 18.333z"
									/><path
										d="M4.012 16.737A2 2 0 0 1 3 15V5c0-1.1.9-2 2-2h10c.75 0 1.158.385 1.5 1"
									/></g
								></svg
							>
						</Button>
					</div>
					{#if copyFeedback}
						<p class="mt-2 text-xs text-emerald-800">
							{copyFeedback === 'success' ? 'Copied!' : 'Could not copy'}
						</p>
					{/if}
				</div>
				<div class="mt-6 space-y-3">
					<Button class="w-full" onclick={onClaim}>Grab 20% offer</Button>
					<div class="flex justify-center">
						<Button onclick={onClose} variant="outline">Close</Button>
					</div>
				</div>
			</div>
		</div>
	</div>
{/if}
