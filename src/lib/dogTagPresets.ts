import { DEFAULT_BASIC_NAME_COLOR_PRESETS } from './basicNamePresets';
import {
	fetchUserDesignerPresets,
	loadUserDesignerPresetsWithLocalMigration,
	persistDesignerCustomPresets,
	saveUserDesignerPresets
} from './designerPresets';

export interface DogTagColorPreset {
	id: string;
	label: string;
	baseColor: string;
	/** Border rim + main text */
	textColor: string;
	textOutlineColor: string;
	textOutlineEnabled?: boolean;
}

export const DOG_TAG_CUSTOM_PRESETS_LOCAL_KEY = 'keychain-dogtag-custom-presets';

export const DEFAULT_DOG_TAG_COLOR_PRESETS: Omit<DogTagColorPreset, 'id'>[] =
	DEFAULT_BASIC_NAME_COLOR_PRESETS.map(
		({ label, baseColor, accentColor, textOutlineColor, textOutlineEnabled }) => ({
			label,
			baseColor,
			textColor: accentColor,
			textOutlineColor,
			textOutlineEnabled
		})
	);

export function cloneDefaultDogTagPresetsAsCustom(
	snapColor: (hex: string, fallback: string) => string
): DogTagColorPreset[] {
	return DEFAULT_DOG_TAG_COLOR_PRESETS.map((template) => ({
		id: `custom-${crypto.randomUUID()}`,
		label: template.label,
		baseColor: snapColor(template.baseColor, template.baseColor),
		textColor: snapColor(template.textColor, template.textColor),
		textOutlineColor: snapColor(template.textOutlineColor, template.textOutlineColor),
		textOutlineEnabled: template.textOutlineEnabled ?? true
	}));
}

export function normalizeDogTagHexColor(value: string, fallback: string): string {
	const c = value.trim();
	if (/^#[0-9a-fA-F]{6}$/.test(c)) return c.toLowerCase();
	if (/^[0-9a-fA-F]{6}$/.test(c)) return `#${c.toLowerCase()}`;
	return fallback;
}

export function parseDogTagColorPreset(raw: unknown): DogTagColorPreset | null {
	if (!raw || typeof raw !== 'object') return null;
	const p = raw as Partial<DogTagColorPreset> & { accentColor?: string };
	if (typeof p.id !== 'string' || !p.id.startsWith('custom-')) return null;
	if (typeof p.label !== 'string' || !p.label.trim()) return null;
	const textColor =
		typeof p.textColor === 'string'
			? p.textColor
			: typeof p.accentColor === 'string'
				? p.accentColor
				: null;
	if (typeof p.baseColor !== 'string' || !textColor || typeof p.textOutlineColor !== 'string') {
		return null;
	}
	return {
		id: p.id,
		label: p.label.trim(),
		baseColor: normalizeDogTagHexColor(p.baseColor, '#94a3b8'),
		textColor: normalizeDogTagHexColor(textColor, '#ffffff'),
		textOutlineColor: normalizeDogTagHexColor(p.textOutlineColor, '#ffffff'),
		textOutlineEnabled:
			typeof p.textOutlineEnabled === 'boolean' ? p.textOutlineEnabled : undefined
	};
}

export function isCustomDogTagPresetId(id: string): boolean {
	return id.startsWith('custom-');
}

export function loadLocalDogTagPresets(): DogTagColorPreset[] {
	try {
		const stored = localStorage.getItem(DOG_TAG_CUSTOM_PRESETS_LOCAL_KEY);
		if (!stored) return [];
		const parsed = JSON.parse(stored) as unknown;
		if (!Array.isArray(parsed)) return [];
		return parsed
			.map(parseDogTagColorPreset)
			.filter((p): p is DogTagColorPreset => p !== null);
	} catch {
		return [];
	}
}

export function saveLocalDogTagPresets(presets: DogTagColorPreset[]): void {
	try {
		localStorage.setItem(DOG_TAG_CUSTOM_PRESETS_LOCAL_KEY, JSON.stringify(presets));
	} catch {
		/* localStorage may be unavailable */
	}
}

export function clearLocalDogTagPresets(): void {
	try {
		localStorage.removeItem(DOG_TAG_CUSTOM_PRESETS_LOCAL_KEY);
	} catch {
		/* ignore */
	}
}

export async function fetchUserDogTagPresets(
	userId: string
): Promise<DogTagColorPreset[] | null> {
	const remote = await fetchUserDesignerPresets(userId, 'dogtag');
	if (remote === null) return null;
	return remote
		.map(parseDogTagColorPreset)
		.filter((p): p is DogTagColorPreset => p !== null);
}

export async function saveUserDogTagPresets(
	userId: string,
	presets: DogTagColorPreset[]
): Promise<{ success: true } | { success: false; error: string }> {
	return saveUserDesignerPresets(userId, 'dogtag', presets);
}

export async function loadUserDogTagPresets(userId: string): Promise<DogTagColorPreset[]> {
	return loadUserDesignerPresetsWithLocalMigration({
		userId,
		designerId: 'dogtag',
		parse: parseDogTagColorPreset,
		loadLocal: loadLocalDogTagPresets,
		clearLocal: clearLocalDogTagPresets
	});
}

export async function persistDogTagCustomPresets(
	userId: string | null | undefined,
	presets: DogTagColorPreset[]
): Promise<{ success: true } | { success: false; error: string }> {
	return persistDesignerCustomPresets(userId, 'dogtag', presets, saveLocalDogTagPresets);
}
