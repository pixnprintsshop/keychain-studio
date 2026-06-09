export type NamePuzzlePreviewMode = 'base' | 'pieces';

export interface NamePuzzleSettings {
	textContent: string;
	textSize: number;
	thickness: number;
	padding: number;
	tolerance: number;
	cornerRadius: number;
	baseColor: string;
	pieceColor: string;
	previewMode: NamePuzzlePreviewMode;
}

const STORAGE_KEY = 'name-puzzle-settings-v1';
const PERSIST_DEBOUNCE_MS = 300;

export const DEFAULT_NAME_PUZZLE_SETTINGS: NamePuzzleSettings = {
	textContent: 'NAME',
	textSize: 24,
	thickness: 10,
	padding: 8,
	tolerance: 0.3,
	cornerRadius: 5,
	baseColor: '#ffffff',
	pieceColor: '#f472b6',
	previewMode: 'base'
};

let lastSerialized: string | null = null;
let persistTimeout: ReturnType<typeof setTimeout> | null = null;
let pendingSettings: NamePuzzleSettings | null = null;

function clamp(n: number, min: number, max: number): number {
	if (!Number.isFinite(n)) return min;
	return Math.min(max, Math.max(min, n));
}

function normalizeHex(value: unknown, fallback: string): string {
	if (typeof value !== 'string') return fallback;
	const trimmed = value.trim();
	return /^#[0-9a-fA-F]{6}$/.test(trimmed) ? trimmed : fallback;
}

export function normalizePuzzleText(value: string): string {
	return value.toUpperCase();
}

function parseSettings(raw: unknown): NamePuzzleSettings {
	const defaults = DEFAULT_NAME_PUZZLE_SETTINGS;
	if (!raw || typeof raw !== 'object') return { ...defaults };

	const data = raw as Partial<NamePuzzleSettings>;
	const previewMode = data.previewMode === 'pieces' ? 'pieces' : 'base';

	return {
		textContent: normalizePuzzleText(
			typeof data.textContent === 'string' && data.textContent.trim()
				? data.textContent
				: defaults.textContent
		),
		textSize: clamp(data.textSize ?? defaults.textSize, 12, 60),
		thickness: clamp(data.thickness ?? defaults.thickness, 0.5, 30),
		padding: clamp(data.padding ?? defaults.padding, 0, 30),
		tolerance: clamp(data.tolerance ?? defaults.tolerance, 0, 2),
		cornerRadius: clamp(data.cornerRadius ?? defaults.cornerRadius, 0, 20),
		baseColor: normalizeHex(data.baseColor, defaults.baseColor),
		pieceColor: normalizeHex(data.pieceColor, defaults.pieceColor),
		previewMode
	};
}

/** Normalize text for persistence; sliders/colors are already bounded in the UI. */
function toPersistedPayload(settings: NamePuzzleSettings): NamePuzzleSettings {
	return {
		...settings,
		textContent: normalizePuzzleText(settings.textContent)
	};
}

export function loadNamePuzzleSettings(): NamePuzzleSettings {
	if (typeof window === 'undefined') return { ...DEFAULT_NAME_PUZZLE_SETTINGS };
	try {
		const stored = localStorage.getItem(STORAGE_KEY);
		if (!stored) return { ...DEFAULT_NAME_PUZZLE_SETTINGS };
		const parsed = parseSettings(JSON.parse(stored));
		lastSerialized = JSON.stringify(parsed);
		return parsed;
	} catch {
		return { ...DEFAULT_NAME_PUZZLE_SETTINGS };
	}
}

/** Immediate write — use on unmount or before navigation if needed. */
export function saveNamePuzzleSettings(settings: NamePuzzleSettings): void {
	if (typeof window === 'undefined') return;
	try {
		const payload = toPersistedPayload(settings);
		const serialized = JSON.stringify(payload);
		if (serialized === lastSerialized) return;
		localStorage.setItem(STORAGE_KEY, serialized);
		lastSerialized = serialized;
	} catch {
		/* localStorage may be unavailable */
	}
}

/** Debounced write — prefer this from reactive effects while sliders are moving. */
export function scheduleSaveNamePuzzleSettings(settings: NamePuzzleSettings): void {
	pendingSettings = settings;
	if (persistTimeout !== null) clearTimeout(persistTimeout);
	persistTimeout = setTimeout(() => {
		persistTimeout = null;
		const payload = pendingSettings;
		pendingSettings = null;
		if (payload) saveNamePuzzleSettings(payload);
	}, PERSIST_DEBOUNCE_MS);
}

/** Flush a pending debounced save (e.g. when leaving the designer). */
export function flushNamePuzzleSettingsSave(): void {
	if (persistTimeout !== null) {
		clearTimeout(persistTimeout);
		persistTimeout = null;
	}
	if (pendingSettings) {
		saveNamePuzzleSettings(pendingSettings);
		pendingSettings = null;
	}
}
