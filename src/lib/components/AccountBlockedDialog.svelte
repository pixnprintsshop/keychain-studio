<script lang="ts">
	import { Button } from '$lib/components/ui/button';
	import * as Dialog from '$lib/components/ui/dialog';
	import type { UserBlockKind } from '$lib/userBlock.svelte';

	interface Props {
		open: boolean;
		blockKind?: UserBlockKind;
		reason?: string | null;
		onSignOut: () => void | Promise<void>;
	}

	let { open, blockKind = null, reason = null, onSignOut }: Props = $props();

	let signingOut = $state(false);

	const title = $derived.by(() => {
		if (blockKind === 'device_limit') return 'Device trial limit reached';
		if (blockKind === 'fingerprint') return 'Device restricted';
		return 'Account restricted';
	});

	const defaultMessage = $derived.by(() => {
		if (blockKind === 'device_limit') {
			return 'This device already has the maximum number of free trial accounts (2). Sign in with an account you have already used on this device, or subscribe for unlimited exports.';
		}
		if (blockKind === 'fingerprint') {
			return 'This device has been restricted from using PixnPrints free trials due to a violation of our terms of service.';
		}
		return 'This account has been restricted from using PixnPrints due to a violation of our terms of service, including creating multiple free trial accounts.';
	});

	async function handleSignOut() {
		signingOut = true;
		try {
			await onSignOut();
		} finally {
			signingOut = false;
		}
	}
</script>

<Dialog.Root
	{open}
	onOpenChange={() => {
		/* Non-dismissable — user must sign out or switch accounts. */
	}}
>
	<Dialog.Content showCloseButton={false} class="max-w-md rounded-2xl border-slate-200 shadow-xl">
		<Dialog.Header>
			<Dialog.Title class="text-lg font-semibold text-slate-900">{title}</Dialog.Title>
			<Dialog.Description class="mt-2 space-y-3 text-sm text-slate-600">
				<p>{defaultMessage}</p>
				{#if reason && reason !== defaultMessage}
					<p class="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-slate-700">
						{reason}
					</p>
				{/if}
				<p>
					If you believe this is a mistake, contact us at
					<a
						href="mailto:support@pixnprints.shop"
						class="font-medium text-indigo-600 hover:underline"
					>
						support@pixnprints.shop
					</a>.
				</p>
			</Dialog.Description>
		</Dialog.Header>
		<div class="mt-4 flex flex-col gap-2 sm:flex-row sm:justify-end">
			<Button class="w-full sm:w-auto" disabled={signingOut} onclick={handleSignOut}>
				{signingOut ? 'Signing out…' : 'Sign out'}
			</Button>
		</div>
	</Dialog.Content>
</Dialog.Root>
