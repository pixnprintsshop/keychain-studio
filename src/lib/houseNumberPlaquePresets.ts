import {
	fetchUserDesignerPresets,
	loadUserDesignerPresetsWithLocalMigration,
	persistDesignerCustomPresets,
	saveUserDesignerPresets
} from './designerPresets';

export interface HouseNumberPlaqueColorPreset {
	id: string;
	label: string;
	/** Plaque base plate */
	baseColor: string;
	/** Top border frame + main text */
	accentColor: string;
	/** Optional middle text-outline layer */
	textOutlineColor: string;
	textOutlineEnabled?: boolean;
}

export const HOUSE_NUMBER_PLAQUE_CUSTOM_PRESETS_LOCAL_KEY =
	'keychain-house-number-plaque-custom-presets';

/** Starter templates (Base · Text outline · Border & text). */
export const DEFAULT_HOUSE_NUMBER_PLAQUE_COLOR_PRESETS: Omit<
	HouseNumberPlaqueColorPreset,
	'id'
>[] = [
	{
		label: 'Classic Dark',
		baseColor: '#000000',
		accentColor: '#ffffff',
		textOutlineColor: '#ffffff',
		textOutlineEnabled: false
	},
	{
		label: 'Classic Light',
		baseColor: '#ffffff',
		accentColor: '#000000',
		textOutlineColor: '#000000',
		textOutlineEnabled: false
	},
	{
		label: 'Classic Navy',
		baseColor: '#1e3a5f',
		accentColor: '#ffffff',
		textOutlineColor: '#5eb3e4',
		textOutlineEnabled: true
	},
	{
		label: 'Forest',
		baseColor: '#1b4332',
		accentColor: '#ffffff',
		textOutlineColor: '#95d44a',
		textOutlineEnabled: true
	},
	{
		label: 'Slate',
		baseColor: '#334155',
		accentColor: '#f8fafc',
		textOutlineColor: '#cbd5e1',
		textOutlineEnabled: false
	},
	{
		label: 'Brick',
		baseColor: '#7f1d1d',
		accentColor: '#fef2f2',
		textOutlineColor: '#fecaca',
		textOutlineEnabled: true
	},
	{
		label: 'Charcoal',
		baseColor: '#171717',
		accentColor: '#fbbf24',
		textOutlineColor: '#ffffff',
		textOutlineEnabled: true
	},
	{
		label: 'Ocean',
		baseColor: '#0c4a6e',
		accentColor: '#ffffff',
		textOutlineColor: '#7dd3fc',
		textOutlineEnabled: true
	},
	{
		label: 'Sandstone',
		baseColor: '#d6d3d1',
		accentColor: '#44403c',
		textOutlineColor: '#ffffff',
		textOutlineEnabled: false
	},
	{
		label: 'Copper',
		baseColor: '#78350f',
		accentColor: '#fde68a',
		textOutlineColor: '#ffffff',
		textOutlineEnabled: true
	},
	{
		label: 'Lavender',
		baseColor: '#4c1d95',
		accentColor: '#ede9fe',
		textOutlineColor: '#c4b5fd',
		textOutlineEnabled: true
	},
	{
		label: 'Mint',
		baseColor: '#0f766e',
		accentColor: '#ffffff',
		textOutlineColor: '#5eead4',
		textOutlineEnabled: true
	},
	{
		label: 'Rose',
		baseColor: '#881337',
		accentColor: '#fff1f2',
		textOutlineColor: '#fecdd3',
		textOutlineEnabled: true
	}
];

export function cloneDefaultHouseNumberPlaquePresetsAsCustom(
	snapColor: (hex: string, fallback: string) => string
): HouseNumberPlaqueColorPreset[] {
	return DEFAULT_HOUSE_NUMBER_PLAQUE_COLOR_PRESETS.map((template) => ({
		id: `custom-${crypto.randomUUID()}`,
		label: template.label,
		baseColor: snapColor(template.baseColor, template.baseColor),
		accentColor: snapColor(template.accentColor, template.accentColor),
		textOutlineColor: snapColor(template.textOutlineColor, template.textOutlineColor),
		textOutlineEnabled: template.textOutlineEnabled ?? true
	}));
}

