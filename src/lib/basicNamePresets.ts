import {
	fetchUserDesignerPresets,
	loadUserDesignerPresetsWithLocalMigration,
	persistDesignerCustomPresets,
	saveUserDesignerPresets
} from './designerPresets';

export interface BasicNameColorPreset {
	id: string;
	label: string;
	/** Tag base plate */
	baseColor: string;
	/** Top border frame + main text */
	accentColor: string;
	/** Optional middle text-outline layer */
	textOutlineColor: string;
	textOutlineEnabled?: boolean;
}

export const BASIC_NAME_CUSTOM_PRESETS_LOCAL_KEY = 'keychain-basicname-custom-presets';

/** Starter templates (Base · Text outline · Border & text). */
export const DEFAULT_BASIC_NAME_COLOR_PRESETS: Omit<BasicNameColorPreset, 'id'>[] = [
	{
		label: 'Classic',
		baseColor: '#000000',
		accentColor: '#24b6ff',
		textOutlineColor: '#ffffff',
		textOutlineEnabled: false
	},
	{
		label: 'Classic Pink',
		baseColor: '#f0a8a8',
		accentColor: '#2d2d2d',
		textOutlineColor: '#ffffff',
		textOutlineEnabled: true
	},
	{
		label: 'Ocean',
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
		label: 'Sunset',
		baseColor: '#f97316',
		accentColor: '#7c2d12',
		textOutlineColor: '#facc15',
		textOutlineEnabled: true
	},
	{
		label: 'Lavender',
		baseColor: '#9b87c4',
		accentColor: '#4c1d95',
		textOutlineColor: '#ede9fe',
		textOutlineEnabled: true
	},
	{
		label: 'Rose',
		baseColor: '#be123c',
		accentColor: '#451a03',
		textOutlineColor: '#fecdd3',
		textOutlineEnabled: true
	},
	{
		label: 'Mint',
		baseColor: '#5eead4',
		accentColor: '#0f766e',
		textOutlineColor: '#ffffff',
		textOutlineEnabled: true
	},
	{
		label: 'Berry',
		baseColor: '#c084fc',
		accentColor: '#6b21a8',
		textOutlineColor: '#f3e8ff',
		textOutlineEnabled: true
	},
	{
		label: 'Citrus',
		baseColor: '#fbbf24',
		accentColor: '#a16207',
		textOutlineColor: '#fef9c3',
		textOutlineEnabled: true
	},
	{
		label: 'Noir',
		baseColor: '#737373',
		accentColor: '#171717',
		textOutlineColor: '#e5e5e5',
		textOutlineEnabled: true
	},
	{
		label: 'Gold',
		baseColor: '#f59e0b',
		accentColor: '#78350f',
		textOutlineColor: '#fde68a',
		textOutlineEnabled: true
	},
	{
		label: 'Sky',
		baseColor: '#38bdf8',
		accentColor: '#075985',
		textOutlineColor: '#e0f2fe',
		textOutlineEnabled: true
	},
	{
		label: 'Candy',
		baseColor: '#f472b6',
		accentColor: '#9d174d',
		textOutlineColor: '#fce7f3',
		textOutlineEnabled: true
	},
	{
		label: 'Earth',
		baseColor: '#a16207',
		accentColor: '#44403c',
		textOutlineColor: '#d6d3d1',
		textOutlineEnabled: true
	},
	{
		label: 'Neon',
		baseColor: '#22d3ee',
		accentColor: '#18181b',
		textOutlineColor: '#f0abfc',
		textOutlineEnabled: true
	},
	{
		label: 'Patriotic',
		baseColor: '#dc2626',
		accentColor: '#1d4ed8',
		textOutlineColor: '#ffffff',
		textOutlineEnabled: true
	},
	{
		label: 'Plum',
		baseColor: '#a855f7',
		accentColor: '#581c87',
		textOutlineColor: '#ede9fe',
		textOutlineEnabled: true
	},
	{
		label: 'Coral',
		baseColor: '#fb7185',
		accentColor: '#9f1239',
		textOutlineColor: '#fff1f2',
		textOutlineEnabled: true
	}
];

