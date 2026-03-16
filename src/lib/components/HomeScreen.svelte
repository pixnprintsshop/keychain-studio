<script lang="ts">
	import { Button } from '$lib/components/ui/button';
	import * as Dialog from '$lib/components/ui/dialog';
	import type { SubscriptionStatus } from '$lib/subscription';

	type StyleName =
		| 'textOutline'
		| 'initial'
		| 'flower'
		| 'basicName'
		| 'customSvg'
		| 'charm'
		| 'keycap'
		| 'whistle'
		| 'stanleyTopper'
		| 'strawTopper'
		| 'pencilTopper'
		| 'dogtag'
		| 'bumpyText'
		| 'bowKeychain';

	interface DesignerItem {
		id: StyleName;
		title: string;
		description: string;
		imageSrc: string;
		imageAlt: string;
		previewImageSrc?: string;
		attribution?: string;
	}

	/**
	 * Designers temporarily disabled (under maintenance).
	 * This uses the VITE_UNDER_MAINTENANCE_DESIGNERS env variable (comma separated ids).
	 */
	function getUnderMaintenanceDesigners(): Set<StyleName> {
		// The env variable should be set in .env as:
		// VITE_UNDER_MAINTENANCE_DESIGNERS=charm,flower
		// (for example, can be empty string or undefined for none)
		// Vite exposes import.meta.env but only env vars prefixed with VITE_
		// We cast the split type as StyleName for internal checking; invalid ids will be ignored.
		const envList = import.meta.env.VITE_UNDER_MAINTENANCE_DESIGNERS as string | undefined;
		if (!envList) return new Set();
		return new Set(
			envList
				.split(',')
				.map((x) => x.trim())
				.filter(Boolean) as StyleName[]
		);
	}
	const DESIGNERS_UNDER_MAINTENANCE = getUnderMaintenanceDesigners();

	const BETA_DESIGNERS: Set<StyleName> = new Set(['strawTopper', 'pencilTopper']);
	let pendingBetaDesigner: StyleName | null = $state(null);

	const DESIGNERS: DesignerItem[] = [
		{
			id: 'textOutline',
			title: 'Text Only',
			description: 'Floating text model for quick name plates or labels.',
			imageSrc: '/images/text-only.png',
			imageAlt: 'Text Only preview'
		},
		{
			id: 'bumpyText',
			title: 'Bumpy Text',
			description: 'Text-only model where each letter has a different thickness for a playful look.',
			imageSrc: '/images/bumpy-text.png',
			imageAlt: 'Bumpy Text preview',
			previewImageSrc: '/images/bumpy-text-preview.png'
		},
		{
			id: 'bowKeychain',
			title: 'Bow Keychain',
			description: 'Bow-shaped keychain with raised text, ready to add a keyring.',
			imageSrc: '/images/bow-keychain.png',
			imageAlt: 'Bow Keychain preview',
			previewImageSrc: '/images/bow-keychain-preview.png'
		},
		{
			id: 'initial',
			title: 'Text & Initial',
			description: 'Large initial with smaller name text, ideal for bag tags or keychains.',
			imageSrc: '/images/text+initial.png',
			imageAlt: 'Text & Initial preview'
		},
		{
			id: 'flower',
			title: 'Flower + Initial',
			description: 'Flower-shaped keychain with a single letter in the center.',
			imageSrc: '/images/flower+initial.png',
			imageAlt: 'Flower & Initial preview',
			attribution:
				'https://makerworld.com/en/models/513050-flower-initial-keychains?from=search#profileId-429132',
			previewImageSrc: '/images/flower+initial-preview.png'
		},
		{
			id: 'basicName',
			title: 'Basic Name Tag',
			description: 'Simple rectangular name tag with clean, readable text.',
			imageSrc: '/images/nametag.png',
			imageAlt: 'Basic Name Tag preview',
			attribution:
				'https://makerworld.com/en/models/219037-keytag-keychain-with-custom-name?from=search#profileId-251645',
			previewImageSrc: '/images/nametag-preview.png'
		},
		{
			id: 'dogtag',
			title: 'Dog Tag',
			description: 'Pet tag layout with name and optional details for collars.',
			imageSrc: '/images/dogtag.png',
			imageAlt: 'Pet Dog Tag preview',
			previewImageSrc: '/images/dogtag-preview.png',
			attribution:
				'https://makerworld.com/en/models/1111790-dog-tag-name-tag-keychain?from=search#profileId-1108483'
		},
		{
			id: 'customSvg',
			title: 'Custom SVG',
			description: 'Import an SVG logo or artwork and turn it into a printable keychain.',
			imageSrc: '/images/custom-svg.png',
			imageAlt: 'Custom SVG Designer preview'
		},
		{
			id: 'charm',
			title: 'Chunky Charm',
			description: 'Thicker charm with a built-in hole for string, cord, or chain.',
			imageSrc: '/images/charm.png',
			imageAlt: 'Chunky Charm preview'
		},
		{
			id: 'keycap',
			title: 'Keycap Maker',
			description: 'Add a centered icon or symbol on top of an existing keycap STL.',
			imageSrc: '/images/keycap-maker.png',
			imageAlt: 'Keycap Maker preview'
		},
		{
			id: 'whistle',
			title: 'Custom Whistle',
			description: 'Functional whistle with raised text along the side.',
			imageSrc: '/images/whistle.png',
			imageAlt: 'Custom Whistle preview',
			attribution:
				'https://makerworld.com/en/models/119995-loud-whistle?from=search#profileId-129140',
			previewImageSrc: '/images/whistle-preview.png'
		},
		{
			id: 'stanleyTopper',
			title: 'Stanley Topper',
			description: 'Name plate topper designed to sit on a 40oz Stanley-style tumbler.',
			imageSrc: '/images/stanley-topper.png',
			imageAlt: 'Stanley Topper preview',
			previewImageSrc: '/images/stanley-topper-preview.png',
			attribution:
				'https://makerworld.com/en/models/959060-40oz-stanley-tumbler-topper-cup-name-plate?from=search'
		},
		{
			id: 'strawTopper',
			title: 'Straw Topper',
			description: 'Name topper that snaps over a tumbler straw for easy cup identification.',
			imageSrc: '/images/straw-topper.png',
			imageAlt: 'Preview of Straw Topper',
			previewImageSrc: '/images/straw-topper-preview.png'
		},
		{
			id: 'pencilTopper',
			title: 'Pencil Topper',
			description: 'Sleeve-style topper that slides onto a pencil and shows a name or word.',
			imageSrc: '/images/pencil-topper.png',
			imageAlt: 'Preview of Pencil Topper personalization',
			previewImageSrc: '/images/pencil-topper-preview.png'
		}
	];

	interface Props {
		onSelect: (style: StyleName) => void;
		user?: { id: string } | null;
		subscriptionStatus?: SubscriptionStatus | null;
	}

	let { onSelect, user = null, subscriptionStatus = null }: Props = $props();

	const hasAccess = $derived(user && subscriptionStatus?.isActive);

	function isUnderMaintenance(style: StyleName): boolean {
		return DESIGNERS_UNDER_MAINTENANCE.has(style);
	}

	function isBetaDesigner(style: StyleName): boolean {
		return BETA_DESIGNERS.has(style);
	}

	function handleCardClick(designer: DesignerItem) {
		if (isUnderMaintenance(designer.id)) return;
		if (isBetaDesigner(designer.id)) {
			pendingBetaDesigner = designer.id;
			return;
		}
		onSelect(designer.id);
	}

	function confirmBetaAndEnter() {
		if (pendingBetaDesigner) {
			onSelect(pendingBetaDesigner);
			pendingBetaDesigner = null;
		}
	}

	function dismissBetaDialog() {
		pendingBetaDesigner = null;
	}
