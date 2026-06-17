import type { DesignerId } from '$lib/designers/ids';
import { resolveDesignerId } from '$lib/designers/ids';

/** Maps `designName` strings used in export notify calls to route designer ids. */
const DESIGN_NAME_TO_ID: Record<string, DesignerId> = {
	'Standalone Name': 'standaloneName',
	'Layered Monogram': 'layeredMonogram',
	'Monogram Insert': 'monogramInsert',
	'Classic Name Tag': 'classicNameTag',
	'ID Name Tag': 'idNameTag',
	'ID Name Tag v2': 'idNameTagV2',
	'Custom SVG': 'customSvg',
	'Chunky Charm': 'chunkyCharm',
	'Keycap Maker': 'keycapMaker',
	'Keycap Set Maker': 'keycapSetMaker',
	'Personalized Whistle': 'classicWhistle',
	'Multicolor Whistle': 'multicolorWhistle',
	'Whistle Bag Tag': 'whistleBagTag',
	'Stanley Topper': 'stanleyTopper',
	'Straw Name Clip': 'strawNameClip',
	'Pencil Name Sleeve': 'pencilNameSleeve',
	'Dog Tag': 'dogtag',
	'Bumpy Text': 'bumpyText',
	'Ribbon Bow': 'ribbonBow',
	'Pickleball': 'pickleball',
	'HoopTag': 'hoopTag',
	'Articulated': 'articulated',
	'Spotify Code': 'spotifyCode',
	'QR Code Maker': 'qrCodeMaker',
	'Name Puzzle': 'namePuzzle',
	'Engrave Name Plate': 'engraveNamePlate',
	'Cake Topper': 'cakeTopper',
	'Freeform Design Canvas': 'freeformDesignCanvas',
	'Motorcycle Plate Bar': 'motorcyclePlateBar',
	'Address Number Sign': 'addressNumberSign',
	'Door Name Plaque': 'doorNamePlaque',
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
