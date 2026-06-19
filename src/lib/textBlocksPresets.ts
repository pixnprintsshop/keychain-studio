export type TextBlocksColorPreset = {
	id: string;
	label: string;
	frameColor: string;
	insetColor: string;
	textColor: string;
	caseColor: string;
};

/** Curated frame · inset · letter · case combinations for text blocks. */
export const TEXT_BLOCKS_COLOR_PRESETS: TextBlocksColorPreset[] = [
	{
		id: 'classic-blue',
		label: 'Classic Blue',
		frameColor: '#2563eb',
		insetColor: '#dbeafe',
		textColor: '#1e3a8a',
		caseColor: '#93c5fd'
	},
	{
		id: 'midnight',
		label: 'Midnight',
		frameColor: '#1e293b',
		insetColor: '#475569',
		textColor: '#f8fafc',
		caseColor: '#334155'
	},
	{
		id: 'coral-pop',
		label: 'Coral Pop',
		frameColor: '#f43f5e',
		insetColor: '#ffe4e6',
		textColor: '#9f1239',
		caseColor: '#fda4af'
	},
	{
		id: 'mint-fresh',
		label: 'Mint Fresh',
		frameColor: '#10b981',
		insetColor: '#d1fae5',
		textColor: '#065f46',
		caseColor: '#6ee7b7'
	},
	{
		id: 'lavender',
		label: 'Lavender',
		frameColor: '#8b5cf6',
		insetColor: '#ede9fe',
		textColor: '#5b21b6',
		caseColor: '#c4b5fd'
	},
	{
		id: 'sunshine',
		label: 'Sunshine',
		frameColor: '#f59e0b',
		insetColor: '#fef3c7',
		textColor: '#92400e',
		caseColor: '#fcd34d'
	},
	{
		id: 'ocean',
		label: 'Ocean',
		frameColor: '#0ea5e9',
		insetColor: '#e0f2fe',
		textColor: '#075985',
		caseColor: '#7dd3fc'
	},
	{
		id: 'cherry',
		label: 'Cherry',
		frameColor: '#dc2626',
		insetColor: '#fecaca',
		textColor: '#7f1d1d',
		caseColor: '#f87171'
	},
	{
		id: 'slate',
		label: 'Slate',
		frameColor: '#64748b',
		insetColor: '#f1f5f9',
		textColor: '#0f172a',
		caseColor: '#94a3b8'
	},
	{
		id: 'hot-pink',
		label: 'Hot Pink',
		frameColor: '#ec4899',
		insetColor: '#fce7f3',
		textColor: '#831843',
		caseColor: '#f9a8d4'
	},
	{
		id: 'forest',
		label: 'Forest',
		frameColor: '#15803d',
		insetColor: '#bbf7d0',
		textColor: '#14532d',
		caseColor: '#4ade80'
	},
	{
		id: 'electric',
		label: 'Electric',
		frameColor: '#6366f1',
		insetColor: '#c7d2fe',
		textColor: '#312e81',
		caseColor: '#a5b4fc'
	},
	{
		id: 'peach',
		label: 'Peach',
		frameColor: '#fb923c',
		insetColor: '#ffedd5',
		textColor: '#9a3412',
		caseColor: '#fdba74'
	},
	{
		id: 'noir-gold',
		label: 'Noir Gold',
		frameColor: '#171717',
		insetColor: '#525252',
		textColor: '#fbbf24',
		caseColor: '#3f3f46'
	},
	{
		id: 'pastel-pop',
		label: 'Pastel Pop',
		frameColor: '#a78bfa',
		insetColor: '#fef08a',
		textColor: '#db2777',
		caseColor: '#f0abfc'
	},
	{
		id: 'teal-cream',
		label: 'Teal Cream',
		frameColor: '#0d9488',
		insetColor: '#fef9c3',
		textColor: '#134e4a',
		caseColor: '#2dd4bf'
	},
	{
		id: 'berry-cream',
		label: 'Berry Cream',
		frameColor: '#9333ea',
		insetColor: '#fae8ff',
		textColor: '#581c87',
		caseColor: '#d8b4fe'
	},
	{
		id: 'skyline',
		label: 'Skyline',
		frameColor: '#0284c7',
		insetColor: '#ffffff',
		textColor: '#0c4a6e',
		caseColor: '#38bdf8'
	}
];

export function normalizeTextBlocksHexColor(value: string): string {
	const raw = (value ?? '').trim().toLowerCase();
	if (/^#[0-9a-f]{6}$/.test(raw)) return raw;
	if (/^[0-9a-f]{6}$/.test(raw)) return `#${raw}`;
	if (/^#[0-9a-f]{3}$/.test(raw)) {
		const h = raw.slice(1);
		return `#${h[0]}${h[0]}${h[1]}${h[1]}${h[2]}${h[2]}`;
	}
	return raw;
}

export function findMatchingTextBlocksPresetId(
	presets: TextBlocksColorPreset[],
	colors: {
		frameColor: string;
		insetColor: string;
		textColor: string;
		caseColor: string;
	}
): string | null {
	const frame = normalizeTextBlocksHexColor(colors.frameColor);
	const inset = normalizeTextBlocksHexColor(colors.insetColor);
	const text = normalizeTextBlocksHexColor(colors.textColor);
	const caseC = normalizeTextBlocksHexColor(colors.caseColor);
	for (const preset of presets) {
		if (
			normalizeTextBlocksHexColor(preset.frameColor) === frame &&
			normalizeTextBlocksHexColor(preset.insetColor) === inset &&
			normalizeTextBlocksHexColor(preset.textColor) === text &&
			normalizeTextBlocksHexColor(preset.caseColor) === caseC
		) {
			return preset.id;
		}
	}
	return null;
}
