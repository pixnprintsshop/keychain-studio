import { DEFAULT_BASIC_NAME_COLOR_PRESETS } from './basicNamePresets';
import {
	fetchUserDesignerPresets,
	loadUserDesignerPresetsWithLocalMigration,
	persistDesignerCustomPresets,
	saveUserDesignerPresets
} from './designerPresets';

export interface WhistleBagTagColorPreset {
	id: string;
	label: string;
	/** Bag tag base plate */
	baseColor: string;
	/** Border rim + main text */
	accentColor: string;
	/** Optional middle text-outline layer */
	textOutlineColor: string;
	textOutlineEnabled?: boolean;
}

export const WHISTLE_BAG_TAG_CUSTOM_PRESETS_LOCAL_KEY = 'keychain-whistle-bag-tag-custom-presets';

/** Starter templates (Base · Text outline · Border & text). */
export const DEFAULT_WHISTLE_BAG_TAG_COLOR_PRESETS: Omit<WhistleBagTagColorPreset, 'id'>[] =
	DEFAULT_BASIC_NAME_COLOR_PRESETS.map(
		({ label, baseColor, accentColor, textOutlineColor, textOutlineEnabled }) => ({
			label,
			baseColor,
			accentColor,
			textOutlineColor,
			textOutlineEnabled
		})
	);

export function cloneDefaultWhistleBagTagPresetsAsCustom(
	snapColor: (hex: string, fallback: string) => string
): WhistleBagTagColorPreset[] {
	return DEFAULT_WHISTLE_BAG_TAG_COLOR_PRESETS.map((template) => ({
		id: `custom-${crypto.randomUUID()}`,
		label: template.label,
		baseColor: snapColor(template.baseColor, template.baseColor),
		accentColor: snapColor(template.accentColor, template.accentColor),
		textOutlineColor: snapColor(template.textOutlineColor, template.textOutlineColor),
		textOutlineEnabled: template.textOutlineEnabled ?? true
	}));
}

export function normalizeWhistleBagTagHexColor(value: string, fallback: string): string {
	const c = value.trim();
	if (/^#[0-9a-fA-F]{6}$/.test(c)) return c.toLowerCase();
	if (/^[0-9a-fA-F]{6}$/.test(c)) return `#${c.toLowerCase()}`;
	return fallback;
}

export function parseWhistleBagTagColorPreset(raw: unknown): WhistleBagTagColorPreset | null {
	if (!raw || typeof raw !== 'object') return null;
	const p = raw as Partial<WhistleBagTagColorPreset>;
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
		baseColor: normalizeWhistleBagTagHexColor(p.baseColor, '#f97316'),
		accentColor: normalizeWhistleBagTagHexColor(p.accentColor, '#ffffff'),
		textOutlineColor: normalizeWhistleBagTagHexColor(p.textOutlineColor, '#ffffff'),
		textOutlineEnabled:
			typeof p.textOutlineEnabled === 'boolean' ? p.textOutlineEnabled : undefined
	};
}

export function isCustomWhistleBagTagPresetId(id: string): boolean {
	return id.startsWith('custom-');
}

export function loadLocalWhistleBagTagPresets(): WhistleBagTagColorPreset[] {
	try {
		const stored = localStorage.getItem(WHISTLE_BAG_TAG_CUSTOM_PRESETS_LOCAL_KEY);
		if (!stored) return [];
		const parsed = JSON.parse(stored) as unknown;
		if (!Array.isArray(parsed)) return [];
		return parsed
			.map(parseWhistleBagTagColorPreset)
			.filter((p): p is WhistleBagTagColorPreset => p !== null);
	} catch {
		return [];
	}
}

export function saveLocalWhistleBagTagPresets(presets: WhistleBagTagColorPreset[]): void {
	try {
		localStorage.setItem(WHISTLE_BAG_TAG_CUSTOM_PRESETS_LOCAL_KEY, JSON.stringify(presets));
	} catch {
		/* localStorage may be unavailable */
	}
}

export function clearLocalWhistleBagTagPresets(): void {
	try {
		localStorage.removeItem(WHISTLE_BAG_TAG_CUSTOM_PRESETS_LOCAL_KEY);
	} catch {
		/* ignore */
	}
}

export async function fetchUserWhistleBagTagPresets(
	userId: string
): Promise<WhistleBagTagColorPreset[] | null> {
	const remote = await fetchUserDesignerPresets(userId, 'whistleBagTag');
	if (remote === null) return null;
	return remote
		.map(parseWhistleBagTagColorPreset)
		.filter((p): p is WhistleBagTagColorPreset => p !== null);
}

export async function saveUserWhistleBagTagPresets(
	userId: string,
	presets: WhistleBagTagColorPreset[]
): Promise<{ success: true } | { success: false; error: string }> {
	return saveUserDesignerPresets(userId, 'whistleBagTag', presets);
}

export async function loadUserWhistleBagTagPresets(userId: string): Promise<WhistleBagTagColorPreset[]> {
	return loadUserDesignerPresetsWithLocalMigration({
		userId,
		designerId: 'whistleBagTag',
		parse: parseWhistleBagTagColorPreset,
		loadLocal: loadLocalWhistleBagTagPresets,
		clearLocal: clearLocalWhistleBagTagPresets
	});
}

export async function persistWhistleBagTagCustomPresets(
	userId: string | null | undefined,
	presets: WhistleBagTagColorPreset[]
): Promise<{ success: true } | { success: false; error: string }> {
	return persistDesignerCustomPresets(
		userId,
		'whistleBagTag',
		presets,
		saveLocalWhistleBagTagPresets
	);
}

