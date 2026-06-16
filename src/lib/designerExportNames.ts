import type { DesignerId } from '$lib/designers/ids';
import { isDesignerId, resolveDesignerId } from '$lib/designers/ids';

/** Maps `designName` strings used in export notify calls to route designer ids. */
const DESIGN_NAME_TO_ID: Record<string, DesignerId> = {
	'Standalone Name Keychain': 'standaloneNameKeychain',
	'Text Only': 'standaloneNameKeychain',
	'Layered Monogram': 'layeredMonogram',
	'Text & Initial': 'layeredMonogram',
	'Monogram Insert': 'monogramInsert',
	'Flower + Initial': 'flower',
	Flower: 'flower',
	'Classic Name Tag Keychain': 'classicNameTagKeychain',
	'Basic Name Tag': 'classicNameTagKeychain',
	'ID Name Tag': 'idNameTag',
	'ID Name Tag v2': 'idNameTagV2',
	'Custom SVG': 'customSvg',
	'Chunky Charm': 'charm',
	'Keycap Maker': 'keycap',
	'Keycap Set Maker': 'keycapSet',
	'Personalized Whistle Keychain': 'whistleKeychain',
	'Custom Whistle': 'whistleKeychain',
	'Multicolor Whistle Keychain': 'multicolorWhistleKeychain',
	'Whistle v2': 'multicolorWhistleKeychain',
	'Whistle Bag Tag': 'whistleBagTag',
	'Stanley Topper': 'stanleyTopper',
	'Straw Name Clip': 'strawNameClip',
	'Straw Topper': 'strawNameClip',
	'Pencil Name Sleeve': 'pencilNameSleeve',
	'Pencil Topper': 'pencilNameSleeve',
	'Dog Tag': 'dogtag',
	'Bumpy Text': 'bumpyText',
	'Ribbon Bow Keychain': 'ribbonBowKeychain',
	'Bow Keychain': 'ribbonBowKeychain',
	'Pickleball keychain': 'pickleballKeychain',
	HoopTag: 'hoopTag',
	'Articulated Keychain': 'articulatedKeychain',
	'Spotify Code Keychain': 'spotifyCodeKeychain',
	'Spotify Keychain': 'spotifyCodeKeychain',
	'QR Code Maker': 'qrCodeMaker',
	'Name Puzzle': 'namePuzzle',
	'Puzzle Pieces A–Z': 'namePuzzle',
	'Engrave Name Plate': 'engraveNamePlate',
	'Cake Topper': 'cakeTopper',
	'Freeform Design Canvas': 'freeformDesignCanvas',
	'Canvas Studio': 'freeformDesignCanvas',
	'Motorcycle Plate Bar': 'motorcyclePlateBar',
	'Plate badge': 'motorcyclePlateBar',
	'Address Number Sign': 'addressNumberSign',
	'House Number Plaque': 'addressNumberSign',
	'Door Name Plaque': 'doorNamePlaque',
	'Room Sign': 'doorNamePlaque'
};

export function resolveDesignerIdForExport(
	designName: string,
	explicitId?: string | null
): DesignerId | null {
	if (explicitId) {
		const resolved = resolveDesignerId(explicitId);
		if (resolved) return resolved;
	}
	const trimmed = designName.trim();
	return DESIGN_NAME_TO_ID[trimmed] ?? null;
}
