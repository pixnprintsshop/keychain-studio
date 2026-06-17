import {
	fetchUserDesignerPresets,
	loadUserDesignerPresetsWithLocalMigration,
	persistDesignerCustomPresets,
	saveUserDesignerPresets
} from './designerPresets';

export interface WhistleV2ColorPreset {
	id: string;
	label: string;
	mainColor: string;
	accentColor: string;
	borderColor: string;
	textColor?: string;
}

export const WHISTLE_V2_CUSTOM_PRESETS_LOCAL_KEY = 'keychain-whistle-v2-custom-presets';

/** Starter templates (Main · Accent · Border). Imported into the user’s editable preset list. */
export const DEFAULT_WHISTLE_V2_COLOR_PRESETS: Omit<WhistleV2ColorPreset, 'id'>[] = [
	{ label: 'Classic Pink', mainColor: '#f0a8a8', accentColor: '#ffffff', borderColor: '#2d2d2d' },
	{ label: 'Ocean', mainColor: '#5eb3e4', accentColor: '#1e3a5f', borderColor: '#ffffff' },
	{ label: 'Forest', mainColor: '#1b4332', accentColor: '#95d44a', borderColor: '#ffffff' },
	{ label: 'Sunset', mainColor: '#f97316', accentColor: '#facc15', borderColor: '#7c2d12' },
	{ label: 'Lavender', mainColor: '#9b87c4', accentColor: '#ede9fe', borderColor: '#4c1d95' },
	{ label: 'Rose', mainColor: '#be123c', accentColor: '#fecdd3', borderColor: '#451a03' },
	{ label: 'Mint', mainColor: '#5eead4', accentColor: '#ffffff', borderColor: '#0f766e' },
	{ label: 'Berry', mainColor: '#c084fc', accentColor: '#f3e8ff', borderColor: '#6b21a8' },
	{ label: 'Citrus', mainColor: '#fbbf24', accentColor: '#fef9c3', borderColor: '#a16207' },
	{ label: 'Noir', mainColor: '#737373', accentColor: '#e5e5e5', borderColor: '#171717' },
	{ label: 'Gold', mainColor: '#f59e0b', accentColor: '#fde68a', borderColor: '#78350f' },
	{ label: 'Sky', mainColor: '#38bdf8', accentColor: '#e0f2fe', borderColor: '#075985' },
	{ label: 'Candy', mainColor: '#f472b6', accentColor: '#fce7f3', borderColor: '#9d174d' },
	{ label: 'Earth', mainColor: '#a16207', accentColor: '#d6d3d1', borderColor: '#44403c' },
	{ label: 'Neon', mainColor: '#22d3ee', accentColor: '#f0abfc', borderColor: '#18181b' },
	{ label: 'Patriotic', mainColor: '#dc2626', accentColor: '#ffffff', borderColor: '#1d4ed8' },
	{ label: 'Plum', mainColor: '#a855f7', accentColor: '#ede9fe', borderColor: '#581c87' },
	{ label: 'Coral', mainColor: '#fb7185', accentColor: '#fff1f2', borderColor: '#9f1239' }
];

export function cloneDefaultWhistleV2PresetsAsCustom(
	snapColor: (hex: string, fallback: string) => string
): WhistleV2ColorPreset[] {
	return DEFAULT_WHISTLE_V2_COLOR_PRESETS.map((template) => {
		const border = template.borderColor;
		const text = template.textColor ?? border;
		return {
			id: `custom-${crypto.randomUUID()}`,
			label: template.label,
			mainColor: snapColor(template.mainColor, template.mainColor),
			accentColor: snapColor(template.accentColor, template.accentColor),
			borderColor: snapColor(border, border),
			textColor: snapColor(text, border)
		};
	});
}

