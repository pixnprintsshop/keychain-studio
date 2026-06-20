import type { DesignerId } from '$lib/designers/ids';
import { isDesignerId } from '$lib/designers/ids';

/** Human-readable designer titles for export activity feed. */
const DESIGNER_DISPLAY_NAMES: Record<DesignerId, string> = {
	standaloneName: 'Standalone Name',
	layeredMonogram: 'Layered Monogram',
	letterRail: 'Letter Rail',
	monogramInsert: 'Monogram Insert',
	floralInitial: 'Floral Initial',
	classicNameTag: 'Classic Name Tag',
	idNameTag: 'ID Name Tag',
	idNameTagV2: 'ID Name Tag v2',
	customSvg: 'Custom SVG',
	chunkyCharm: 'Chunky Charm',
	keycapMaker: 'Keycap Maker',
	keycapSetMaker: 'Keycap Set Maker',
	classicWhistle: 'Personalized Whistle',
	multicolorWhistle: 'Multicolor Whistle',
	whistleBagTag: 'Whistle Bag Tag',
	stanleyTopper: 'Stanley Topper',
	strawNameClip: 'Straw Name Clip',
	pencilNameSleeve: 'Pencil Name Sleeve',
	dogtag: 'Dog Tag',
	bumpyText: 'Bumpy Text',
	ribbonBow: 'Ribbon Bow',
	pickleball: 'Pickleball',
	hoopTag: 'HoopTag',
	articulated: 'Articulated',
	spotifyCode: 'Spotify Code',
	qrCodeMaker: 'QR Code Maker',
	namePuzzle: 'Name Puzzle',
	engraveNamePlate: 'Engrave Name Plate',
	cakeTopper: 'Cake Topper',
	freeformDesignCanvas: 'Freeform Design Canvas',
	motorcyclePlateBar: 'Motorcycle Plate Bar',
	addressNumberSign: 'Address Number Sign',
	doorNamePlaque: 'Door Name Plaque',
	textBlocks: 'Text Blocks'
};

const DISPLAY_NAME_TO_ID = Object.fromEntries(
	Object.entries(DESIGNER_DISPLAY_NAMES).map(([id, name]) => [name, id])
) as Record<string, DesignerId>;

export function getDesignerDisplayName(designerId: string | null | undefined): string {
	if (designerId && isDesignerId(designerId)) {
		return DESIGNER_DISPLAY_NAMES[designerId];
	}
	return 'A design';
}

export function getDesignerIdFromDisplayName(name: string): DesignerId | null {
	const id = DISPLAY_NAME_TO_ID[name.trim()];
	return id ?? null;
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
