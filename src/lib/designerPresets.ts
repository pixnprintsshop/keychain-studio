import type { DesignerId } from '$lib/designers/ids';
import { supabase } from './supabase';

/** Designers that store custom color presets in `user_designer_presets`. */
export type DesignerPresetDesignerId = Extract<
	DesignerId,
	| 'multicolorWhistle'
	| 'standaloneName'
	| 'classicNameTag'
	| 'idNameTagV2'
	| 'whistleBagTag'
	| 'dogtag'
	| 'addressNumberSign'
	| 'doorNamePlaque'
>;

export const USER_DESIGNER_PRESETS_TABLE = 'user_designer_presets';

export async function fetchUserDesignerPresets(
	userId: string,
	designerId: DesignerPresetDesignerId
): Promise<unknown[] | null> {
	const { data, error } = await supabase
		.from(USER_DESIGNER_PRESETS_TABLE)
		.select('presets')
		.eq('user_id', userId)
		.eq('designer_id', designerId)
		.maybeSingle();

	if (error) {
		console.error(`Failed to fetch ${designerId} presets:`, error);
		return null;
	}

	if (!data?.presets || !Array.isArray(data.presets)) {
		return [];
	}

	return data.presets;
}

export async function saveUserDesignerPresets(
	userId: string,
	designerId: DesignerPresetDesignerId,
	presets: unknown[]
): Promise<{ success: true } | { success: false; error: string }> {
	const { error } = await supabase.from(USER_DESIGNER_PRESETS_TABLE).upsert(
		{
			user_id: userId,
			designer_id: designerId,
			presets,
			updated_at: new Date().toISOString()
		},
		{ onConflict: 'user_id,designer_id' }
	);

	if (error) {
		console.error(`Failed to save ${designerId} presets:`, error);
		return { success: false, error: error.message };
	}
	return { success: true };
}

/** Load account presets; migrates local-only presets to the account once. */
export async function loadUserDesignerPresetsWithLocalMigration<T>(options: {
	userId: string;
	designerId: DesignerPresetDesignerId;
	parse: (raw: unknown) => T | null;
	loadLocal: () => T[];
	clearLocal: () => void;
}): Promise<T[]> {
	const remote = await fetchUserDesignerPresets(options.userId, options.designerId);
	if (remote === null) {
		return options.loadLocal();
	}

	const parsed = remote
		.map(options.parse)
		.filter((p): p is T => p !== null);

	if (parsed.length > 0) {
		return parsed;
	}

	const local = options.loadLocal();
	if (local.length === 0) {
		return [];
	}

	const saved = await saveUserDesignerPresets(options.userId, options.designerId, local);
	if (saved.success) {
		options.clearLocal();
		return local;
	}

	return local;
}

export async function persistDesignerCustomPresets<T>(
	userId: string | null | undefined,
	designerId: DesignerPresetDesignerId,
	presets: T[],
	saveLocal: (presets: T[]) => void
): Promise<{ success: true } | { success: false; error: string }> {
	if (userId) {
		const result = await saveUserDesignerPresets(userId, designerId, presets);
		if (result.success) {
			saveLocal(presets);
		}
		return result;
	}
	saveLocal(presets);
	return { success: true };
}
