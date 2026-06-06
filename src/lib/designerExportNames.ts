import type { DesignerId } from '$lib/designers/ids';
import { isDesignerId } from '$lib/designers/ids';

/** Maps `designName` strings used in export notify calls to route designer ids. */
const DESIGN_NAME_TO_ID: Record<string, DesignerId> = {
	'Text Only': 'textOutline',
	'Text & Initial': 'initial',
	'Flower + Initial': 'flower',
	Flower: 'flower',
	'Basic Name Tag': 'basicName',
	'ID Name Tag': 'idNameTag',
	'ID Name Tag v2': 'idNameTagV2',
	'Custom SVG': 'customSvg',
	'Chunky Charm': 'charm',
	'Keycap Maker': 'keycap',
	'Keycap Set Maker': 'keycapSet',
	'Custom Whistle': 'whistle',
	'Whistle v2': 'whistleV2',
	'Whistle Bag Tag': 'whistleBagTag',
	'Stanley Topper': 'stanleyTopper',
	'Straw Topper': 'strawTopper',
	'Pencil Topper': 'pencilTopper',
	'Dog Tag': 'dogtag',
	'Bumpy Text': 'bumpyText',
	'Bow Keychain': 'bowKeychain',
	'Articulated Keychain': 'articulatedKeychain',
	'Spotify Keychain': 'spotifyKeychain',
	'Name Puzzle': 'namePuzzle',
	'Puzzle Pieces A–Z': 'namePuzzle',
	'Engrave Name Plate': 'engraveNamePlate',
	'Cake Topper': 'cakeTopper',
	'Canvas Studio': 'canvasStudio',
	'Plate badge': 'plateBadge',
	'House Number Plaque': 'houseNumberPlaque'
};

export function resolveDesignerIdForExport(
	designName: string,
	explicitId?: string | null
): DesignerId | null {
	if (explicitId && isDesignerId(explicitId)) return explicitId;
	const trimmed = designName.trim();
	return DESIGN_NAME_TO_ID[trimmed] ?? null;
}