export function normalizeWhistleV2HexColor(value: string, fallback: string): string {
	const c = value.trim();
	if (/^#[0-9a-fA-F]{6}$/.test(c)) return c.toLowerCase();
	if (/^[0-9a-fA-F]{6}$/.test(c)) return `#${c.toLowerCase()}`;
	return fallback;
}

export function parseWhistleV2ColorPreset(raw: unknown): WhistleV2ColorPreset | null {
	if (!raw || typeof raw !== 'object') return null;
	const p = raw as Partial<WhistleV2ColorPreset>;
	if (typeof p.id !== 'string' || !p.id.startsWith('custom-')) return null;
	if (typeof p.label !== 'string' || !p.label.trim()) return null;
	if (
		typeof p.mainColor !== 'string' ||
		typeof p.accentColor !== 'string' ||
		typeof p.borderColor !== 'string'
	) {
		return null;
	}
	return {
		id: p.id,
		label: p.label.trim(),
		mainColor: normalizeWhistleV2HexColor(p.mainColor, '#f97316'),
		accentColor: normalizeWhistleV2HexColor(p.accentColor, '#eab308'),
		borderColor: normalizeWhistleV2HexColor(p.borderColor, '#1f2937'),
		textColor:
			typeof p.textColor === 'string'
				? normalizeWhistleV2HexColor(
						p.textColor,
						normalizeWhistleV2HexColor(p.borderColor, '#1f2937')
					)
				: undefined
	};
}

export function isCustomWhistleV2PresetId(id: string): boolean {
	return id.startsWith('custom-');
}

export function loadLocalWhistleV2Presets(): WhistleV2ColorPreset[] {
	try {
		const stored = localStorage.getItem(WHISTLE_V2_CUSTOM_PRESETS_LOCAL_KEY);
		if (!stored) return [];
		const parsed = JSON.parse(stored) as unknown;
		if (!Array.isArray(parsed)) return [];
		return parsed
			.map(parseWhistleV2ColorPreset)
			.filter((p): p is WhistleV2ColorPreset => p !== null);
	} catch {
		return [];
	}
}

export function saveLocalWhistleV2Presets(presets: WhistleV2ColorPreset[]): void {
	try {
		localStorage.setItem(WHISTLE_V2_CUSTOM_PRESETS_LOCAL_KEY, JSON.stringify(presets));
	} catch {
		/* localStorage may be unavailable */
	}
}

export function clearLocalWhistleV2Presets(): void {
	try {
		localStorage.removeItem(WHISTLE_V2_CUSTOM_PRESETS_LOCAL_KEY);
	} catch {
		/* ignore */
	}
}

export async function fetchUserWhistleV2Presets(
	userId: string
): Promise<WhistleV2ColorPreset[] | null> {
	const remote = await fetchUserDesignerPresets(userId, 'multicolorWhistle');
	if (remote === null) {
		return null;
	}

	return remote
		.map(parseWhistleV2ColorPreset)
		.filter((p): p is WhistleV2ColorPreset => p !== null);
}

export async function saveUserWhistleV2Presets(
	userId: string,
	presets: WhistleV2ColorPreset[]
): Promise<{ success: true } | { success: false; error: string }> {
	return saveUserDesignerPresets(userId, 'multicolorWhistle', presets);
}

/** Load presets for a signed-in user; migrates local-only presets to the account once. */
export async function loadUserWhistleV2Presets(userId: string): Promise<WhistleV2ColorPreset[]> {
	return loadUserDesignerPresetsWithLocalMigration({
		userId,
		designerId: 'multicolorWhistle',
		parse: parseWhistleV2ColorPreset,
		loadLocal: loadLocalWhistleV2Presets,
		clearLocal: clearLocalWhistleV2Presets
	});
}

export async function persistWhistleV2CustomPresets(
	userId: string | null | undefined,
	presets: WhistleV2ColorPreset[]
): Promise<{ success: true } | { success: false; error: string }> {
	return persistDesignerCustomPresets(userId, 'multicolorWhistle', presets, saveLocalWhistleV2Presets);
}
