<script lang="ts">
	import { Button } from '$lib/components/ui/button';
	import * as Dialog from "$lib/components/ui/dialog";

	interface Props {
		isOpen?: boolean;
		onClose?: () => void;
	}

	let { isOpen = $bindable(false), onClose }: Props = $props();

	let copied = $state(false);

	function handleClose() {
		isOpen = false;
		onClose?.();
	}

	async function handleShare() {
		if (typeof window === 'undefined') return;
		const url = window.location.origin;
		const shareData = {
			title: 'Print Studio – 3D print designer',
			text: 'I use this to design keychains, toppers, and more. It might help your shop too.',
			url
		};

		try {
			// Prefer native share sheet when available
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const nav = window.navigator as any;
			if (nav.share) {
				await nav.share(shareData);
			} else if (navigator.clipboard?.writeText) {
				await navigator.clipboard.writeText(url);
				copied = true;
				setTimeout(() => {
					copied = false;
				}, 2000);
			}
		} catch {
			// ignore share errors
		} finally {
			handleClose();
		}
	}
</script>

<Dialog.Root bind:open={isOpen}>
	<Dialog.Content>
		<div class="space-y-3 text-sm text-slate-600">
			<h2 class="text-lg font-semibold text-slate-900">
				Help keep Print Studio running
			</h2>
			<p>
				Print Studio is kept alive by a small number of paying makers. More users and subscribers
				help cover the costs so we can keep it online and keep adding new models.
			</p>
			<p>
				If you find it useful, sharing it with another creator, friend, or group helps a lot.
			</p>
			<p class="text-xs text-slate-500">
				If you're willing to promote the app (social media, groups, or your customers), send us a link
				or screenshot of your post—we really appreciate the support.
			</p>
		</div>

		<div class="mt-5 space-y-3">
			<div class="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
				<div class="text-[11px] text-slate-400">
					{#if copied}
						Link copied!
					{:else}
						Sharing just once makes a real difference.
					{/if}
				</div>
				<div class="flex justify-end gap-2">
					<Button variant="outline" size="sm" onclick={handleClose}>
						Maybe later
					</Button>
					<Button size="sm" onclick={handleShare}>
						Share Print Studio
					</Button>
				</div>
			</div>

			<div class="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-slate-50 px-3 py-2">
				<p class="text-[11px] text-slate-600">
					You can also message us directly if you’d like to chat about how you’re using Print Studio.
				</p>
				<Button variant="outline" size="sm" class="whitespace-nowrap" onclick={() => window.open("https://m.me/pixnprints.shop", "_blank")}>
					Message PixnPrints
				</Button>
			</div>
		</div>
	</Dialog.Content>
</Dialog.Root>