export function normalizeHouseNumberPlaqueHexColor(value: string, fallback: string): string {
	const c = value.trim();
	if (/^#[0-9a-fA-F]{6}$/.test(c)) return c.toLowerCase();
	if (/^[0-9a-fA-F]{6}$/.test(c)) return `#${c.toLowerCase()}`;
	return fallback;
}

export function parseHouseNumberPlaqueColorPreset(
	raw: unknown
): HouseNumberPlaqueColorPreset | null {
	if (!raw || typeof raw !== 'object') return null;
	const p = raw as Partial<HouseNumberPlaqueColorPreset>;
	if (typeof p.id !== 'string' || !p.id.startsWith('custom-')) return null;
	if (typeof p.label !== 'string' || !p.label.trim()) return null;
	if (
		typeof p.baseColor !== 'string' ||
		typeof p.accentColor !== 'string' ||
		typeof p.textOutlineColor !== 'string'
	) {
		return null;
	}
	return {
		id: p.id,
		label: p.label.trim(),
		baseColor: normalizeHouseNumberPlaqueHexColor(p.baseColor, '#000000'),
		accentColor: normalizeHouseNumberPlaqueHexColor(p.accentColor, '#ffffff'),
		textOutlineColor: normalizeHouseNumberPlaqueHexColor(p.textOutlineColor, '#ffffff'),
		textOutlineEnabled:
			typeof p.textOutlineEnabled === 'boolean' ? p.textOutlineEnabled : undefined
	};
}

export function isCustomHouseNumberPlaquePresetId(id: string): boolean {
	return id.startsWith('custom-');
}

export function loadLocalHouseNumberPlaquePresets(): HouseNumberPlaqueColorPreset[] {
	try {
		const stored = localStorage.getItem(HOUSE_NUMBER_PLAQUE_CUSTOM_PRESETS_LOCAL_KEY);
		if (!stored) return [];
		const parsed = JSON.parse(stored) as unknown;
		if (!Array.isArray(parsed)) return [];
		return parsed
			.map(parseHouseNumberPlaqueColorPreset)
			.filter((p): p is HouseNumberPlaqueColorPreset => p !== null);
	} catch {
		return [];
	}
}

export function saveLocalHouseNumberPlaquePresets(presets: HouseNumberPlaqueColorPreset[]): void {
	try {
		localStorage.setItem(
			HOUSE_NUMBER_PLAQUE_CUSTOM_PRESETS_LOCAL_KEY,
			JSON.stringify(presets)
		);
	} catch {
		/* localStorage may be unavailable */
	}
}

export function clearLocalHouseNumberPlaquePresets(): void {
	try {
		localStorage.removeItem(HOUSE_NUMBER_PLAQUE_CUSTOM_PRESETS_LOCAL_KEY);
	} catch {
		/* ignore */
	}
}

export async function fetchUserHouseNumberPlaquePresets(
	userId: string
): Promise<HouseNumberPlaqueColorPreset[] | null> {
	const remote = await fetchUserDesignerPresets(userId, 'addressNumberSign');
	if (remote === null) {
		return null;
	}

	return remote
		.map(parseHouseNumberPlaqueColorPreset)
		.filter((p): p is HouseNumberPlaqueColorPreset => p !== null);
}

export async function saveUserHouseNumberPlaquePresets(
	userId: string,
	presets: HouseNumberPlaqueColorPreset[]
): Promise<{ success: true } | { success: false; error: string }> {
	return saveUserDesignerPresets(userId, 'addressNumberSign', presets);
}

export async function loadUserHouseNumberPlaquePresets(
	userId: string
): Promise<HouseNumberPlaqueColorPreset[]> {
	return loadUserDesignerPresetsWithLocalMigration({
		userId,
		designerId: 'addressNumberSign',
		parse: parseHouseNumberPlaqueColorPreset,
		loadLocal: loadLocalHouseNumberPlaquePresets,
		clearLocal: clearLocalHouseNumberPlaquePresets
	});
}

export async function persistHouseNumberPlaqueCustomPresets(
	userId: string | null | undefined,
	presets: HouseNumberPlaqueColorPreset[]
): Promise<{ success: true } | { success: false; error: string }> {
	return persistDesignerCustomPresets(
		userId,
		'addressNumberSign',
		presets,
		saveLocalHouseNumberPlaquePresets
	);
}