export function cloneDefaultBasicNamePresetsAsCustom(
	snapColor: (hex: string, fallback: string) => string
): BasicNameColorPreset[] {
	return DEFAULT_BASIC_NAME_COLOR_PRESETS.map((template) => ({
		id: `custom-${crypto.randomUUID()}`,
		label: template.label,
		baseColor: snapColor(template.baseColor, template.baseColor),
		accentColor: snapColor(template.accentColor, template.accentColor),
		textOutlineColor: snapColor(template.textOutlineColor, template.textOutlineColor),
		textOutlineEnabled: template.textOutlineEnabled ?? true
	}));
}

export function normalizeBasicNameHexColor(value: string, fallback: string): string {
	const c = value.trim();
	if (/^#[0-9a-fA-F]{6}$/.test(c)) return c.toLowerCase();
	if (/^[0-9a-fA-F]{6}$/.test(c)) return `#${c.toLowerCase()}`;
	return fallback;
}

export function parseBasicNameColorPreset(raw: unknown): BasicNameColorPreset | null {
	if (!raw || typeof raw !== 'object') return null;
	const p = raw as Partial<BasicNameColorPreset>;
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
		baseColor: normalizeBasicNameHexColor(p.baseColor, '#000000'),
		accentColor: normalizeBasicNameHexColor(p.accentColor, '#24b6ff'),
		textOutlineColor: normalizeBasicNameHexColor(p.textOutlineColor, '#ffffff'),
		textOutlineEnabled:
			typeof p.textOutlineEnabled === 'boolean' ? p.textOutlineEnabled : undefined
	};
}

export function isCustomBasicNamePresetId(id: string): boolean {
	return id.startsWith('custom-');
}

export function loadLocalBasicNamePresets(): BasicNameColorPreset[] {
	try {
		const stored = localStorage.getItem(BASIC_NAME_CUSTOM_PRESETS_LOCAL_KEY);
		if (!stored) return [];
		const parsed = JSON.parse(stored) as unknown;
		if (!Array.isArray(parsed)) return [];
		return parsed
			.map(parseBasicNameColorPreset)
			.filter((p): p is BasicNameColorPreset => p !== null);
	} catch {
		return [];
	}
}

export function saveLocalBasicNamePresets(presets: BasicNameColorPreset[]): void {
	try {
		localStorage.setItem(BASIC_NAME_CUSTOM_PRESETS_LOCAL_KEY, JSON.stringify(presets));
	} catch {
		/* localStorage may be unavailable */
	}
}

export function clearLocalBasicNamePresets(): void {
	try {
		localStorage.removeItem(BASIC_NAME_CUSTOM_PRESETS_LOCAL_KEY);
	} catch {
		/* ignore */
	}
}

export async function fetchUserBasicNamePresets(
	userId: string
): Promise<BasicNameColorPreset[] | null> {
	const remote = await fetchUserDesignerPresets(userId, 'classicNameTagKeychain');
	if (remote === null) {
		return null;
	}

	return remote
		.map(parseBasicNameColorPreset)
		.filter((p): p is BasicNameColorPreset => p !== null);
}

export async function saveUserBasicNamePresets(
	userId: string,
	presets: BasicNameColorPreset[]
): Promise<{ success: true } | { success: false; error: string }> {
	return saveUserDesignerPresets(userId, 'classicNameTagKeychain', presets);
}

export async function loadUserBasicNamePresets(userId: string): Promise<BasicNameColorPreset[]> {
	return loadUserDesignerPresetsWithLocalMigration({
		userId,
		designerId: 'classicNameTagKeychain',
		parse: parseBasicNameColorPreset,
		loadLocal: loadLocalBasicNamePresets,
		clearLocal: clearLocalBasicNamePresets
	});
}

export async function persistBasicNameCustomPresets(
	userId: string | null | undefined,
	presets: BasicNameColorPreset[]
): Promise<{ success: true } | { success: false; error: string }> {
	return persistDesignerCustomPresets(userId, 'classicNameTagKeychain', presets, saveLocalBasicNamePresets);
}
