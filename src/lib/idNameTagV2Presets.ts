import { DEFAULT_BASIC_NAME_COLOR_PRESETS } from './basicNamePresets';
import {
	fetchUserDesignerPresets,
	loadUserDesignerPresetsWithLocalMigration,
	persistDesignerCustomPresets,
	saveUserDesignerPresets
} from './designerPresets';

export interface IdNameTagV2ColorPreset {
	id: string;
	label: string;
	baseColor: string;
	borderColor: string;
	textColor: string;
	textOutlineColor: string;
	textOutlineEnabled?: boolean;
}

export const ID_NAME_TAG_V2_CUSTOM_PRESETS_LOCAL_KEY = 'keychain-idnametag-v2-custom-presets';

export const DEFAULT_ID_NAME_TAG_V2_COLOR_PRESETS: Omit<IdNameTagV2ColorPreset, 'id'>[] =
	DEFAULT_BASIC_NAME_COLOR_PRESETS.map(
		({ label, baseColor, accentColor, textOutlineColor, textOutlineEnabled }) => ({
			label,
			baseColor,
			borderColor: accentColor,
			textColor: accentColor,
			textOutlineColor,
			textOutlineEnabled
		})
	);

export function cloneDefaultIdNameTagV2PresetsAsCustom(
	snapColor: (hex: string, fallback: string) => string
): IdNameTagV2ColorPreset[] {
	return DEFAULT_ID_NAME_TAG_V2_COLOR_PRESETS.map((template) => ({
		id: `custom-${crypto.randomUUID()}`,
		label: template.label,
		baseColor: snapColor(template.baseColor, template.baseColor),
		borderColor: snapColor(template.borderColor, template.borderColor),
		textColor: snapColor(template.textColor, template.textColor),
		textOutlineColor: snapColor(template.textOutlineColor, template.textOutlineColor),
		textOutlineEnabled: template.textOutlineEnabled ?? true
	}));
}

export function normalizeIdNameTagV2HexColor(value: string, fallback: string): string {
	const c = value.trim();
	if (/^#[0-9a-fA-F]{6}$/.test(c)) return c.toLowerCase();
	if (/^[0-9a-fA-F]{6}$/.test(c)) return `#${c.toLowerCase()}`;
	return fallback;
}

export function parseIdNameTagV2ColorPreset(raw: unknown): IdNameTagV2ColorPreset | null {
	if (!raw || typeof raw !== 'object') return null;
	const p = raw as Partial<IdNameTagV2ColorPreset>;
	if (typeof p.id !== 'string' || !p.id.startsWith('custom-')) return null;
	if (typeof p.label !== 'string' || !p.label.trim()) return null;

	const borderColor =
		typeof p.borderColor === 'string'
			? p.borderColor
			: typeof (p as { accentColor?: string }).accentColor === 'string'
				? (p as { accentColor: string }).accentColor
				: null;
	const textColor =
		typeof p.textColor === 'string'
			? p.textColor
			: typeof (p as { accentColor?: string }).accentColor === 'string'
				? (p as { accentColor: string }).accentColor
				: borderColor;

	if (typeof p.baseColor !== 'string' || !borderColor || !textColor || typeof p.textOutlineColor !== 'string') {
		return null;
	}

	return {
		id: p.id,
		label: p.label.trim(),
		baseColor: normalizeIdNameTagV2HexColor(p.baseColor, '#ffffff'),
		borderColor: normalizeIdNameTagV2HexColor(borderColor, '#1f2937'),
		textColor: normalizeIdNameTagV2HexColor(textColor, borderColor),
		textOutlineColor: normalizeIdNameTagV2HexColor(p.textOutlineColor, '#ffffff'),
		textOutlineEnabled: typeof p.textOutlineEnabled === 'boolean' ? p.textOutlineEnabled : undefined
	};
}

export function isCustomIdNameTagV2PresetId(id: string): boolean {
	return id.startsWith('custom-');
}

export function loadLocalIdNameTagV2Presets(): IdNameTagV2ColorPreset[] {
	try {
		const stored = localStorage.getItem(ID_NAME_TAG_V2_CUSTOM_PRESETS_LOCAL_KEY);
		if (!stored) return [];
		const parsed = JSON.parse(stored) as unknown;
		if (!Array.isArray(parsed)) return [];
		return parsed
			.map(parseIdNameTagV2ColorPreset)
			.filter((p): p is IdNameTagV2ColorPreset => p !== null);
	} catch {
		return [];
	}
}

export function saveLocalIdNameTagV2Presets(presets: IdNameTagV2ColorPreset[]): void {
	try {
		localStorage.setItem(ID_NAME_TAG_V2_CUSTOM_PRESETS_LOCAL_KEY, JSON.stringify(presets));
	} catch {
		/* localStorage may be unavailable */
	}
}

export function clearLocalIdNameTagV2Presets(): void {
	try {
		localStorage.removeItem(ID_NAME_TAG_V2_CUSTOM_PRESETS_LOCAL_KEY);
	} catch {
		/* ignore */
	}
}

export async function fetchUserIdNameTagV2Presets(
	userId: string
): Promise<IdNameTagV2ColorPreset[] | null> {
	const remote = await fetchUserDesignerPresets(userId, 'idNameTagV2');
	if (remote === null) {
		return null;
	}

	return remote
		.map(parseIdNameTagV2ColorPreset)
		.filter((p): p is IdNameTagV2ColorPreset => p !== null);
}

export async function saveUserIdNameTagV2Presets(
	userId: string,
	presets: IdNameTagV2ColorPreset[]
): Promise<{ success: true } | { success: false; error: string }> {
	return saveUserDesignerPresets(userId, 'idNameTagV2', presets);
}

export async function loadUserIdNameTagV2Presets(userId: string): Promise<IdNameTagV2ColorPreset[]> {
	return loadUserDesignerPresetsWithLocalMigration({
		userId,
		designerId: 'idNameTagV2',
		parse: parseIdNameTagV2ColorPreset,
		loadLocal: loadLocalIdNameTagV2Presets,
		clearLocal: clearLocalIdNameTagV2Presets
	});
}

export async function persistIdNameTagV2CustomPresets(
	userId: string | null | undefined,
	presets: IdNameTagV2ColorPreset[]
): Promise<{ success: true } | { success: false; error: string }> {
	return persistDesignerCustomPresets(userId, 'idNameTagV2', presets, saveLocalIdNameTagV2Presets);
}
