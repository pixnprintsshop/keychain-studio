<script lang="ts">
	import { Button } from '$lib/components/ui/button';
	import * as Dialog from '$lib/components/ui/dialog';
	import {
		LACE_BADGE_OFFER_IMAGES,
		LACE_BADGE_OFFER_PRICE_PHP,
		LACE_BADGE_OFFER_VIDEO_SRC,
		MESSENGER_COMMUNITY_URL
	} from '$lib/idNameTagV2LaceBadgeOffer';

	interface Props {
		open: boolean;
		onOpenChange: (open: boolean) => void;
		onJoinGroup?: () => void;
		onDismiss?: () => void;
	}

	let { open, onOpenChange, onJoinGroup, onDismiss }: Props = $props();

	const steps = [
		'Join our official Messenger community group.',
		'Message us that you want the ID lace badge.',
		'We confirm your name and order details.'
	];

	function dismiss() {
		onDismiss?.();
		onOpenChange(false);
	}

	function handleJoinGroup() {
		onJoinGroup?.();
		window.open(MESSENGER_COMMUNITY_URL, '_blank', 'noopener,noreferrer');
		onOpenChange(false);
	}
</script>

<Dialog.Root {open} {onOpenChange}>
	<Dialog.Content
		class="flex max-h-[min(92vh,720px)] max-w-2xl flex-col gap-0 overflow-hidden rounded-2xl border-slate-200 p-0 shadow-xl sm:max-w-2xl"
	>
		<div class="grid max-h-[min(92vh,720px)] grid-cols-1 overflow-y-auto sm:grid-cols-2">
			<div
				class="relative flex flex-col gap-3 overflow-hidden bg-linear-to-br from-violet-100 via-white to-pink-50 p-4 sm:p-5"
			>
				<span
					class="absolute top-3 left-3 z-10 rounded-full bg-violet-600 px-2.5 py-0.5 text-[10px] font-bold tracking-wide text-white uppercase"
				>
					Exclusive offer
				</span>
				<div class="mt-6 grid grid-cols-2 gap-2">
					<div
						class="col-span-2 overflow-hidden rounded-xl border border-violet-200/80 bg-white shadow-md ring-1 ring-violet-100"
					>
						<img
							src={LACE_BADGE_OFFER_IMAGES[0].src}
							alt={LACE_BADGE_OFFER_IMAGES[0].alt}
							class="aspect-4/3 w-full object-cover object-center"
							width={800}
							height={600}
							loading="eager"
							decoding="async"
						/>
					</div>
					{#each LACE_BADGE_OFFER_IMAGES.slice(1) as image (image.src)}
						<div
							class="overflow-hidden rounded-xl border border-violet-200/80 bg-white shadow-sm ring-1 ring-violet-100"
						>
							<img
								src={image.src}
								alt={image.alt}
								class="aspect-square w-full object-cover object-center"
								width={400}
								height={400}
								loading="lazy"
								decoding="async"
							/>
						</div>
					{/each}
				</div>
				{#if LACE_BADGE_OFFER_VIDEO_SRC}
					<div
						class="overflow-hidden rounded-xl border border-violet-200/80 bg-black shadow-md ring-1 ring-violet-100"
					>
						<video
							src={LACE_BADGE_OFFER_VIDEO_SRC}
							class="aspect-video w-full object-cover"
							controls
							playsinline
							preload="metadata"
						>
							<track kind="captions" />
						</video>
					</div>
				{/if}
			</div>

			<div
				class="flex flex-col justify-center gap-3 border-t border-slate-100 px-4 py-4 sm:border-t-0 sm:border-l sm:px-5 sm:py-5"
			>
				<Dialog.Header class="space-y-1.5 text-left">
					<Dialog.Title class="text-base font-bold tracking-tight text-slate-900 sm:text-lg">
						Custom ID lace badge
					</Dialog.Title>
					<Dialog.Description class="text-xs leading-relaxed text-slate-600 sm:text-sm">
						A ready-to-wear 3D-printed name badge with a character clip that slides onto your ID
						lace or lanyard — perfect companion to the tags you design here.
					</Dialog.Description>
				</Dialog.Header>

				<p class="text-2xl font-bold tracking-tight text-violet-700 sm:text-3xl">
					₱{LACE_BADGE_OFFER_PRICE_PHP.toLocaleString('en-PH')}
				</p>

				<ol
					class="list-decimal space-y-1.5 rounded-xl border border-violet-100 bg-violet-50/60 p-3 pl-7 text-[11px] text-slate-700 sm:text-xs"
				>
					{#each steps as step (step)}
						<li class="leading-snug">{step}</li>
					{/each}
				</ol>

				<p class="text-[10px] leading-snug text-slate-500 sm:text-[11px]">
					More photos and a video coming soon. For now, message us in the group to see character
					options and place your order.
				</p>
			</div>
		</div>

		<Dialog.Footer
			class="shrink-0 gap-2 border-t border-slate-100 bg-slate-50/80 px-4 py-3 sm:justify-between sm:px-5 sm:py-4"
		>
			<Button type="button" variant="ghost" class="text-slate-600" onclick={dismiss}>
				Maybe later
			</Button>
			<Button type="button" onclick={handleJoinGroup}>Join group to avail</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
