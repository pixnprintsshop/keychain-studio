<script lang="ts">
	import { getSession } from '$lib/auth';
	import { Button } from '$lib/components/ui/button';
	import * as Dialog from '$lib/components/ui/dialog';

	interface Props {
		isOpen?: boolean;
		onClose?: () => void;
		onSuccess?: () => void;
	}

	let { isOpen = $bindable(false), onClose, onSuccess }: Props = $props();

	let licenseKey = $state('');
	let isLoading = $state(false);
	let errorMessage = $state('');

	function resetForm() {
		licenseKey = '';
		errorMessage = '';
	}

	function handleClose() {
		resetForm();
		isOpen = false;
		onClose?.();
	}

	function onOpenChange(open: boolean) {
		if (!open) {
			resetForm();
			onClose?.();
		}
	}

	async function handleActivate() {
		errorMessage = '';
		const key = licenseKey.trim();
		if (!key) {
			errorMessage = 'Please enter your license key';
			return;
		}

		const session = await getSession();
		if (!session?.access_token) {
			errorMessage = 'Please sign in to activate a license';
			return;
		}

		isLoading = true;
		try {
			const res = await fetch('/api/license/activate', {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					Authorization: `Bearer ${session.access_token}`
				},
				body: JSON.stringify({ licenseKey: key })
			});
			const data = (await res.json()) as { success?: boolean; error?: string };
			if (data.success) {
				isOpen = false;
				onSuccess?.();
			} else {
				errorMessage = data.error ?? 'Failed to activate license';
			}
		} catch (err) {
			console.error('License activation error:', err);
			errorMessage = 'Failed to activate license. Please try again.';
		} finally {
			isLoading = false;
		}
	}

	$effect(() => {
		if (!isOpen) {
			resetForm();
		}
	});
</script>

<Dialog.Root bind:open={isOpen} onOpenChange={onOpenChange}>
	<Dialog.Content showCloseButton={false} class="max-w-md rounded-2xl border-slate-200 shadow-xl p-0">
		<div class="p-6">
			<div class="mb-4 flex items-center justify-between">
				<Dialog.Title id="license-activation-title" class="text-2xl font-bold text-slate-900">
					Enter License Code
				</Dialog.Title>
				<Dialog.Close
					class="rounded-lg p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600 transition-colors"
				>
					<svg class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
						<path
							stroke-linecap="round"
							stroke-linejoin="round"
							stroke-width="2"
							d="M6 18L18 6M6 6l12 12"
						/>
					</svg>
					<span class="sr-only">Close dialog</span>
				</Dialog.Close>
			</div>

			<p class="mb-4 text-sm text-slate-600">
				If you purchased a license code, enter it below to activate export access.
			</p>

			{#if errorMessage}
				<div class="mb-4 rounded-lg border border-red-200 bg-red-50 p-3">
					<p class="text-sm text-red-800">{errorMessage}</p>
				</div>
			{/if}

			<div class="space-y-4">
				<label for="license-key-input" class="block text-sm font-medium text-slate-700">
					License key
				</label>
				<input
					id="license-key-input"
					type="text"
					bind:value={licenseKey}
					placeholder="Enter your license key"
					class="w-full rounded-xl border border-slate-200 px-4 py-3 text-sm text-slate-900 placeholder-slate-400 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20 focus:outline-none"
					disabled={isLoading}
					onkeydown={(e) => e.key === 'Enter' && handleActivate()}
				/>
				<Button
					class="w-full"
					onclick={handleActivate}
					disabled={isLoading}
				>
					{#if isLoading}
						<span class="flex items-center justify-center gap-2">
							<svg
								class="h-4 w-4 animate-spin"
								xmlns="http://www.w3.org/2000/svg"
								fill="none"
								viewBox="0 0 24 24"
							>
								<circle
									class="opacity-25"
									cx="12"
									cy="12"
									r="10"
									stroke="currentColor"
									stroke-width="4"
								></circle>
								<path
									class="opacity-75"
									fill="currentColor"
									d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
								></path>
							</svg>
							Activating…
						</span>
					{:else}
						Activate license
					{/if}
				</Button>
			</div>
		</div>
	</Dialog.Content>
</Dialog.Root>
