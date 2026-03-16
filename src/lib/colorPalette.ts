import { supabase } from './supabase';

export interface PaletteColor {
	hex: string;
	name?: string;
}

/** Built-in default palette for guests (common filament colors) */
export const DEFAULT_PALETTE: PaletteColor[] = [
	{ hex: '#ffffff', name: 'White' },
	{ hex: '#000000', name: 'Black' },
	{ hex: '#6b7280', name: 'Gray' },
	{ hex: '#9ca3af', name: 'Silver' },
	{ hex: '#ef4444', name: 'Red' },
	{ hex: '#3b82f6', name: 'Blue' },
	{ hex: '#22c55e', name: 'Green' },
	{ hex: '#eab308', name: 'Yellow' },
	{ hex: '#f97316', name: 'Orange' },
	{ hex: '#ec4899', name: 'Pink' },
	{ hex: '#ca8a04', name: 'Gold' },
	{ hex: '#b45309', name: 'Bronze' },
	{ hex: '#92400e', name: 'Brown' },
	{ hex: '#e5e7eb', name: 'Clear' }
];

function normalizeHex(hex: string): string {
	const h = hex.replace(/^#/, '').trim();
	if (h.length === 3) {
		return '#' + h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
	}
	return h.startsWith('#') ? hex : '#' + h;
}

export function getEffectivePalette(
	user: { id: string } | null,
	paletteFromDb: PaletteColor[] | null
): PaletteColor[] {
	if (user && paletteFromDb && paletteFromDb.length > 0) {
		return paletteFromDb;
	}
	return DEFAULT_PALETTE;
}

export async function fetchUserPalette(userId: string): Promise<PaletteColor[] | null> {
	const { data, error } = await supabase
		.from('user_color_palettes')
		.select('colors')
		.eq('user_id', userId)
		.maybeSingle();

	if (error) {
		console.error('Failed to fetch user palette:', error);
		return null;
	}

	if (!data?.colors || !Array.isArray(data.colors)) {
		return null;
	}

	return (data.colors as PaletteColor[]).map((c) => ({
		hex: normalizeHex(c.hex || '#ffffff'),
		name: typeof c.name === 'string' ? c.name : undefined
	}));
}

export async function saveUserPalette(
	userId: string,
	colors: PaletteColor[]
): Promise<{ success: true } | { success: false; error: string }> {
	const normalized = colors.map((c) => ({
		hex: normalizeHex(c.hex),
		name: c.name || undefined
	}));

	const { error } = await supabase.from('user_color_palettes').upsert(
		{
			user_id: userId,
			colors: normalized,
			updated_at: new Date().toISOString()
		},
		{ onConflict: 'user_id' }
	);

	if (error) {
		console.error('Failed to save user palette:', error);
		return { success: false, error: error.message };
	}
	return { success: true };
}
