import type { DesignerId } from '$lib/designers/ids';
import { isDesignerId } from '$lib/designers/ids';

/** Human-readable designer titles for export activity feed. */
const DESIGNER_DISPLAY_NAMES: Record<DesignerId, string> = {
	textOutline: 'Text Only',
	initial: 'Text & Initial',
	monogramInsert: 'Monogram Insert',
	flower: 'Flower + Initial',
	basicName: 'Basic Name Tag',
	idNameTag: 'ID Name Tag',
	idNameTagV2: 'ID Name Tag v2',
	customSvg: 'Custom SVG',
	charm: 'Chunky Charm',
	keycap: 'Keycap Maker',
	keycapSet: 'Keycap Set Maker',
	whistle: 'Custom Whistle',
	whistleV2: 'Whistle v2',
	whistleBagTag: 'Whistle Bag Tag',
	stanleyTopper: 'Stanley Topper',
	strawTopper: 'Straw Topper',
	pencilTopper: 'Pencil Topper',
	dogtag: 'Dog Tag',
	bumpyText: 'Bumpy Text',
	bowKeychain: 'Bow Keychain',
	pickleballKeychain: 'Pickleball keychain',
	hoopTag: 'HoopTag',
	articulatedKeychain: 'Articulated Keychain',
	spotifyKeychain: 'Spotify Keychain',
	namePuzzle: 'Name Puzzle',
	engraveNamePlate: 'Engrave Name Plate',
	cakeTopper: 'Cake Topper',
	canvasStudio: 'Canvas Studio',
	plateBadge: 'Plate badge',
	houseNumberPlaque: 'House Number Plaque',
	roomSign: 'Room Sign'
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
