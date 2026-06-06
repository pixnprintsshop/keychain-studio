/** Designer route ids only — safe to import from SSR param matchers (no Three.js). */

export type DesignerId =
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
	| 'namePuzzle'
	| 'engraveNamePlate'
	| 'cakeTopper'
	| 'canvasStudio'
	| 'plateBadge'
	| 'articulatedKeychain'
	| 'spotifyKeychain'
	| 'houseNumberPlaque';

export const DESIGNER_IDS: readonly DesignerId[] = [
	'textOutline',
	'initial',
	'flower',
	'basicName',
	'idNameTag',
	'idNameTagV2',
	'customSvg',
	'charm',
	'keycap',
	'keycapSet',
	'whistle',
	'whistleV2',
	'whistleBagTag',
	'stanleyTopper',
	'strawTopper',
	'pencilTopper',
	'dogtag',
	'bumpyText',
	'bowKeychain',
	'namePuzzle',
	'engraveNamePlate',
	'cakeTopper',
	'canvasStudio',
	'plateBadge',
	'articulatedKeychain',
	'spotifyKeychain',
	'houseNumberPlaque'
] as const;

export function isDesignerId(value: string): value is DesignerId {
	return (DESIGNER_IDS as readonly string[]).includes(value);
}

export function designerPath(id: DesignerId): string {
	return `/${id}`;
}

/** First path segment when it is a designer route (e.g. `/basicName` → `basicName`). */
export function designerIdFromPathname(pathname: string): DesignerId | null {
	const segment = pathname.replace(/^\//, '').split('/').filter(Boolean)[0];
	return segment && isDesignerId(segment) ? segment : null;
}
