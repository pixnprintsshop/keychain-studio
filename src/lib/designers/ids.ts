/** Designer route ids only — safe to import from SSR param matchers (no Three.js). */

export type DesignerId =
	| 'standaloneName'
	| 'layeredMonogram'
	| 'monogramInsert'
	| 'floralInitial'
	| 'classicNameTag'
	| 'idNameTag'
	| 'idNameTagV2'
	| 'customSvg'
	| 'chunkyCharm'
	| 'keycapMaker'
	| 'keycapSetMaker'
	| 'classicWhistle'
	| 'multicolorWhistle'
	| 'whistleBagTag'
	| 'stanleyTopper'
	| 'strawNameClip'
	| 'pencilNameSleeve'
	| 'dogtag'
	| 'bumpyText'
	| 'ribbonBow'
	| 'pickleball'
	| 'hoopTag'
	| 'namePuzzle'
	| 'engraveNamePlate'
	| 'cakeTopper'
	| 'freeformDesignCanvas'
	| 'motorcyclePlateBar'
	| 'articulated'
	| 'spotifyCode'
	| 'qrCodeMaker'
	| 'addressNumberSign'
	| 'doorNamePlaque'
	| 'textBlocks';

export const DESIGNER_IDS: readonly DesignerId[] = [
	'standaloneName',
	'layeredMonogram',
	'monogramInsert',
	'floralInitial',
	'classicNameTag',
	'idNameTag',
	'idNameTagV2',
	'customSvg',
	'chunkyCharm',
	'keycapMaker',
	'keycapSetMaker',
	'classicWhistle',
	'multicolorWhistle',
	'whistleBagTag',
	'stanleyTopper',
	'strawNameClip',
	'pencilNameSleeve',
	'dogtag',
	'bumpyText',
	'ribbonBow',
	'pickleball',
	'hoopTag',
	'namePuzzle',
	'engraveNamePlate',
	'cakeTopper',
	'freeformDesignCanvas',
	'motorcyclePlateBar',
	'articulated',
	'spotifyCode',
	'qrCodeMaker',
	'addressNumberSign',
	'doorNamePlaque',
	'textBlocks'
] as const;

export function isDesignerId(value: string): value is DesignerId {
	return (DESIGNER_IDS as readonly string[]).includes(value);
}

export function resolveDesignerId(value: string): DesignerId | null {
	return isDesignerId(value) ? value : null;
}

export function designerPath(id: DesignerId): string {
	return `/${id}`;
}

/** First path segment when it is a designer route. */
export function designerIdFromPathname(pathname: string): DesignerId | null {
	const segment = pathname.replace(/^\//, '').split('/').filter(Boolean)[0];
	if (!segment) return null;
	return resolveDesignerId(segment);
}
