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
	standaloneName: () => import('$lib/components/TextOutlineDesigner.svelte'),
	layeredMonogram: () => import('$lib/components/InitialDesigner.svelte'),
	monogramInsert: () => import('$lib/components/InitialAndNameDesigner.svelte'),
	floralInitial: () => import('$lib/components/FlowerDesigner.svelte'),
	classicNameTag: () => import('$lib/components/BasicNameDesigner.svelte'),
	idNameTag: () => import('$lib/components/IdNameTagDesigner.svelte'),
	idNameTagV2: () => import('$lib/components/IdNameTagV2Designer.svelte'),
	customSvg: () => import('$lib/components/CustomSVGDesigner.svelte'),
	chunkyCharm: () => import('$lib/components/CharmDesigner.svelte'),
	keycapMaker: () => import('$lib/components/KeycapDesigner.svelte'),
	keycapSetMaker: () => import('$lib/components/KeycapSetMakerDesigner.svelte'),
	classicWhistle: () => import('$lib/components/WhistleDesigner.svelte'),
	multicolorWhistle: () => import('$lib/components/WhistleV2Designer.svelte'),
	whistleBagTag: () => import('$lib/components/WhistleBagTagDesigner.svelte'),
	stanleyTopper: () => import('$lib/components/StanleyTopperDesigner.svelte'),
	strawNameClip: () => import('$lib/components/StrawTopperDesigner.svelte'),
	pencilNameSleeve: () => import('$lib/components/PencilTopperDesigner.svelte'),
	dogtag: () => import('$lib/components/DogTagDesigner.svelte'),
	bumpyText: () => import('$lib/components/BumpyTextDesigner.svelte'),
	ribbonBow: () => import('$lib/components/BowKeychainDesigner.svelte'),
	pickleball: () => import('$lib/components/PickleballKeychainDesigner.svelte'),
	hoopTag: () => import('$lib/components/HoopTagDesigner.svelte'),
	namePuzzle: () => import('$lib/components/NamePuzzleDesigner.svelte'),
	engraveNamePlate: () => import('$lib/components/EngraveNamePlateDesigner.svelte'),
	cakeTopper: () => import('$lib/components/CakeTopperDesigner.svelte'),
	freeformDesignCanvas: () => import('$lib/components/CanvasStudioDesigner.svelte'),
	motorcyclePlateBar: () => import('$lib/components/PlateBadgeDesigner.svelte'),
	articulated: () => import('$lib/components/ArticulatedKeychainDesigner.svelte'),
	spotifyCode: () => import('$lib/components/SpotifyKeychainDesigner.svelte'),
	qrCodeMaker: () => import('$lib/components/QrCodeMakerDesigner.svelte'),
	addressNumberSign: () => import('$lib/components/HouseNumberPlaqueDesigner.svelte'),
	doorNamePlaque: () => import('$lib/components/RoomSignDesigner.svelte')
};

const componentCache = new Map<DesignerId, Promise<DesignerComponent>>();

export function loadDesignerComponent(id: DesignerId): Promise<DesignerComponent> {
	const cached = componentCache.get(id);
	if (cached) return cached;
	const promise = LOADERS[id]().then((m) => m.default);
	componentCache.set(id, promise);
	return promise;
}
