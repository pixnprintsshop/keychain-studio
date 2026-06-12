<script lang="ts">
	import { onMount } from 'svelte';
	import type { User } from '@supabase/supabase-js';
	import { Button } from '$lib/components/ui/button';
	import * as Dialog from '$lib/components/ui/dialog';
	import { COMING_SOON_DESIGNER_IDS } from '$lib/comingSoonDesigners';
	import {
		isComingSoonInterestRecorded,
		markComingSoonInterestRecorded,
		notifyComingSoonInterest
	} from '$lib/comingSoonInterestNotify';
	import {
		hasPaidAccess,
		isSubscriberOnlyDesigner,
		type SubscriptionStatus
	} from '$lib/subscription';
	import FavoriteDesignersFeatureDialog from '$lib/components/FavoriteDesignersFeatureDialog.svelte';
	import NewFontsFeatureDialog from '$lib/components/NewFontsFeatureDialog.svelte';
	import PickleballKeychainFeatureDialog from '$lib/components/PickleballKeychainFeatureDialog.svelte';
	import FloatingGlobalExportCounter from '$lib/components/FloatingGlobalExportCounter.svelte';
	import FloatingRecentExportsFeed from '$lib/components/FloatingRecentExportsFeed.svelte';
	import { exportStats, formatExportCount, getDesignerExportCount } from '$lib/exportStats.svelte';
	import {
		favoriteSortIndex,
		isFavoriteDesigner,
		toggleFavoriteDesigner
	} from '$lib/favoriteDesigners.svelte';
	import { notifyFavoriteAction } from '$lib/favoriteNotify';
	import { MESSENGER_COMMUNITY_URL } from '$lib/messengerCommunity';
	import {
		getDialogBlockingRevision,
		isAnyDialogBlocking,
		setDialogBlocking
	} from '$lib/dialogCoordinator.svelte';
	import {
		clearPendingHomeFeatureDialog,
		getPendingHomeFeatureDialog,
		resolveNextHomeFeatureDialog,
		setPendingHomeFeatureDialog,
		type HomeFeatureDialogId
	} from '$lib/homeFeatureDialogQueue';
	import { getNewFontsDialogFingerprint } from '$lib/newFonts';
	import { getFont } from '$lib/utils-3d';

	const STORAGE_KEY_FAVORITE_FEATURE_DIALOG = 'favorite-designers-feature-dialog-v1';
	const STORAGE_KEY_NEW_FONTS_FEATURE_DIALOG = 'new-fonts-feature-dialog-v1';
	const STORAGE_KEY_PICKLEBALL_KEYCHAIN_FEATURE_DIALOG = 'pickleball-keychain-feature-dialog-v1';
	const STORAGE_KEY_COMMUNITY_INVITE_DISMISSED = 'messenger-community-invite-dismissed-v1';
	const STORAGE_KEY_COMMUNITY_INVITE_DIALOG = 'messenger-community-invite-dialog-v1';

	let comingSoonInterestSent = $state<Set<StyleName>>(new Set());
	let comingSoonInterestSending = $state<StyleName | null>(null);
	let favoriteFeatureDialogOpen = $state(false);
	let newFontsFeatureDialogOpen = $state(false);
	let pickleballKeychainFeatureDialogOpen = $state(false);
	let showCommunityInviteAlert = $state(false);

	function markFavoriteFeatureDialogSeen() {
		try {
			localStorage.setItem(STORAGE_KEY_FAVORITE_FEATURE_DIALOG, '1');
		} catch {
			// Local storage can be unavailable in private browsing contexts.
		}
	}

	function onFavoriteFeatureDialogOpenChange(open: boolean) {
		favoriteFeatureDialogOpen = open;
		if (!open) markFavoriteFeatureDialogSeen();
	}

	function isCommunityInviteDismissed(): boolean {
		try {
			return (
				localStorage.getItem(STORAGE_KEY_COMMUNITY_INVITE_DISMISSED) === '1' ||
				localStorage.getItem(STORAGE_KEY_COMMUNITY_INVITE_DIALOG) === '1'
			);
		} catch {
			return false;
		}
	}

	function dismissCommunityInviteAlert() {
		showCommunityInviteAlert = false;
		try {
			localStorage.setItem(STORAGE_KEY_COMMUNITY_INVITE_DISMISSED, '1');
		} catch {
			// Local storage can be unavailable in private browsing contexts.
		}
	}

	function markNewFontsFeatureDialogSeen() {
		try {
			localStorage.setItem(
				STORAGE_KEY_NEW_FONTS_FEATURE_DIALOG,
				getNewFontsDialogFingerprint()
			);
		} catch {
			// Local storage can be unavailable in private browsing contexts.
		}
	}

	function onNewFontsFeatureDialogOpenChange(open: boolean) {
		newFontsFeatureDialogOpen = open;
		if (!open) markNewFontsFeatureDialogSeen();
	}

	function isNewFontsFeatureDialogSeen(): boolean {
		try {
			const seen = localStorage.getItem(STORAGE_KEY_NEW_FONTS_FEATURE_DIALOG);
			if (!seen) return false;
			// Legacy dismiss flag — re-show when the new-font list has changed.
			if (seen === '1') return getNewFontsDialogFingerprint() === '';
			return seen === getNewFontsDialogFingerprint();
		} catch {
			return true;
		}
	}

	function isFavoriteFeatureDialogSeen(): boolean {
		try {
			return localStorage.getItem(STORAGE_KEY_FAVORITE_FEATURE_DIALOG) === '1';
		} catch {
			return true;
		}
	}

	function markPickleballKeychainFeatureDialogSeen() {
		try {
			localStorage.setItem(STORAGE_KEY_PICKLEBALL_KEYCHAIN_FEATURE_DIALOG, '1');
		} catch {
			// Local storage can be unavailable in private browsing contexts.
		}
	}

	function onPickleballKeychainFeatureDialogOpenChange(open: boolean) {
		pickleballKeychainFeatureDialogOpen = open;
		if (!open) markPickleballKeychainFeatureDialogSeen();
	}

	function isPickleballKeychainFeatureDialogSeen(): boolean {
		try {
			return localStorage.getItem(STORAGE_KEY_PICKLEBALL_KEYCHAIN_FEATURE_DIALOG) === '1';
		} catch {
			return true;
		}
	}

	function isAnyHomeDialogVisible(): boolean {
		return (
			pickleballKeychainFeatureDialogOpen ||
			newFontsFeatureDialogOpen ||
			favoriteFeatureDialogOpen ||
			pendingBetaDesigner !== null ||
			pendingSubscriberDesigner !== null
		);
	}

	function openHomeFeatureDialog(id: HomeFeatureDialogId) {
		if (id === 'pickleballKeychain') pickleballKeychainFeatureDialogOpen = true;
		else if (id === 'newFonts') newFontsFeatureDialogOpen = true;
		else favoriteFeatureDialogOpen = true;
	}

	/** Show at most one welcome/feature dialog per home visit; postpone if another modal is open. */
	function showHomeFeatureDialogs() {
		const shouldShowPickleballKeychain = !isPickleballKeychainFeatureDialogSeen();
		const shouldShowNewFonts =
			getNewFontsDialogFingerprint().length > 0 && !isNewFontsFeatureDialogSeen();
		const shouldShowFavorite = !isFavoriteFeatureDialogSeen();
		const pending = getPendingHomeFeatureDialog();
		const next = resolveNextHomeFeatureDialog({
			pending,
			shouldShowPickleballKeychain,
			shouldShowNewFonts,
			shouldShowFavorite
		});

		if (!next) {
			clearPendingHomeFeatureDialog();
			return;
		}

		if (isAnyHomeDialogVisible() || isAnyDialogBlocking()) {
			setPendingHomeFeatureDialog(next);
			return;
		}

		clearPendingHomeFeatureDialog();
		openHomeFeatureDialog(next);
	}

	$effect(() => {
		setDialogBlocking('home', isAnyHomeDialogVisible());
	});

	$effect(() => {
		getDialogBlockingRevision();
		if (!getPendingHomeFeatureDialog()) return;
		if (isAnyDialogBlocking()) return;
		showHomeFeatureDialogs();
	});

	function tryFavoriteFeatureFromDialog() {
		document.getElementById('designer-grid')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
	}

	function tryNewFontsFromDialog() {
		onSelect('textOutline');
	}

	function tryPickleballKeychainFromDialog() {
		onSelect('pickleballKeychain');
	}

	// Preload font so Name Puzzle designer opens faster; restore interest flags from session.
	onMount(() => {
		getFont('Roadside Sans_Regular');
		const sent = new Set<StyleName>();
		for (const id of COMING_SOON_DESIGNER_IDS) {
			if (isComingSoonInterestRecorded(id)) sent.add(id as StyleName);
		}
		comingSoonInterestSent = sent;
		showHomeFeatureDialogs();
		showCommunityInviteAlert = !isCommunityInviteDismissed();
	});

	type StyleName =
		| 'textOutline'
		| 'initial'
		| 'flower'
		| 'basicName'
		| 'idNameTag'
		| 'idNameTagV2'
		| 'customSvg'
		| 'charm'
		| 'keycap'
		| 'keycapSet'
		| 'whistle'
		| 'whistleV2'
		| 'whistleBagTag'
		| 'stanleyTopper'
		| 'strawTopper'
		| 'pencilTopper'
		| 'dogtag'
		| 'bumpyText'
		| 'bowKeychain'
		| 'pickleballKeychain'
		| 'hoopTag'
		| 'articulatedKeychain'
		| 'spotifyKeychain'
		| 'namePuzzle'
		| 'engraveNamePlate'
		| 'cakeTopper'
		| 'canvasStudio'
		| 'plateBadge'
		| 'houseNumberPlaque'
		| 'roomSign';

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

	/**
	 * Designers marked as "New".
	 * This uses the VITE_NEW_DESIGNERS env variable (comma separated ids).
	 */
	function getNewDesigners(): Set<StyleName> {
		// The env variable should be set in .env as:
		// VITE_NEW_DESIGNERS=namePuzzle,bumpyText
		// (for example, can be empty string or undefined for none)
		const envList = import.meta.env.VITE_NEW_DESIGNERS as string | undefined;
		if (!envList) return new Set();
		return new Set(
			envList
				.split(',')
				.map((x) => x.trim())
				.filter(Boolean) as StyleName[]
		);
	}
	const NEW_DESIGNERS = getNewDesigners();

	// Short release notes shown in a popover when the user hovers/taps the
	// "Updated" badge. Any designer listed here gets the Updated badge.
	// Keep each note to one or two sentences.
	const UPDATE_NOTES: Partial<Record<StyleName, string>> = {
		basicName:
			'Color preset gallery plus optional text-outline layer with a matching border frame. Import starters or save your own combos; presets sync to your account when signed in.',
		textOutline:
			'Side-tab keyring style — a fixed left-center tab with adjustable extension and hole size, plus the original round corner ring. Also: new fonts, inset border rim, text-outline layer, and color presets.',
		// whistleBagTag:
		// 	'Optional text-outline layer (middle) plus a color preset gallery (base, outline, and border/text). Presets sync when signed in.',
		// whistleV2:
		// 	'Color preset gallery for Accent, Main, and Border — import starters or save your own. Presets sync to your account when signed in.',
		idNameTagV2:
			'Back print view uses a fixed underside preview with bottom lighting. Also: center or dual lace loops, optional text-outline layer, and color presets that sync when signed in.',
		hoopTag:
			'HoopTag default size and keyring tab are 10% smaller. Layer Based stacks four print layers for multi-color printing.',
		whistle:
			'Custom Whistle text position X/Y sliders and settings now persist across visits.',
		dogtag:
			'Optional text-outline layer with a matching border frame, plus a color preset gallery (base, outline, and text/border). Presets sync when signed in.',
		namePuzzle:
			'Letters with descenders (like Q) no longer shrink or shift the rest of the name — only the base grows to fit the tail.',
		plateBadge:
			'Multiline text — press Enter for a new line. The layout view shows a full preview of the plate base.',
	};

	const BETA_DESIGNERS: Set<StyleName> = new Set(['strawTopper', 'pencilTopper', 'plateBadge']);
	const COMING_SOON_DESIGNERS: Set<StyleName> = new Set(
		COMING_SOON_DESIGNER_IDS as unknown as StyleName[]
	);
	let pendingBetaDesigner: StyleName | null = $state(null);
	let pendingSubscriberDesigner: StyleName | null = $state(null);

	const DESIGNERS: DesignerItem[] = [
		{
			id: 'articulatedKeychain',
			title: 'Articulated Keychain',
			description:
				'Linked letter bases from start, mid, and end segments — type a name to build the chain.',
			imageSrc: '/images/articulated-keychain.png',
			imageAlt: 'Articulated Keychain preview'
		},
		{
			id: 'whistleV2',
			title: 'Whistle v2',
			description: 'Multicolor whistle (Accent, Main, Border) with raised text on top.',
			imageSrc: '/images/whistle-v2.png',
			imageAlt: 'Whistle v2 preview'
		},
		{
			id: 'whistleBagTag',
			title: 'Whistle Bag Tag',
			description:
				'Bag tag whistle body with base, border rim, and multiline raised text (border matches text color).',
			imageSrc: '/images/whistle-bag-tag.png',
			imageAlt: 'Whistle Bag Tag preview'
		},
		{
			id: 'textOutline',
			title: 'Text Only',
			description: 'Floating text model for quick name plates or labels.',
			imageSrc: '/images/text-only.png',
			imageAlt: 'Text Only preview'
		},
		{
			id: 'spotifyKeychain',
			title: 'Spotify Keychain',
			description:
				'Scannable Spotify Code on a keychain base — paste an album, track, playlist, or artist link.',
			imageSrc: '/images/spotify-keychain.png',
			imageAlt: 'Spotify Keychain preview'
		},
		{
			id: 'canvasStudio',
			title: 'Canvas Studio',
			description:
				'Free-form 2D canvas with text and built-in shapes — drag, rotate, scale, then convert to 3D.',
			// Placeholder reuse; swap with /images/canvas-studio.png when ready.
			imageSrc: '/images/canvas-studio.png',
			imageAlt: 'Canvas Studio preview'
		},
		{
			id: 'plateBadge',
			title: 'Plate badge',
			description: 'Motorcycle plate accessory: fixed bar with end mounting slots',
			imageSrc: '/images/plate-badge.png',
			imageAlt: 'Motorcycle plate accessory badge examples'
		},
		{
			id: 'cakeTopper',
			title: 'Cake Topper',
			description: 'Multi-line cake topper with adjustable spacing and 1 or 2 long sticks.',
			imageSrc: '/images/cake-topper.png',
			imageAlt: 'Cake Topper preview'
		},
		{
			id: 'idNameTag',
			title: 'ID Name Tag',
			description: 'Name tag with customizable text and colors.',
			imageSrc: '/images/id-name-tag.png',
			imageAlt: 'ID Name Tag preview'
		},
		{
			id: 'idNameTagV2',
			title: 'ID Name Tag v2',
			description: 'Fixed STL name tag styles with selectable base and border pairs.',
			imageSrc: '/images/id-name-tag-v2.png',
			imageAlt: 'ID Name Tag v2 preview'
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
			id: 'houseNumberPlaque',
			title: 'House Number Plaque',
			description:
				'Wall plaque with multiline raised text, optional border frame, and corner mounting holes.',
			imageSrc: '/images/house-number-plaque.png',
			imageAlt: 'House Number Plaque preview'
		},
		{
			id: 'roomSign',
			title: 'Room Sign',
			description:
				'Decorative plaque with ornate border flourishes and centered raised room name text.',
			imageSrc: '/images/room-sign.png',
			imageAlt: 'Room Sign preview'
		},
		{
			id: 'keycapSet',
			title: 'Keycap Set Maker',
			description: 'Type your own legends (default A–Z and 0–9)',
			imageSrc: '/images/keycap-set-maker.png',
			imageAlt: 'Keycap Set Maker preview'
		},
		{
			id: 'engraveNamePlate',
			title: 'Engrave name plate',
			description: 'Contour plate from your text with an engraved pocket and optional keyring tab.',
			imageSrc: '/images/engrave-name-plate.png',
			imageAlt: 'Engrave name plate preview'
		},
		{
			id: 'bumpyText',
			title: 'Bumpy Text',
			description:
				'Text-only model where each letter has a different thickness for a playful look.',
			imageSrc: '/images/bumpy-text.png',
			imageAlt: 'Bumpy Text preview',
			previewImageSrc: '/images/bumpy-text-preview.png'
		},
		{
			id: 'bowKeychain',
			title: 'Bow Keychain',
			description: 'Bow-shaped keychain with raised text',
			imageSrc: '/images/bow-keychain.png',
			imageAlt: 'Bow Keychain preview',
			previewImageSrc: '/images/bow-keychain-preview.png'
		},
		{
			id: 'pickleballKeychain',
			title: 'Pickleball keychain',
			description:
				'Paddle and ball keychain with a center icon, base rim, and decor details — optional keyring tab.',
			imageSrc: '/images/pickleball-keychain-feature-dialog.png',
			imageAlt: 'Pickleball keychain preview'
		},
		{
			id: 'hoopTag',
			title: 'HoopTag',
			description:
				'Basketball backboard and net keychain with multi-color artwork, offset base rim, and keyring hole.',
			imageSrc: '/images/hoop-tag.png',
			imageAlt: 'HoopTag basketball keychain preview'
		},
		{
			id: 'namePuzzle',
			title: 'Baby / Toddler Name Puzzle',
			description:
				'Rectangular puzzle base with letter cutouts. Letters fit into slots as removable pieces.',
			imageSrc: '/images/name-puzzle.png',
			imageAlt: 'Name Puzzle preview',
			previewImageSrc: '/images/name-puzzle-preview.png'
		},
		{
			id: 'initial',
			title: 'Text & Initial',
			description: 'Large initial with smaller name text',
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
			id: 'dogtag',
			title: 'Dog Tag',
			description: 'Pet tag layout with name for collars.',
			imageSrc: '/images/dogtag.png',
			imageAlt: 'Pet Dog Tag preview',
			previewImageSrc: '/images/dogtag-preview.png',
			attribution:
				'https://makerworld.com/en/models/1111790-dog-tag-name-tag-keychain?from=search#profileId-1108483'
		},
		// {
		// 	id: 'customSvg',
		// 	title: 'Custom SVG',
		// 	description: 'Import an SVG logo or artwork and turn it into a printable keychain.',
		// 	imageSrc: '/images/custom-svg.png',
		// 	imageAlt: 'Custom SVG Designer preview'
		// },
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
			description: 'Functional whistle with raised text.',
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
		user?: User | null;
		subscriptionStatus?: SubscriptionStatus | null;
		onShowPricing?: () => void;
		onRequestLogin?: () => void;
	}

	let {
		onSelect,
		user = null,
		subscriptionStatus = null,
		onShowPricing,
		onRequestLogin
	}: Props = $props();

	const hasAccess = $derived(hasPaidAccess(user, subscriptionStatus));

	function isUnderMaintenance(style: StyleName): boolean {
		return DESIGNERS_UNDER_MAINTENANCE.has(style);
	}

	function isBetaDesigner(style: StyleName): boolean {
		return BETA_DESIGNERS.has(style);
	}

	function isComingSoonDesigner(style: StyleName): boolean {
		return COMING_SOON_DESIGNERS.has(style);
	}

	function isSubscriberOnlyDesignerStyle(style: StyleName): boolean {
		return isSubscriberOnlyDesigner(style);
	}

	function isSubscriberLocked(style: StyleName): boolean {
		return isSubscriberOnlyDesignerStyle(style) && !hasAccess;
	}

	function isNewDesigner(style: StyleName): boolean {
		return NEW_DESIGNERS.has(style);
	}

	// "Updated" is suppressed when a designer is also flagged "New" — the New
	// badge already implies "look at this", so we avoid double-tagging.
	function isUpdatedDesigner(style: StyleName): boolean {
		return Boolean(UPDATE_NOTES[style]) && !NEW_DESIGNERS.has(style);
	}

	function getUpdateNote(style: StyleName): string {
		return UPDATE_NOTES[style] ?? '';
	}

	function designerListSortRank(id: StyleName): number {
		if (isComingSoonDesigner(id)) return 0;
		if (isNewDesigner(id)) return 1;
		if (isUpdatedDesigner(id)) return 2;
		return 3;
	}

	const designerDisplayOrder = new Map(DESIGNERS.map((designer, index) => [designer.id, index]));

	const sortedDesigners = $derived(
		[...DESIGNERS].sort((a, b) => {
			const aFavorite = favoriteSortIndex(a.id);
			const bFavorite = favoriteSortIndex(b.id);
			if (aFavorite >= 0 && bFavorite >= 0) return aFavorite - bFavorite;
			if (aFavorite >= 0) return -1;
			if (bFavorite >= 0) return 1;

			const byRank = designerListSortRank(a.id) - designerListSortRank(b.id);
			if (byRank !== 0) return byRank;
			return (designerDisplayOrder.get(a.id) ?? 0) - (designerDisplayOrder.get(b.id) ?? 0);
		})
	);

	function isComingSoonInterestDone(id: StyleName): boolean {
		return comingSoonInterestSent.has(id);
	}

	async function handleComingSoonInterest(designer: DesignerItem, event: MouseEvent) {
		event.stopPropagation();
		if (isComingSoonInterestDone(designer.id) || comingSoonInterestSending === designer.id) return;

		comingSoonInterestSending = designer.id;
		const ok = await notifyComingSoonInterest({
			designerId: designer.id,
			designerTitle: designer.title,
			email: user?.email,
			userId: user?.id,
			subscriptionStatus
		});
		comingSoonInterestSending = null;

		if (ok) {
			markComingSoonInterestRecorded(designer.id);
			comingSoonInterestSent = new Set([...comingSoonInterestSent, designer.id]);
		}
	}

	function handleCardClick(designer: DesignerItem) {
		if (isComingSoonDesigner(designer.id)) return;
		if (isUnderMaintenance(designer.id)) return;
		if (isAnyDialogBlocking()) return;
		if (isSubscriberLocked(designer.id)) {
			if (!user) {
				onRequestLogin?.();
				return;
			}
			pendingSubscriberDesigner = designer.id;
			return;
		}
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

	function dismissSubscriberDialog() {
		pendingSubscriberDesigner = null;
	}

	function confirmSubscriberAccess() {
		pendingSubscriberDesigner = null;
		onShowPricing?.();
	}
</script>

<FloatingGlobalExportCounter />
<FloatingRecentExportsFeed />

<div
	class="flex min-h-dvh w-dvw items-center justify-center bg-slate-50 px-4 py-6 pt-20 sm:p-6 sm:pt-25"
>
	<div class="w-full max-w-6xl">
		<div class="mb-6 text-center sm:mb-10">
			<div class="mb-3 flex justify-center sm:mb-4">
				<img
					src="/app-logo-full.png"
					alt="PixnPrints Logo"
					class="h-12 w-auto object-contain sm:h-16"
				/>
			</div>
			<p class="mt-2 text-sm text-slate-500">Choose a style to start designing your 3D model</p>
		</div>

		<!-- Subscription CTA: only for guests or users without access -->
		{#if !hasAccess}
			<div
				class="mb-6 flex flex-col items-center justify-center gap-3 rounded-xl border px-4 py-3 sm:flex-row sm:justify-between sm:gap-4 sm:px-5 sm:py-3 {subscriptionStatus?.licenseExpired
					? 'border-amber-200 bg-amber-50/80'
					: 'border-emerald-200 bg-emerald-50/80'}"
			>
				<p
					class="text-center text-sm font-medium sm:text-left {subscriptionStatus?.licenseExpired
						? 'text-amber-900'
						: 'text-emerald-900'}"
				>
					{subscriptionStatus?.licenseExpired
						? 'Your license has expired. Subscribe or activate a new license to restore access.'
						: 'Subscribe to unlock full export and all designers'}
				</p>
				<Button href="/pricing" class="shrink-0 font-semibold">View pricing</Button>
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
					<Button onclick={confirmBetaAndEnter}>Continue</Button>
				</div>
			</Dialog.Content>
		</Dialog.Root>

		<Dialog.Root
			open={pendingSubscriberDesigner !== null}
			onOpenChange={(open) => {
				if (!open) pendingSubscriberDesigner = null;
			}}
		>
			<Dialog.Content
				showCloseButton={false}
				class="max-w-md rounded-2xl border-slate-200 shadow-xl"
			>
				<Dialog.Header>
					<Dialog.Title class="text-lg font-semibold text-slate-900"
						>Subscription required</Dialog.Title
					>
					<Dialog.Description class="mt-2 text-sm text-slate-600">
						{pendingSubscriberDesigner
							? (DESIGNERS.find((d) => d.id === pendingSubscriberDesigner)?.title ??
								'This designer')
							: 'This designer'} is available with an active subscription or license. Free trial
						downloads do not apply here.
					</Dialog.Description>
				</Dialog.Header>
				<div class="mt-6 flex justify-end gap-3">
					<Dialog.Close
						class="rounded-xl border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 shadow-sm transition hover:bg-slate-50 focus:ring-2 focus:ring-indigo-500/50 focus:outline-none"
						onclick={dismissSubscriberDialog}
					>
						Cancel
					</Dialog.Close>
					<Button onclick={confirmSubscriberAccess}>View pricing</Button>
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

		{#if showCommunityInviteAlert}
			<div
				class="mb-4 rounded-xl border border-sky-200 bg-sky-50 px-3 py-2.5 sm:mb-6 sm:px-4 sm:py-3"
				role="status"
			>
				<div class="flex items-start gap-3">
					<div
						class="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full bg-sky-100 text-sky-600"
						aria-hidden="true"
					>
						<svg
							xmlns="http://www.w3.org/2000/svg"
							class="size-4"
							viewBox="0 0 24 24"
							fill="currentColor"
						>
							<path
								d="M12 2C6.48 2 2 6.13 2 11.06c0 2.86 1.44 5.41 3.7 7.09L5 22l3.79-1.98c1.08.3 2.22.46 3.41.46 5.52 0 10-4.13 10-9.06S17.52 2 12 2zm.55 11.96l-2.6-2.77-5.05 2.77L10.4 8.5l2.67 2.77 4.98-2.72-5.5 5.41z"
							/>
						</svg>
					</div>
					<div class="min-w-0 flex-1">
						<p class="font-medium text-sky-950">Join the Print Studio community</p>
						<p class="mt-1 text-sm leading-relaxed text-sky-900/90">
							Get updates, printing tips, and support in our official Messenger group.
						</p>
						<Button
							href={MESSENGER_COMMUNITY_URL}
							target="_blank"
							rel="noopener noreferrer"
							size="sm"
							class="mt-2.5 bg-sky-600 hover:bg-sky-700"
						>
							Join on Messenger
						</Button>
					</div>
					<Button
						variant="ghost"
						size="icon"
						class="size-8 shrink-0 text-sky-700/70 hover:bg-sky-100 hover:text-sky-900"
						aria-label="Dismiss community invite"
						onclick={dismissCommunityInviteAlert}
					>
						<svg
							xmlns="http://www.w3.org/2000/svg"
							class="size-4"
							fill="none"
							viewBox="0 0 24 24"
							stroke="currentColor"
							stroke-width="2"
							stroke-linecap="round"
							stroke-linejoin="round"
							aria-hidden="true"
						>
							<path d="M18 6 6 18" />
							<path d="m6 6 12 12" />
						</svg>
					</Button>
				</div>
			</div>
		{/if}

		<div id="designer-grid" class="grid grid-cols-2 gap-4 sm:gap-5 lg:grid-cols-5">
			{#each sortedDesigners as designer (designer.id)}
				<!-- svelte-ignore a11y_click_events_have_key_events -->
				<!-- svelte-ignore a11y_no_static_element_interactions -->
				<div
					class="group relative overflow-hidden rounded-xl border bg-white shadow-sm transition sm:rounded-2xl {isUnderMaintenance(
						designer.id
					)
						? 'cursor-not-allowed border-slate-200 opacity-60'
						: isComingSoonDesigner(designer.id)
							? 'cursor-not-allowed border-slate-200'
							: isSubscriberLocked(designer.id)
								? 'cursor-not-allowed border-slate-200 opacity-75'
								: isNewDesigner(designer.id)
								? 'cursor-pointer border-emerald-300 ring-2 ring-emerald-200/70 hover:-translate-y-1 hover:border-emerald-400 hover:shadow-lg'
								: isUpdatedDesigner(designer.id)
									? 'cursor-pointer border-indigo-300 ring-2 ring-indigo-200/70 hover:-translate-y-1 hover:border-indigo-400 hover:shadow-lg'
									: 'cursor-pointer border-slate-200 hover:-translate-y-1 hover:border-indigo-300 hover:shadow-lg'}"
					onclick={() => handleCardClick(designer)}
				>
					{#if isComingSoonDesigner(designer.id)}
						<span
							class="pointer-events-none absolute top-2 right-2 z-20 rounded bg-slate-900/80 px-1.5 py-0.5 text-[10px] font-medium text-white sm:top-3 sm:right-3 sm:rounded-md sm:px-2 sm:text-xs"
							>Coming soon</span
						>

					{/if}
					{#if isSubscriberLocked(designer.id)}
						<span
							class="pointer-events-none absolute top-2 right-2 z-20 inline-flex items-center gap-0.5 rounded bg-emerald-900/85 px-1.5 py-0.5 text-[10px] font-medium text-white sm:top-3 sm:right-3 sm:rounded-md sm:px-2 sm:text-xs"
							>Subscribe</span
						>
					{/if}
					{#if isUnderMaintenance(designer.id)}
						<span
							class="absolute top-2 right-2 z-10 rounded bg-slate-200 px-1.5 py-0.5 text-[10px] font-medium text-slate-600 sm:top-3 sm:right-3 sm:rounded-md sm:px-2 sm:text-xs"
							>Maintenance</span
						>
					{/if}
					{#if isNewDesigner(designer.id)}
						<span
							class="absolute top-2 left-2 z-10 rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-semibold tracking-wide text-emerald-800 sm:top-3 sm:left-3 sm:rounded-md sm:px-2 sm:text-xs"
							>New</span
						>
					{/if}
					{#if isUpdatedDesigner(designer.id)}
						<div class="group/updated absolute top-2 left-2 z-20 sm:top-3 sm:left-3">
							<span
								class="inline-flex cursor-help items-center gap-1 rounded bg-indigo-100 px-1.5 py-0.5 text-[10px] font-semibold tracking-wide text-indigo-800 sm:rounded-md sm:px-2 sm:text-xs"
								title={getUpdateNote(designer.id)}
							>
								<svg
									xmlns="http://www.w3.org/2000/svg"
									viewBox="0 0 24 24"
									fill="none"
									stroke="currentColor"
									stroke-width="2.5"
									stroke-linecap="round"
									stroke-linejoin="round"
									class="size-2.5 sm:size-3"
									aria-hidden="true"
								>
									<polyline points="23 4 23 10 17 10" />
									<path d="M20.49 15A9 9 0 1 1 5.64 5.64L23 10" />
								</svg>
								Updated
							</span>
							<div
								class="pointer-events-none absolute top-full left-0 mt-1 w-36 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-[10px] leading-snug text-slate-700 opacity-0 shadow-lg transition-opacity duration-150 group-hover/updated:opacity-100 sm:w-44 sm:text-xs"
								role="tooltip"
							>
								<p class="mb-0.5 font-semibold text-indigo-700">What's new</p>
								{getUpdateNote(designer.id)}
							</div>
						</div>
					{/if}
					{#if isBetaDesigner(designer.id)}
						<span
							class="absolute left-2 z-10 rounded bg-sky-100 px-1.5 py-0.5 text-[10px] font-medium text-sky-800 sm:left-3 sm:rounded-md sm:px-2 sm:text-xs {isNewDesigner(
								designer.id
							) || isUpdatedDesigner(designer.id)
								? 'top-8 sm:top-10'
								: 'top-2 sm:top-3'}">Beta</span
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
									: isComingSoonDesigner(designer.id)
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
					<div class="relative">
						<div
							class="aspect-4/3 w-full overflow-hidden rounded-t-xl bg-slate-100 sm:rounded-t-2xl {isComingSoonDesigner(
								designer.id
							)
								? 'opacity-60'
								: ''}"
						>
							<img
								src={designer.imageSrc}
								alt={designer.imageAlt}
								class="h-full w-full object-cover transition {isUnderMaintenance(designer.id) ||
								isComingSoonDesigner(designer.id)
									? ''
									: 'group-hover:scale-105'}"
							/>
						</div>
						<Button
							variant="ghost"
							size="icon"
							class="pointer-events-auto absolute right-2 bottom-2 z-30 size-8 rounded-full border bg-white shadow-md ring-2 ring-white/90 sm:right-3 sm:bottom-3 sm:size-9 {isFavoriteDesigner(
								designer.id
							)
								? 'border-amber-300 text-amber-500 hover:bg-amber-50 hover:text-amber-600'
								: 'border-slate-200/90 text-slate-400 hover:bg-white hover:text-amber-500'}"
							title={isFavoriteDesigner(designer.id)
								? 'Remove from favorites'
								: 'Favorite — pin to top of list'}
							aria-label={isFavoriteDesigner(designer.id)
								? 'Remove from favorites'
								: 'Favorite designer'}
							aria-pressed={isFavoriteDesigner(designer.id)}
							onclick={(e) => {
								e.stopPropagation();
								const wasFavorite = isFavoriteDesigner(designer.id);
								void toggleFavoriteDesigner(designer.id);
								notifyFavoriteAction({
									designerId: designer.id,
									designerTitle: designer.title,
									action: wasFavorite ? 'removed' : 'added',
									email: user?.email,
									userId: user?.id,
									subscriptionStatus
								});
							}}
						>
							<svg
								xmlns="http://www.w3.org/2000/svg"
								class="size-4"
								viewBox="0 0 24 24"
								fill={isFavoriteDesigner(designer.id) ? 'currentColor' : 'none'}
								stroke="currentColor"
								stroke-width="2"
								stroke-linecap="round"
								stroke-linejoin="round"
								aria-hidden="true"
							>
								<polygon
									points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"
								/>
							</svg>
						</Button>
						{#if isComingSoonDesigner(designer.id)}
							<Button
								variant="ghost"
								size="icon"
								class="pointer-events-auto absolute bottom-2 left-2 z-30 size-8 cursor-pointer rounded-full border border-rose-200 bg-white text-rose-500 opacity-100 shadow-md ring-2 ring-white/90 hover:bg-rose-50 hover:text-rose-600 disabled:pointer-events-none disabled:opacity-100 sm:bottom-3 sm:left-3 sm:size-9 {isComingSoonInterestDone(
									designer.id
								)
									? 'border-emerald-200 bg-white text-emerald-600 hover:bg-emerald-50 hover:text-emerald-700'
									: ''}"
								title={isComingSoonInterestDone(designer.id)
									? 'Thanks — we noted your interest'
									: "I'm interested — notify the team"}
								aria-label={isComingSoonInterestDone(designer.id)
									? 'Interest recorded'
									: 'Register interest in this designer'}
								aria-disabled={isComingSoonInterestDone(designer.id)}
								disabled={comingSoonInterestSending === designer.id}
								onclick={(e) => {
									if (isComingSoonInterestDone(designer.id)) return;
									void handleComingSoonInterest(designer, e);
								}}
							>
								{#if comingSoonInterestSending === designer.id}
									<svg
										class="size-4 animate-spin text-slate-400"
										xmlns="http://www.w3.org/2000/svg"
										fill="none"
										viewBox="0 0 24 24"
										aria-hidden="true"
									>
										<circle
											class="opacity-25"
											cx="12"
											cy="12"
											r="10"
											stroke="currentColor"
											stroke-width="4"
										/>
										<path
											class="opacity-75"
											fill="currentColor"
											d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
										/>
									</svg>
								{:else if isComingSoonInterestDone(designer.id)}
									<svg
										xmlns="http://www.w3.org/2000/svg"
										class="size-4"
										fill="none"
										viewBox="0 0 24 24"
										stroke-width="2"
										stroke="currentColor"
										aria-hidden="true"
									>
										<path
											stroke-linecap="round"
											stroke-linejoin="round"
											d="M4.5 12.75l6 6 9-13.5"
										/>
									</svg>
								{:else}
									<svg
										xmlns="http://www.w3.org/2000/svg"
										class="size-4"
										viewBox="0 0 24 24"
										fill="currentColor"
										aria-hidden="true"
									>
										<path
											d="M20.84 4.61a5.5 5.5 0 00-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 00-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 000-7.78z"
										/>
									</svg>
								{/if}
							</Button>
						{/if}
					</div>
					<div
						class="p-2.5 sm:p-5 {isComingSoonDesigner(designer.id) ? 'pointer-events-none opacity-60' : ''}"
					>
						<h2 class="text-sm font-semibold text-slate-900 sm:text-lg">
							{designer.title}
						</h2>
						<p
							class="mt-0.5 line-clamp-2 text-xs leading-snug text-slate-500 sm:mt-1 sm:line-clamp-none sm:text-sm"
						>
							{designer.description}
						</p>
						{#if exportStats.loaded && getDesignerExportCount(designer.id) > 0}
							<p class="mt-1 text-[10px] font-medium text-slate-400 sm:text-xs">
								{formatExportCount(getDesignerExportCount(designer.id))} exports
							</p>
						{/if}
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
			<Button
				href="https://m.me/pixnprints.shop"
				target="_blank"
				rel="noopener noreferrer"
				class="mt-3"
			>
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
				<a
					href="#contact"
					class="rounded underline hover:text-slate-700 focus:ring-2 focus:ring-indigo-500/30 focus:outline-none"
				>
					Contact
				</a>
			</div>
		</div>
	</div>
</div>

<PickleballKeychainFeatureDialog
	open={pickleballKeychainFeatureDialogOpen}
	onOpenChange={onPickleballKeychainFeatureDialogOpenChange}
	onTryIt={tryPickleballKeychainFromDialog}
/>

<NewFontsFeatureDialog
	open={newFontsFeatureDialogOpen}
	onOpenChange={onNewFontsFeatureDialogOpenChange}
	onTryIt={tryNewFontsFromDialog}
	{subscriptionStatus}
/>

<FavoriteDesignersFeatureDialog
	open={favoriteFeatureDialogOpen}
	onOpenChange={onFavoriteFeatureDialogOpenChange}
	onTryIt={tryFavoriteFeatureFromDialog}
/>
