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

export function loadNamePuzzleSettings(): NamePuzzleSettings {
	try {
		const stored = localStorage.getItem(STORAGE_KEY);
		if (!stored) return { ...DEFAULT_NAME_PUZZLE_SETTINGS };
		return parseSettings(JSON.parse(stored));
	} catch {
		return { ...DEFAULT_NAME_PUZZLE_SETTINGS };
	}
}

export function saveNamePuzzleSettings(settings: NamePuzzleSettings): void {
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(parseSettings(settings)));
	} catch {
		/* localStorage may be unavailable */
	}
}
