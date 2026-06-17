import {
	fetchUserDesignerPresets,
	loadUserDesignerPresetsWithLocalMigration,
	persistDesignerCustomPresets,
	saveUserDesignerPresets
} from './designerPresets';

export interface TextOutlineColorPreset {
	id: string;
	label: string;
	/** Base outline color */
	outlineColor: string;
	/** Inset border rim color (does not toggle border on/off) */
	borderColor: string;
	/** Main letter color */
	textColor: string;
	/** Optional middle text-outline layer */
	textOutlineColor: string;
	textOutlineEnabled?: boolean;
}

export const TEXT_OUTLINE_CUSTOM_PRESETS_LOCAL_KEY = 'keychain-text-outline-custom-presets';

/** Starter templates (Base · Border · Text outline · Text). */
export const DEFAULT_TEXT_OUTLINE_COLOR_PRESETS: Omit<TextOutlineColorPreset, 'id'>[] = [
	{
		label: 'Classic Pink',
		outlineColor: '#f0a8a8',
		borderColor: '#2d2d2d',
		textOutlineColor: '#ffffff',
		textColor: '#2d2d2d',
		textOutlineEnabled: true
	},
	{
		label: 'Ocean',
		outlineColor: '#5eb3e4',
		borderColor: '#ffffff',
		textOutlineColor: '#1e3a5f',
		textColor: '#ffffff',
		textOutlineEnabled: true
	},
	{
		label: 'Forest',
		outlineColor: '#1b4332',
		borderColor: '#ffffff',
		textOutlineColor: '#95d44a',
		textColor: '#ffffff',
		textOutlineEnabled: true
	},
	{
		label: 'Sunset',
		outlineColor: '#f97316',
		borderColor: '#7c2d12',
		textOutlineColor: '#facc15',
		textColor: '#7c2d12',
		textOutlineEnabled: true
	},
	{
		label: 'Lavender',
		outlineColor: '#9b87c4',
		borderColor: '#4c1d95',
		textOutlineColor: '#ede9fe',
		textColor: '#4c1d95',
		textOutlineEnabled: true
	},
	{
		label: 'Rose',
		outlineColor: '#be123c',
		borderColor: '#451a03',
		textOutlineColor: '#fecdd3',
		textColor: '#451a03',
		textOutlineEnabled: true
	},
	{
		label: 'Mint',
		outlineColor: '#5eead4',
		borderColor: '#0f766e',
		textOutlineColor: '#ffffff',
		textColor: '#0f766e',
		textOutlineEnabled: true
	},
	{
		label: 'Berry',
		outlineColor: '#c084fc',
		borderColor: '#6b21a8',
		textOutlineColor: '#f3e8ff',
		textColor: '#6b21a8',
		textOutlineEnabled: true
	},
	{
		label: 'Citrus',
		outlineColor: '#fbbf24',
		borderColor: '#a16207',
		textOutlineColor: '#fef9c3',
		textColor: '#a16207',
		textOutlineEnabled: true
	},
	{
		label: 'Noir',
		outlineColor: '#737373',
		borderColor: '#171717',
		textOutlineColor: '#e5e5e5',
		textColor: '#171717',
		textOutlineEnabled: true
	},
	{
		label: 'Gold',
		outlineColor: '#f59e0b',
		borderColor: '#78350f',
		textOutlineColor: '#fde68a',
		textColor: '#78350f',
		textOutlineEnabled: true
	},
	{
		label: 'Sky',
		outlineColor: '#38bdf8',
		borderColor: '#075985',
		textOutlineColor: '#e0f2fe',
		textColor: '#075985',
		textOutlineEnabled: true
	},
	{
		label: 'Candy',
		outlineColor: '#f472b6',
		borderColor: '#9d174d',
		textOutlineColor: '#fce7f3',
		textColor: '#9d174d',
		textOutlineEnabled: true
	},
	{
		label: 'Earth',
		outlineColor: '#a16207',
		borderColor: '#44403c',
		textOutlineColor: '#d6d3d1',
		textColor: '#44403c',
		textOutlineEnabled: true
	},
	{
		label: 'Neon',
		outlineColor: '#22d3ee',
		borderColor: '#18181b',
		textOutlineColor: '#f0abfc',
		textColor: '#18181b',
		textOutlineEnabled: true
	},
	{
		label: 'Patriotic',
		outlineColor: '#dc2626',
		borderColor: '#1d4ed8',
		textOutlineColor: '#ffffff',
		textColor: '#1d4ed8',
		textOutlineEnabled: true
	},
	{
		label: 'Plum',
		outlineColor: '#a855f7',
		borderColor: '#581c87',
		textOutlineColor: '#ede9fe',
		textColor: '#581c87',
		textOutlineEnabled: true
	},
	{
		label: 'Coral',
		outlineColor: '#fb7185',
		borderColor: '#9f1239',
		textOutlineColor: '#fff1f2',
		textColor: '#9f1239',
		textOutlineEnabled: true
	}
];

