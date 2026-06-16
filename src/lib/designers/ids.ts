/** Designer route ids only — safe to import from SSR param matchers (no Three.js). */

export type DesignerId =
	| 'standaloneNameKeychain'
	| 'layeredMonogram'
	| 'monogramInsert'
	| 'flower'
	| 'classicNameTagKeychain'
	| 'idNameTag'
	| 'idNameTagV2'
	| 'customSvg'
	| 'charm'
	| 'keycap'
	| 'keycapSet'
	| 'whistleKeychain'
	| 'multicolorWhistleKeychain'
	| 'whistleBagTag'
	| 'stanleyTopper'
	| 'strawNameClip'
	| 'pencilNameSleeve'
	| 'dogtag'
	| 'bumpyText'
	| 'ribbonBowKeychain'
	| 'pickleballKeychain'
	| 'hoopTag'
	| 'namePuzzle'
	| 'engraveNamePlate'
	| 'cakeTopper'
	| 'freeformDesignCanvas'
	| 'motorcyclePlateBar'
	| 'articulatedKeychain'
	| 'spotifyCodeKeychain'
	| 'addressNumberSign'
	| 'doorNamePlaque';

export const DESIGNER_IDS: readonly DesignerId[] = [
	'standaloneNameKeychain',
	'layeredMonogram',
	'monogramInsert',
	'flower',
	'classicNameTagKeychain',
	'idNameTag',
	'idNameTagV2',
	'customSvg',
	'charm',
	'keycap',
	'keycapSet',
	'whistleKeychain',
	'multicolorWhistleKeychain',
	'whistleBagTag',
	'stanleyTopper',
	'strawNameClip',
	'pencilNameSleeve',
	'dogtag',
	'bumpyText',
	'ribbonBowKeychain',
	'pickleballKeychain',
	'hoopTag',
	'namePuzzle',
	'engraveNamePlate',
	'cakeTopper',
	'freeformDesignCanvas',
	'motorcyclePlateBar',
	'articulatedKeychain',
	'spotifyCodeKeychain',
	'addressNumberSign',
	'doorNamePlaque'
] as const;

/** Previous route ids → current ids (bookmarks, favorites, preset rows). */
export const LEGACY_DESIGNER_ID_ALIASES: Record<string, DesignerId> = {
	textOutline: 'standaloneNameKeychain',
	initial: 'layeredMonogram',
	initialAndName: 'monogramInsert',
	basicName: 'classicNameTagKeychain',
	bowKeychain: 'ribbonBowKeychain',
	pencilTopper: 'pencilNameSleeve',
	houseNumberPlaque: 'addressNumberSign',
	roomSign: 'doorNamePlaque',
	strawTopper: 'strawNameClip',
	whistle: 'whistleKeychain',
	whistleV2: 'multicolorWhistleKeychain',
	plateBadge: 'motorcyclePlateBar',
	canvasStudio: 'freeformDesignCanvas',
	spotifyKeychain: 'spotifyCodeKeychain'
};

export function isDesignerId(value: string): value is DesignerId {
	return (DESIGNER_IDS as readonly string[]).includes(value);
}

export function resolveDesignerId(value: string): DesignerId | null {
	if (isDesignerId(value)) return value;
	return LEGACY_DESIGNER_ID_ALIASES[value] ?? null;
}

export function designerPath(id: DesignerId): string {
	return `/${id}`;
}

/** First path segment when it is a designer route (legacy aliases resolve to current ids). */
export function designerIdFromPathname(pathname: string): DesignerId | null {
	const segment = pathname.replace(/^\//, '').split('/').filter(Boolean)[0];
	if (!segment) return null;
	return resolveDesignerId(segment);
}
