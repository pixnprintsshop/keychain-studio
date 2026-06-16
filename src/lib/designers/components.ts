import type { Component } from 'svelte';
import type { DesignerId } from '$lib/designers/ids';

export type DesignerComponent = Component<
	{
		user: import('@supabase/supabase-js').User | null;
		session: import('@supabase/supabase-js').Session | null;
		subscriptionStatus: import('$lib/subscription').SubscriptionStatus | null;
		palette: import('$lib/colorPalette').PaletteColor[];
		onBack: () => void;
		onRequestLogin: () => void;
		onShowThankYou: () => void;
		onShowPricing?: () => void;
	}
>;

type DesignerModule = { default: DesignerComponent };

const LOADERS: Record<DesignerId, () => Promise<DesignerModule>> = {
	textOutline: () => import('$lib/components/TextOutlineDesigner.svelte'),
	initial: () => import('$lib/components/InitialDesigner.svelte'),
	monogramInsert: () => import('$lib/components/InitialAndNameDesigner.svelte'),
	flower: () => import('$lib/components/FlowerDesigner.svelte'),
	basicName: () => import('$lib/components/BasicNameDesigner.svelte'),
	idNameTag: () => import('$lib/components/IdNameTagDesigner.svelte'),
	idNameTagV2: () => import('$lib/components/IdNameTagV2Designer.svelte'),
	customSvg: () => import('$lib/components/CustomSVGDesigner.svelte'),
	charm: () => import('$lib/components/CharmDesigner.svelte'),
	keycap: () => import('$lib/components/KeycapDesigner.svelte'),
	keycapSet: () => import('$lib/components/KeycapSetMakerDesigner.svelte'),
	whistle: () => import('$lib/components/WhistleDesigner.svelte'),
	whistleV2: () => import('$lib/components/WhistleV2Designer.svelte'),
	whistleBagTag: () => import('$lib/components/WhistleBagTagDesigner.svelte'),
	stanleyTopper: () => import('$lib/components/StanleyTopperDesigner.svelte'),
	strawTopper: () => import('$lib/components/StrawTopperDesigner.svelte'),
	pencilTopper: () => import('$lib/components/PencilTopperDesigner.svelte'),
	dogtag: () => import('$lib/components/DogTagDesigner.svelte'),
	bumpyText: () => import('$lib/components/BumpyTextDesigner.svelte'),
	bowKeychain: () => import('$lib/components/BowKeychainDesigner.svelte'),
	pickleballKeychain: () => import('$lib/components/PickleballKeychainDesigner.svelte'),
	hoopTag: () => import('$lib/components/HoopTagDesigner.svelte'),
	namePuzzle: () => import('$lib/components/NamePuzzleDesigner.svelte'),
	engraveNamePlate: () => import('$lib/components/EngraveNamePlateDesigner.svelte'),
	cakeTopper: () => import('$lib/components/CakeTopperDesigner.svelte'),
	canvasStudio: () => import('$lib/components/CanvasStudioDesigner.svelte'),
	plateBadge: () => import('$lib/components/PlateBadgeDesigner.svelte'),
	articulatedKeychain: () => import('$lib/components/ArticulatedKeychainDesigner.svelte'),
	spotifyKeychain: () => import('$lib/components/SpotifyKeychainDesigner.svelte'),
	houseNumberPlaque: () => import('$lib/components/HouseNumberPlaqueDesigner.svelte'),
	roomSign: () => import('$lib/components/RoomSignDesigner.svelte')
};

const componentCache = new Map<DesignerId, Promise<DesignerComponent>>();

export function loadDesignerComponent(id: DesignerId): Promise<DesignerComponent> {
	const cached = componentCache.get(id);
	if (cached) return cached;
	const promise = LOADERS[id]().then((m) => m.default);
	componentCache.set(id, promise);
	return promise;
}