export function cloneDefaultTextOutlinePresetsAsCustom(
	snapColor: (hex: string, fallback: string) => string
): TextOutlineColorPreset[] {
	return DEFAULT_TEXT_OUTLINE_COLOR_PRESETS.map((template) => ({
		id: `custom-${crypto.randomUUID()}`,
		label: template.label,
		outlineColor: snapColor(template.outlineColor, template.outlineColor),
		borderColor: snapColor(template.borderColor, template.borderColor),
		textOutlineColor: snapColor(template.textOutlineColor, template.textOutlineColor),
		textColor: snapColor(template.textColor, template.textColor),
		textOutlineEnabled: template.textOutlineEnabled ?? true
	}));
}

export function normalizeTextOutlineHexColor(value: string, fallback: string): string {
	const c = value.trim();
	if (/^#[0-9a-fA-F]{6}$/.test(c)) return c.toLowerCase();
	if (/^[0-9a-fA-F]{6}$/.test(c)) return `#${c.toLowerCase()}`;
	return fallback;
}

export function parseTextOutlineColorPreset(raw: unknown): TextOutlineColorPreset | null {
	if (!raw || typeof raw !== 'object') return null;
	const p = raw as Partial<TextOutlineColorPreset>;
	if (typeof p.id !== 'string' || !p.id.startsWith('custom-')) return null;
	if (typeof p.label !== 'string' || !p.label.trim()) return null;
	if (
		typeof p.outlineColor !== 'string' ||
		typeof p.textColor !== 'string' ||
		typeof p.textOutlineColor !== 'string'
	) {
		return null;
	}
	const borderFallback = normalizeTextOutlineHexColor(p.textColor, '#2d2d2d');
	return {
		id: p.id,
		label: p.label.trim(),
		outlineColor: normalizeTextOutlineHexColor(p.outlineColor, '#f0a8a8'),
		borderColor: normalizeTextOutlineHexColor(
			typeof p.borderColor === 'string' ? p.borderColor : borderFallback,
			borderFallback
		),
		textColor: normalizeTextOutlineHexColor(p.textColor, '#2d2d2d'),
		textOutlineColor: normalizeTextOutlineHexColor(p.textOutlineColor, '#ffffff'),
		textOutlineEnabled:
			typeof p.textOutlineEnabled === 'boolean' ? p.textOutlineEnabled : undefined
	};
}

export function isCustomTextOutlinePresetId(id: string): boolean {
	return id.startsWith('custom-');
}

export function loadLocalTextOutlinePresets(): TextOutlineColorPreset[] {
	try {
		const stored = localStorage.getItem(TEXT_OUTLINE_CUSTOM_PRESETS_LOCAL_KEY);
		if (!stored) return [];
		const parsed = JSON.parse(stored) as unknown;
		if (!Array.isArray(parsed)) return [];
		return parsed
			.map(parseTextOutlineColorPreset)
			.filter((p): p is TextOutlineColorPreset => p !== null);
	} catch {
		return [];
	}
}

export function saveLocalTextOutlinePresets(presets: TextOutlineColorPreset[]): void {
	try {
		localStorage.setItem(TEXT_OUTLINE_CUSTOM_PRESETS_LOCAL_KEY, JSON.stringify(presets));
	} catch {
		/* localStorage may be unavailable */
	}
}

export function clearLocalTextOutlinePresets(): void {
	try {
		localStorage.removeItem(TEXT_OUTLINE_CUSTOM_PRESETS_LOCAL_KEY);
	} catch {
		/* ignore */
	}
}

export async function fetchUserTextOutlinePresets(
	userId: string
): Promise<TextOutlineColorPreset[] | null> {
	const remote = await fetchUserDesignerPresets(userId, 'standaloneName');
	if (remote === null) {
		return null;
	}

	return remote
		.map(parseTextOutlineColorPreset)
		.filter((p): p is TextOutlineColorPreset => p !== null);
}

export async function saveUserTextOutlinePresets(
	userId: string,
	presets: TextOutlineColorPreset[]
): Promise<{ success: true } | { success: false; error: string }> {
	return saveUserDesignerPresets(userId, 'standaloneName', presets);
}

export async function loadUserTextOutlinePresets(userId: string): Promise<TextOutlineColorPreset[]> {
	return loadUserDesignerPresetsWithLocalMigration({
		userId,
		designerId: 'standaloneName',
		parse: parseTextOutlineColorPreset,
		loadLocal: loadLocalTextOutlinePresets,
		clearLocal: clearLocalTextOutlinePresets
	});
}

export async function persistTextOutlineCustomPresets(
	userId: string | null | undefined,
	presets: TextOutlineColorPreset[]
): Promise<{ success: true } | { success: false; error: string }> {
	return persistDesignerCustomPresets(userId, 'standaloneName', presets, saveLocalTextOutlinePresets);
}
