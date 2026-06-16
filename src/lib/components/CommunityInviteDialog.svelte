<script lang="ts">
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { COMMUNITY_JOIN_BONUS_CREDITS, MESSENGER_COMMUNITY_URL } from '$lib/messengerCommunity';

	interface Props {
		open: boolean;
		isSignedIn?: boolean;
		claiming?: boolean;
		claimed?: boolean;
		claimError?: string | null;
		onClose: () => void;
		onOpenMessenger: () => void;
		onClaim: (code: string) => void | Promise<void>;
		onSignIn: () => void;
	}

	let {
		open,
		isSignedIn = false,
		claiming = false,
		claimed = false,
		claimError = null,
		onClose,
		onOpenMessenger,
		onClaim,
		onSignIn
	}: Props = $props();

	let claimCode = $state('');

	$effect(() => {
		if (!open) claimCode = '';
	});

	function handleOverlayKeydown(event: KeyboardEvent) {
		if (event.key === 'Escape' && !claiming) onClose();
	}

	function handleClaim() {
		void onClaim(claimCode);
	}

	function handleClaimKeydown(event: KeyboardEvent) {
		if (event.key === 'Enter' && !claiming) {
			event.preventDefault();
			handleClaim();
		}
	}
</script>

{#if open}
	<div
		class="fixed inset-0 z-60 flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm"
		onclick={() => {
			if (!claiming) onClose();
		}}
		onkeydown={handleOverlayKeydown}
		role="dialog"
		aria-modal="true"
		aria-labelledby="community-invite-title"
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
						class="flex h-12 w-12 items-center justify-center rounded-full bg-sky-100 text-sky-700"
					>
						<svg xmlns="http://www.w3.org/2000/svg" class="size-7" viewBox="0 0 24 24" fill="currentColor">
							<path
								d="M12 2C6.48 2 2 6.13 2 11.06c0 2.86 1.44 5.41 3.7 7.09L5 22l3.79-1.98c1.08.3 2.22.46 3.41.46 5.52 0 10-4.13 10-9.06S17.52 2 12 2zm.55 11.96l-2.6-2.77-5.05 2.77L10.4 8.5l2.67 2.77 4.98-2.72-5.5 5.41z"
							/>
						</svg>
					</div>
				</div>
				<h2 id="community-invite-title" class="text-center text-xl font-bold text-slate-900">
					{#if claimed}
						Credits added!
					{:else}
						Join our community
					{/if}
				</h2>
				<p class="mt-3 text-center text-sm leading-relaxed text-slate-600">
					{#if claimed}
						<span class="font-semibold text-emerald-700">{COMMUNITY_JOIN_BONUS_CREDITS} download credits</span>
						were added to your account. See you in the group!
					{:else if isSignedIn}
						Join the official Print Studio Messenger group, copy the pinned claim code, and enter it
						below to get
						<span class="font-semibold text-emerald-700">{COMMUNITY_JOIN_BONUS_CREDITS} free download credits</span>.
					{:else}
						Sign in, join our Messenger community, and redeem the pinned code for
						<span class="font-semibold text-emerald-700">{COMMUNITY_JOIN_BONUS_CREDITS} free download credits</span>.
					{/if}
				</p>
				{#if !claimed}
					<div class="mt-4 rounded-xl border border-sky-200 bg-sky-50 p-4 text-sm text-sky-900">
						<p class="font-semibold">How it works</p>
						<ol class="mt-2 list-decimal space-y-1.5 pl-4 text-sky-800">
							{#if !isSignedIn}
								<li>Sign in to your Print Studio account.</li>
							{/if}
							<li>Open our Messenger group and join.</li>
							<li>Copy the claim code from the pinned message.</li>
							<li>Paste the code here to receive {COMMUNITY_JOIN_BONUS_CREDITS} credits.</li>
						</ol>
					</div>
				{/if}
				{#if !claimed && isSignedIn}
					<div class="mt-4 space-y-2">
						<label for="community-claim-code" class="text-sm font-medium text-slate-700">
							Claim code
						</label>
						<Input
							id="community-claim-code"
							type="text"
							autocomplete="off"
							spellcheck={false}
							placeholder="Paste code from Messenger"
							bind:value={claimCode}
							disabled={claiming}
							onkeydown={handleClaimKeydown}
							class="font-mono uppercase tracking-wide"
						/>
					</div>
				{/if}
				{#if claimError}
					<p class="mt-3 text-center text-sm text-red-600" role="alert">{claimError}</p>
				{/if}
				<div class="mt-6 space-y-3">
					{#if claimed}
						<Button class="w-full" onclick={onClose}>Done</Button>
					{:else if isSignedIn}
						<Button class="w-full" disabled={claiming} onclick={handleClaim}>
							{claiming ? 'Claiming credits…' : `Claim ${COMMUNITY_JOIN_BONUS_CREDITS} credits`}
						</Button>
						<Button
							class="w-full"
							variant="secondary"
							disabled={claiming}
							onclick={onOpenMessenger}
						>
							Open Messenger group
						</Button>
						<div class="flex justify-center">
							<Button onclick={onClose} variant="outline" disabled={claiming}>Maybe later</Button>
						</div>
					{:else}
						<Button class="w-full" onclick={onSignIn}>Sign in to claim credits</Button>
						<Button
							class="w-full"
							variant="secondary"
							href={MESSENGER_COMMUNITY_URL}
							target="_blank"
							rel="noopener noreferrer"
						>
							Open Messenger group
						</Button>
						<div class="flex justify-center">
							<Button onclick={onClose} variant="outline">Maybe later</Button>
						</div>
					{/if}
				</div>
			</div>
		</div>
	</div>
{/if}
