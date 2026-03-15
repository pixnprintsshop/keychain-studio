<script lang="ts">
	import type { LicenseStatus } from '$lib/licensing';
	import * as Dialog from '$lib/components/ui/dialog';

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
			description: 'Make a keychain with just your name or favorite word—simple and fun.',
			imageSrc: '/images/text-only.png',
			imageAlt: 'Text Only preview'
		},
		{
			id: 'bumpyText',
			title: 'Bumpy Text',
			description:
				'Simple text with no base. Each character has a random thickness. Optional keyring.',
			imageSrc: '/images/bumpy-text.png',
			imageAlt: 'Bumpy Text preview',
			previewImageSrc: '/images/bumpy-text-preview.png'
		},
		{
			id: 'bowKeychain',
			title: 'Bow Keychain',
			description: 'Text on a bow-shaped base with optional keyring—cute and personal.',
			imageSrc: '/images/bow-keychain.png',
			imageAlt: 'Bow Keychain preview',
			previewImageSrc: '/images/bow-keychain-preview.png'
		},
		{
			id: 'initial',
			title: 'Text & Initial',
			description: 'Perfect for gifts—show off a big letter and a name together on your keychain.',
			imageSrc: '/images/text+initial.png',
			imageAlt: 'Text & Initial preview'
		},
		{
			id: 'flower',
			title: 'Flower + Initial',
			description: 'Add a colorful flower with your letter for a cute and cheerful keychain.',
			imageSrc: '/images/flower+initial.png',
			imageAlt: 'Flower & Initial preview',
			attribution:
				'https://makerworld.com/en/models/513050-flower-initial-keychains?from=search#profileId-429132',
			previewImageSrc: '/images/flower+initial-preview.png'
		},
		{
			id: 'basicName',
			title: 'Basic Name Tag',
			description: 'Classic name tag style—simple, stylish, and great for any occasion.',
			imageSrc: '/images/nametag.png',
			imageAlt: 'Basic Name Tag preview',
			attribution:
				'https://makerworld.com/en/models/219037-keytag-keychain-with-custom-name?from=search#profileId-251645',
			previewImageSrc: '/images/nametag-preview.png'
		},
		{
			id: 'dogtag',
			title: 'Dog Tag',
			description: 'Design a classic pet dog tag—personalized for your furry friend’s collar.',
			imageSrc: '/images/dogtag.png',
			imageAlt: 'Pet Dog Tag preview',
			previewImageSrc: '/images/dogtag-preview.png',
			attribution:
				'https://makerworld.com/en/models/1111790-dog-tag-name-tag-keychain?from=search#profileId-1108483'
		},
		{
			id: 'customSvg',
			title: 'Custom SVG',
			description:
				'Want something unique? Upload your drawing or logo to create a custom keychain!',
			imageSrc: '/images/custom-svg.png',
			imageAlt: 'Custom SVG Designer preview'
		},
		{
			id: 'charm',
			title: 'Chunky Charm',
			description: 'Turn your design into a cute charm you can easily thread a cord through.',
			imageSrc: '/images/charm.png',
			imageAlt: 'Chunky Charm preview'
		},
		{
			id: 'keycap',
			title: 'Keycap Maker',
			description: 'Upload your keycap base (STL) and add a centered icon on top.',
			imageSrc: '/images/keycap-maker.png',
			imageAlt: 'Keycap Maker preview'
		},
		{
			id: 'whistle',
			title: 'Custom Whistle',
			description: 'Add your name or message to a personal whistle.',
			imageSrc: '/images/whistle.png',
			imageAlt: 'Custom Whistle preview',
			attribution:
				'https://makerworld.com/en/models/119995-loud-whistle?from=search#profileId-129140',
			previewImageSrc: '/images/whistle-preview.png'
		},
		{
			id: 'stanleyTopper',
			title: 'Stanley Topper',
			description: 'Add your text on top of the Stanley topper—simple and personal.',
			imageSrc: '/images/stanley-topper.png',
			imageAlt: 'Stanley Topper preview',
			previewImageSrc: '/images/stanley-topper-preview.png',
			attribution:
				'https://makerworld.com/en/models/959060-40oz-stanley-tumbler-topper-cup-name-plate?from=search'
		},
		{
			id: 'strawTopper',
			title: 'Straw Topper',
			description:
				'Add your name to your favorite tumbler—simply snap this topper on and enjoy a personalized look!',
			imageSrc: '/images/straw-topper.png',
			imageAlt: 'Preview of Straw Topper',
			previewImageSrc: '/images/straw-topper-preview.png'
		},
		{
			id: 'pencilTopper',
			title: 'Pencil Topper',
			description:
				'Make your pencil stand out with a unique topper featuring your name—prints easily and slides on in seconds.',
			imageSrc: '/images/pencil-topper.png',
			imageAlt: 'Preview of Pencil Topper personalization',
			previewImageSrc: '/images/pencil-topper-preview.png'
		}
	];

	interface Props {
		paidOnlyDesigners: ReadonlySet<string>;
		licenseStatus: LicenseStatus | null;
		onSelect: (style: StyleName) => void;
		onOpenLicenseInfo: () => void;
	}

	let { paidOnlyDesigners, licenseStatus, onSelect, onOpenLicenseInfo }: Props = $props();

	const showLicenseCta = $derived(!licenseStatus || licenseStatus.type !== 'licensed');

	function isPaidDesigner(style: StyleName): boolean {
		return paidOnlyDesigners.has(style);
	}

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