</script>

<div class="flex min-h-dvh w-dvw items-center justify-center bg-slate-50 px-4 py-6 pt-20 sm:p-6 sm:pt-25">
	<div class="w-full max-w-4xl">
		<div class="mb-6 text-center sm:mb-10">
			<div class="mb-3 flex justify-center sm:mb-4">
				<img
					src="/app-logo-full.png"
					alt="PixnPrints Logo"
					class="h-12 w-auto object-contain sm:h-16"
				/>
			</div>
			<p class="mt-2 text-sm text-slate-500">Choose a style to start designing your 3D keychain</p>
		</div>

		<!-- Subscription CTA: only for guests or users without access -->
		{#if !hasAccess}
			<div
				class="mb-6 flex flex-col items-center justify-center gap-3 rounded-xl border border-emerald-200 bg-emerald-50/80 px-4 py-3 sm:flex-row sm:justify-between sm:gap-4 sm:px-5 sm:py-3"
			>
				<p class="text-center text-sm font-medium text-emerald-900 sm:text-left">
					Subscribe to unlock full export and all designers
				</p>
				<Button href="/pricing" class="shrink-0 font-semibold">
					View pricing
				</Button>
			</div>
		{/if}

		<!-- Beta designer confirmation dialog (shadcn for smooth transitions) -->
		<Dialog.Root
			open={pendingBetaDesigner !== null}
			onOpenChange={(open) => {
				if (!open) pendingBetaDesigner = null;
			}}
		>
			<Dialog.Content
				showCloseButton={false}
				class="max-w-md rounded-2xl border-slate-200 shadow-xl"
			>
				<Dialog.Header>
					<Dialog.Title class="text-lg font-semibold text-slate-900">Beta design</Dialog.Title>
					<Dialog.Description class="mt-2 text-sm text-slate-600">
						This feature is currently in beta and the models may not be fully print-tested. If you
						encounter any issues or have suggestions, please let us know—your feedback will help us
						improve!
					</Dialog.Description>
				</Dialog.Header>
				<div class="mt-6 flex justify-end gap-3">
					<Dialog.Close
						class="rounded-xl border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 shadow-sm transition hover:bg-slate-50 focus:ring-2 focus:ring-indigo-500/50 focus:outline-none"
						onclick={dismissBetaDialog}
					>
						Cancel
					</Dialog.Close>
					<Button onclick={confirmBetaAndEnter}>
						Continue
					</Button>
				</div>
			</Dialog.Content>
		</Dialog.Root>

		{#if DESIGNERS_UNDER_MAINTENANCE.size > 0}
			<div
				class="mb-4 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2.5 text-sm text-amber-900 sm:mb-6 sm:px-4 sm:py-3"
				role="status"
			>
				<p class="font-medium">Some designers are under maintenance</p>
				<p class="mt-1 text-amber-800">
					{Array.from(DESIGNERS_UNDER_MAINTENANCE)
						.map((s) => {
							const d = DESIGNERS.find((d) => d.id === s);
							return d ? d.title : s;
						})
						.join(', ')}{Array.from(DESIGNERS_UNDER_MAINTENANCE).length === 1 ? ' is' : ' are'} temporarily
					unavailable. You can keep using the other designers, or
					<a
						target="_blank"
						href="http://m.me/arabis.aldrin"
						class="font-medium underline hover:no-underline"
						>cancel your subscription and request a refund</a
					>
					if you prefer.
				</p>
			</div>
		{/if}

		<div class="grid grid-cols-2 gap-4 sm:gap-5 lg:grid-cols-4">
			{#each DESIGNERS as designer (designer.id)}
				<!-- svelte-ignore a11y_click_events_have_key_events -->
				<!-- svelte-ignore a11y_no_static_element_interactions -->
				<div
					class="group relative overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm transition sm:rounded-2xl {isUnderMaintenance(
						designer.id
					)
						? 'cursor-not-allowed opacity-60'
						: 'cursor-pointer hover:-translate-y-1 hover:border-indigo-300 hover:shadow-lg'}"
					onclick={() => handleCardClick(designer)}
				>
					{#if isUnderMaintenance(designer.id)}
						<span
							class="absolute top-2 right-2 z-10 rounded bg-slate-200 px-1.5 py-0.5 text-[10px] font-medium text-slate-600 sm:top-3 sm:right-3 sm:rounded-md sm:px-2 sm:text-xs"
							>Maintenance</span
						>
					{/if}
					{#if isBetaDesigner(designer.id)}
						<span
							class="absolute top-2 left-2 z-10 rounded bg-sky-100 px-1.5 py-0.5 text-[10px] font-medium text-sky-800 sm:top-3 sm:left-3 sm:rounded-md sm:px-2 sm:text-xs"
							>Beta</span
						>
					{/if}
					{#if designer.previewImageSrc}
						<!-- svelte-ignore a11y_click_events_have_key_events -->
						<div class="group/preview pointer-events-none absolute inset-0 z-10" aria-hidden="true">
							<Button
								variant="ghost"
								size="icon"
								class="pointer-events-auto absolute top-2 right-2 size-6 rounded-full bg-white/90 text-slate-500 shadow-sm hover:bg-white hover:text-slate-700 sm:top-3 sm:right-3 sm:size-8 {isUnderMaintenance(
									designer.id
								)
									? 'right-9 sm:right-12'
									: ''}"
								title="Preview"
								aria-label="Show preview"
								onclick={(e) => e.stopPropagation()}
							>
								<svg
									xmlns="http://www.w3.org/2000/svg"
									class="size-4"
									fill="none"
									viewBox="0 0 24 24"
									stroke-width="2"
									stroke="currentColor"
									stroke-linecap="round"
									stroke-linejoin="round"
									aria-hidden="true"
								>
									<path
										d="M12 16v-4m0-4h.01M22 12c0 5.523-4.477 10-10 10S2 17.523 2 12 6.477 2 12 2s10 4.477 10 10z"
									/>
								</svg>
							</Button>
							<div
								class="absolute top-0 right-0 left-0 aspect-4/3 overflow-hidden rounded-t-xl border-b border-slate-100 bg-white opacity-0 transition-opacity duration-150 group-hover/preview:opacity-100 sm:rounded-t-2xl"
							>
								<img src={designer.previewImageSrc} alt="" class="h-full w-full object-cover" />
							</div>
						</div>
					{/if}
					<div class="aspect-4/3 w-full overflow-hidden rounded-t-xl bg-slate-100 sm:rounded-t-2xl">
						<img
							src={designer.imageSrc}
							alt={designer.imageAlt}
							class="h-full w-full object-cover transition {isUnderMaintenance(designer.id)
								? ''
								: 'group-hover:scale-105'}"
						/>
					</div>
					<div class="p-2.5 sm:p-5">
						<h2 class="text-sm font-semibold text-slate-900 sm:text-lg">
							{designer.title}
						</h2>
						<p class="mt-0.5 line-clamp-2 text-xs leading-snug text-slate-500 sm:mt-1 sm:line-clamp-none sm:text-sm">
							{designer.description}
						</p>
						{#if designer.attribution}
							<!-- svelte-ignore a11y_click_events_have_key_events -->
							<a
								href={designer.attribution}
								target="_blank"
								rel="noopener noreferrer"
								class="mt-1 inline-flex items-center gap-0.5 rounded text-[10px] text-slate-400 hover:text-slate-600 focus:ring-2 focus:ring-indigo-500/30 focus:ring-offset-1 focus:outline-none sm:mt-2 sm:gap-1 sm:text-xs"
								onclick={(e) => e.stopPropagation()}
								title="View source / credit"
							>
								<span>Source</span>
								<svg
									xmlns="http://www.w3.org/2000/svg"
									class="size-3 shrink-0"
									fill="none"
									viewBox="0 0 24 24"
									stroke="currentColor"
									stroke-width="2"
									stroke-linecap="round"
									stroke-linejoin="round"
									aria-hidden="true"
								>
									<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
									<polyline points="15 3 21 3 21 9" />
									<line x1="10" y1="14" x2="21" y2="3" />
								</svg>
							</a>
						{/if}
					</div>
				</div>
			{/each}
		</div>


		<!-- Business offer banner -->
		<div
			class="mt-6 rounded-2xl border border-indigo-200 bg-indigo-50/80 px-4 py-3 text-center sm:mt-8 sm:px-6 sm:py-4"
		>
			<p class="text-sm font-semibold text-indigo-900">For businesses</p>
			<p class="mt-1 text-sm text-indigo-800">
				Want an exclusive model or the whole Print Studio for your brand? We offer custom designs
				and white-label options.
			</p>
			<Button href="https://m.me/pixnprints.shop" target="_blank" rel="noopener noreferrer" class="mt-3">
				Get in touch
			</Button>
		</div>

		<div class="mt-6 flex flex-col items-center justify-center gap-3 text-center sm:mt-8">
			<div class="flex items-center justify-center gap-2 text-xs text-slate-400">
				<span>By</span>
				<img src="/pixnprints-logo.png" alt="PixnPrints" class="h-10 w-auto object-contain" />
			</div>
			<div
				class="flex flex-wrap items-center justify-center gap-x-4 gap-y-1 text-xs text-slate-500"
			>
				<a
					href="/pricing"
					class="rounded underline hover:text-slate-700 focus:ring-2 focus:ring-indigo-500/30 focus:outline-none"
				>
					Pricing
				</a>
				<a
					href="/terms"
					class="rounded underline hover:text-slate-700 focus:ring-2 focus:ring-indigo-500/30 focus:outline-none"
				>
					Terms and Conditions
				</a>
				<a
					href="/privacy"
					class="rounded underline hover:text-slate-700 focus:ring-2 focus:ring-indigo-500/30 focus:outline-none"
				>
					Privacy Policy
				</a>
				<a
					href="/refund"
					class="rounded underline hover:text-slate-700 focus:ring-2 focus:ring-indigo-500/30 focus:outline-none"
				>
					Refund Policy
				</a>
				<a
					href="/about"
					class="rounded underline hover:text-slate-700 focus:ring-2 focus:ring-indigo-500/30 focus:outline-none"
				>
					About
				</a>
			</div>
		</div>
	</div>
</div>
