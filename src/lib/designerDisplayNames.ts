import type { DesignerId } from '$lib/designers/ids';
import { isDesignerId } from '$lib/designers/ids';

/** Human-readable designer titles for export activity feed. */
const DESIGNER_DISPLAY_NAMES: Record<DesignerId, string> = {
	standaloneNameKeychain: 'Standalone Name Keychain',
	layeredMonogram: 'Layered Monogram',
	monogramInsert: 'Monogram Insert',
	flower: 'Flower + Initial',
	classicNameTagKeychain: 'Classic Name Tag Keychain',
	idNameTag: 'ID Name Tag',
	idNameTagV2: 'ID Name Tag v2',
	customSvg: 'Custom SVG',
	charm: 'Chunky Charm',
	keycap: 'Keycap Maker',
	keycapSet: 'Keycap Set Maker',
	whistleKeychain: 'Personalized Whistle Keychain',
	multicolorWhistleKeychain: 'Multicolor Whistle Keychain',
	whistleBagTag: 'Whistle Bag Tag',
	stanleyTopper: 'Stanley Topper',
	strawNameClip: 'Straw Name Clip',
	pencilNameSleeve: 'Pencil Name Sleeve',
	dogtag: 'Dog Tag',
	bumpyText: 'Bumpy Text',
	ribbonBowKeychain: 'Ribbon Bow Keychain',
	pickleballKeychain: 'Pickleball keychain',
	hoopTag: 'HoopTag',
	articulatedKeychain: 'Articulated Keychain',
	spotifyCodeKeychain: 'Spotify Code Keychain',
	qrCodeMaker: 'QR Code Maker',
	namePuzzle: 'Name Puzzle',
	engraveNamePlate: 'Engrave Name Plate',
	cakeTopper: 'Cake Topper',
	freeformDesignCanvas: 'Freeform Design Canvas',
	motorcyclePlateBar: 'Motorcycle Plate Bar',
	addressNumberSign: 'Address Number Sign',
	doorNamePlaque: 'Door Name Plaque'
};

export function getDesignerDisplayName(designerId: string | null | undefined): string {
	if (designerId && isDesignerId(designerId)) {
		return DESIGNER_DISPLAY_NAMES[designerId];
	}
	return 'A design';
}

export type ExportFormat = 'stl' | '3mf' | 'bambu_studio';

export function formatExportFormatLabel(format: string): string {
	switch (format) {
		case '3mf':
			return '3MF';
		case 'bambu_studio':
			return 'Bambu Studio';
		default:
			return 'STL';
	}
}