<div class="flex min-h-dvh w-dvw items-center justify-center bg-slate-50 p-6">
	<div class="w-full max-w-4xl">
		<div class="mb-10 text-center">
			<div class="mb-4 flex justify-center">
				<img src="/app-logo.png" alt="PixnPrints Logo" class="h-16 w-auto object-contain" />
			</div>
			<h1 class="text-3xl font-bold tracking-tight text-slate-900">Print Studio</h1>
			<p class="mt-2 text-sm text-slate-500">Choose a style to start designing your 3D keychain</p>
		</div>

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
					<button
						type="button"
						class="rounded-xl bg-indigo-600 px-4 py-2 text-sm font-medium text-white shadow-sm transition hover:bg-indigo-700 focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 focus:outline-none"
						onclick={confirmBetaAndEnter}
					>
						Continue
					</button>
				</div>
			</Dialog.Content>
		</Dialog.Root>

		{#if DESIGNERS_UNDER_MAINTENANCE.size > 0}
			<div
				class="mb-6 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900"
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

		<div class="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-4">
			{#each DESIGNERS as designer (designer.id)}
				<!-- svelte-ignore a11y_click_events_have_key_events -->
				<!-- svelte-ignore a11y_no_static_element_interactions -->
				<div
					class="group relative overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm transition {isUnderMaintenance(
						designer.id
					)
						? 'cursor-not-allowed opacity-60'
						: 'cursor-pointer hover:-translate-y-1 hover:border-indigo-300 hover:shadow-lg'}"
					onclick={() => handleCardClick(designer)}
				>
					{#if isUnderMaintenance(designer.id)}
						<span
							class="absolute top-3 right-3 z-10 rounded-md bg-slate-200 px-2 py-0.5 text-xs font-medium text-slate-600"
							>Maintenance</span
						>
					{:else if isPaidDesigner(designer.id)}
						<span
							class="absolute top-3 right-3 z-10 rounded-md bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800"
							>PLUS</span
						>
					{/if}
					{#if isBetaDesigner(designer.id)}
						<span
							class="absolute top-3 left-3 z-10 rounded-md bg-sky-100 px-2 py-0.5 text-xs font-medium text-sky-800"
							>Beta</span
						>
					{/if}
					{#if designer.previewImageSrc}
						<!-- svelte-ignore a11y_click_events_have_key_events -->
						<div class="group/preview pointer-events-none absolute inset-0 z-10" aria-hidden="true">
							<button
								type="button"
								class="pointer-events-auto absolute top-3 right-3 flex size-8 items-center justify-center rounded-full bg-white/90 text-slate-500 shadow-sm transition hover:bg-white hover:text-slate-700 focus:ring-2 focus:ring-indigo-500/50 focus:outline-none {isPaidDesigner(
									designer.id
								) || isUnderMaintenance(designer.id)
									? 'right-12'
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
							</button>
							<div
								class="absolute top-0 right-0 left-0 aspect-4/3 overflow-hidden rounded-t-2xl border-b border-slate-100 bg-white opacity-0 transition-opacity duration-150 group-hover/preview:opacity-100"
							>
								<img src={designer.previewImageSrc} alt="" class="h-full w-full object-cover" />
							</div>
						</div>
					{/if}
					<div class="aspect-4/3 w-full overflow-hidden bg-slate-100">
						<img
							src={designer.imageSrc}
							alt={designer.imageAlt}
							class="h-full w-full object-cover transition {isUnderMaintenance(designer.id)
								? ''
								: 'group-hover:scale-105'}"
						/>
					</div>
					<div class="p-5">
						<h2 class="text-lg font-semibold text-slate-900">
							{designer.title}
						</h2>
						<p class="mt-1 text-sm leading-relaxed text-slate-500">
							{designer.description}
						</p>
						{#if designer.attribution}
							<!-- svelte-ignore a11y_click_events_have_key_events -->
							<a
								href={designer.attribution}
								target="_blank"
								rel="noopener noreferrer"
								class="mt-2 inline-flex items-center gap-1 rounded text-xs text-slate-400 hover:text-slate-600 focus:ring-2 focus:ring-indigo-500/30 focus:ring-offset-1 focus:outline-none"
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

		<!-- Get a license CTA (hidden when user is already licensed) -->
		{#if showLicenseCta}
			<div class="mt-10 flex flex-col items-center justify-center text-center">
				<p class="mb-4 text-sm text-slate-600">
					Need a license to unlock all designers and export?
				</p>
				<button
					type="button"
					class="w-full max-w-sm rounded-xl bg-indigo-600 px-6 py-4 text-base font-semibold text-white shadow-sm transition hover:bg-indigo-700 focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 focus:outline-none"
					onclick={onOpenLicenseInfo}
				>
					Get a license
				</button>
			</div>
		{/if}

		<!-- Business offer banner -->
		<div
			class="mt-8 rounded-2xl border border-indigo-200 bg-indigo-50/80 px-5 py-4 text-center sm:px-6"
		>
			<p class="text-sm font-semibold text-indigo-900">For businesses</p>
			<p class="mt-1 text-sm text-indigo-800">
				Want an exclusive model or the whole Print Studio for your brand? We offer custom designs
				and white-label options.
			</p>
			<a
				href="https://m.me/pixnprints.shop"
				target="_blank"
				rel="noopener noreferrer"
				class="mt-3 inline-block rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white shadow-sm transition hover:bg-indigo-700 focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 focus:outline-none"
			>
				Get in touch
			</a>
		</div>

		<div class="mt-8 flex flex-col items-center justify-center gap-3 text-center">
			<div class="flex items-center justify-center gap-2 text-xs text-slate-400">
				<span>By</span>
				<img src="/pixnprints-logo.png" alt="PixnPrints" class="h-10 w-auto object-contain" />
			</div>
			<div
				class="flex flex-wrap items-center justify-center gap-x-4 gap-y-1 text-xs text-slate-500"
			>
				{#if showLicenseCta}
					<button
						type="button"
						class="rounded underline hover:text-slate-700 focus:ring-2 focus:ring-indigo-500/30 focus:outline-none"
						onclick={onOpenLicenseInfo}
					>
						Get a license
					</button>
				{/if}
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
