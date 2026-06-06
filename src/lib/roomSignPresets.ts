import {
	fetchUserDesignerPresets,
	loadUserDesignerPresetsWithLocalMigration,
	persistDesignerCustomPresets,
	saveUserDesignerPresets
} from './designerPresets';

export interface RoomSignColorPreset {
	id: string;
	label: string;
	baseColor: string;
	decorColor: string;
	textColor: string;
}

export const ROOM_SIGN_CUSTOM_PRESETS_LOCAL_KEY = 'keychain-room-sign-custom-presets';

/** Starter templates (Base · Decor · Text). Imported into the user's editable preset list. */
export const DEFAULT_ROOM_SIGN_COLOR_PRESETS: Omit<RoomSignColorPreset, 'id'>[] = [
	{ label: 'Libby Pink', baseColor: '#db2777', decorColor: '#fce7f3', textColor: '#ffffff' },
	{ label: 'Blush Gold', baseColor: '#be185d', decorColor: '#fef3c7', textColor: '#fbbf24' },
	{ label: 'Midnight Cream', baseColor: '#0f172a', decorColor: '#fefce8', textColor: '#e2e8f0' },
	{ label: 'Sage Terracotta', baseColor: '#3f5c4e', decorColor: '#fce7dc', textColor: '#c2410c' },
	{ label: 'Coral Reef', baseColor: '#e11d48', decorColor: '#fff1f2', textColor: '#ffffff' },
	{ label: 'Nordic Blue', baseColor: '#1e40af', decorColor: '#dbeafe', textColor: '#ffffff' },
	{ label: 'Sunset Glow', baseColor: '#ea580c', decorColor: '#ffedd5', textColor: '#fef08a' },
	{ label: 'Cherry Blossom', baseColor: '#ec4899', decorColor: '#fdf2f8', textColor: '#ffffff' },
	{ label: 'Royal Amethyst', baseColor: '#6d28d9', decorColor: '#ede9fe', textColor: '#f5f3ff' },
	{ label: 'Emerald Garden', baseColor: '#047857', decorColor: '#d1fae5', textColor: '#ffffff' },
	{ label: 'Charcoal Gold', baseColor: '#262626', decorColor: '#fbbf24', textColor: '#ffffff' },
	{ label: 'Pastel Dream', baseColor: '#a78bfa', decorColor: '#fce7f3', textColor: '#ffffff' },
	{ label: 'Electric Cyan', baseColor: '#0e7490', decorColor: '#0f172a', textColor: '#22d3ee' },
	{ label: 'Warm Cocoa', baseColor: '#78350f', decorColor: '#fef3c7', textColor: '#ffffff' },
	{ label: 'Glacier Ice', baseColor: '#0284c7', decorColor: '#f0f9ff', textColor: '#ffffff' },
	{ label: 'Mauve Mist', baseColor: '#9333ea', decorColor: '#f3e8ff', textColor: '#faf5ff' },
	{ label: 'Matcha Leaf', baseColor: '#65a30d', decorColor: '#ecfccb', textColor: '#ffffff' },
	{ label: 'Classic Dark', baseColor: '#171717', decorColor: '#ffffff', textColor: '#ffffff' },
	{ label: 'Classic Light', baseColor: '#ffffff', decorColor: '#171717', textColor: '#171717' },
	{ label: 'Ocean Deep', baseColor: '#0c4a6e', decorColor: '#ffffff', textColor: '#7dd3fc' },
	{ label: 'Forest Moss', baseColor: '#1b4332', decorColor: '#ffffff', textColor: '#95d44a' },
	{ label: 'Lavender Haze', baseColor: '#4c1d95', decorColor: '#ede9fe', textColor: '#ffffff' },
	{ label: 'Mint Fresh', baseColor: '#0f766e', decorColor: '#ffffff', textColor: '#5eead4' },
	{ label: 'Rose Quartz', baseColor: '#881337', decorColor: '#fecdd3', textColor: '#ffffff' }
];

function normalizeHex(value: string, fallback: string): string {
	const c = value.trim();
	if (/^#[0-9a-fA-F]{6}$/.test(c)) return c.toLowerCase();
	if (/^[0-9a-fA-F]{6}$/.test(c)) return `#${c.toLowerCase()}`;
	return fallback;
}

export function cloneDefaultRoomSignPresetsAsCustom(): RoomSignColorPreset[] {
	return DEFAULT_ROOM_SIGN_COLOR_PRESETS.map((template) => ({
		id: `custom-${crypto.randomUUID()}`,
		label: template.label,
		baseColor: normalizeHex(template.baseColor, '#db2777'),
		decorColor: normalizeHex(template.decorColor, '#fce7f3'),
		textColor: normalizeHex(template.textColor, '#ffffff')
	}));
}

export function parseRoomSignColorPreset(raw: unknown): RoomSignColorPreset | null {
	if (!raw || typeof raw !== 'object') return null;
	const p = raw as Partial<RoomSignColorPreset>;
	if (typeof p.id !== 'string' || !p.id.startsWith('custom-')) return null;
	if (typeof p.label !== 'string' || !p.label.trim()) return null;
	if (
		typeof p.baseColor !== 'string' ||
		typeof p.decorColor !== 'string' ||
		typeof p.textColor !== 'string'
	) {
		return null;
	}
	return {
		id: p.id,
		label: p.label.trim(),
		baseColor: normalizeHex(p.baseColor, '#db2777'),
		decorColor: normalizeHex(p.decorColor, '#fce7f3'),
		textColor: normalizeHex(p.textColor, '#ffffff')
	};
}

export function isCustomRoomSignPresetId(id: string): boolean {
	return id.startsWith('custom-');
}

export function loadLocalRoomSignPresets(): RoomSignColorPreset[] {
	try {
		const stored = localStorage.getItem(ROOM_SIGN_CUSTOM_PRESETS_LOCAL_KEY);
		if (!stored) return [];
		const parsed = JSON.parse(stored);
		if (!Array.isArray(parsed)) return [];
		return parsed
			.map(parseRoomSignColorPreset)
			.filter((p): p is RoomSignColorPreset => p !== null);
	} catch {
		return [];
	}
}

export function saveLocalRoomSignPresets(presets: RoomSignColorPreset[]): void {
	try {
		localStorage.setItem(ROOM_SIGN_CUSTOM_PRESETS_LOCAL_KEY, JSON.stringify(presets));
	} catch {
		/* localStorage may be unavailable */
	}
}

export async function loadUserRoomSignPresets(userId: string): Promise<RoomSignColorPreset[]> {
	return loadUserDesignerPresetsWithLocalMigration({
		userId,
		designerId: 'roomSign',
		parse: parseRoomSignColorPreset,
		loadLocal: loadLocalRoomSignPresets,
		clearLocal: () => localStorage.removeItem(ROOM_SIGN_CUSTOM_PRESETS_LOCAL_KEY)
	});
}

export async function persistRoomSignCustomPresets(
	userId: string,
	presets: RoomSignColorPreset[]
): Promise<{ success: true } | { success: false; error: string }> {
	return persistDesignerCustomPresets(userId, 'roomSign', presets, saveLocalRoomSignPresets);
}

export async function saveUserRoomSignPresets(
	userId: string,
	presets: RoomSignColorPreset[]
): Promise<{ success: true } | { success: false; error: string }> {
	return saveUserDesignerPresets(userId, 'roomSign', presets);
}
