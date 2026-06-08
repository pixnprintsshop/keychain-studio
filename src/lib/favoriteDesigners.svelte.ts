import { isDesignerId, type DesignerId } from '$lib/designers/ids';
import { supabase } from '$lib/supabase';

const STORAGE_KEY = 'pixnprints-favorite-designers';

let favoriteIds = $state<DesignerId[]>([]);
let loaded = $state(false);
let userId: string | null = $state(null);

export const favoriteDesigners = {
	get ids(): readonly DesignerId[] {
		return favoriteIds;
	},
	get loaded(): boolean {
		return loaded;
	}
};

function parseDesignerIds(raw: unknown): DesignerId[] {
	if (!Array.isArray(raw)) return [];
	const seen = new Set<DesignerId>();
	const out: DesignerId[] = [];
	for (const entry of raw) {
		if (typeof entry !== 'string' || !isDesignerId(entry) || seen.has(entry)) continue;
		seen.add(entry);
		out.push(entry);
	}
	return out;
}

function loadLocalFavorites(): DesignerId[] {
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (!raw) return [];
		return parseDesignerIds(JSON.parse(raw));
	} catch {
		return [];
	}
}

function saveLocalFavorites(ids: DesignerId[]) {
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(ids));
	} catch {
		/* localStorage may be unavailable */
	}
}

async function fetchRemoteFavorites(uid: string): Promise<DesignerId[] | null> {
	const { data, error } = await supabase
		.from('user_favorite_designers')
		.select('designer_ids')
		.eq('user_id', uid)
		.maybeSingle();

	if (error) {
		console.warn('[favoriteDesigners] fetch failed:', error.message);
		return null;
	}

	if (!data?.designer_ids) return [];
	return parseDesignerIds(data.designer_ids);
}

async function saveRemoteFavorites(uid: string, ids: DesignerId[]): Promise<void> {
	const { error } = await supabase.from('user_favorite_designers').upsert(
		{
			user_id: uid,
			designer_ids: ids,
			updated_at: new Date().toISOString()
		},
		{ onConflict: 'user_id' }
	);
	if (error) console.warn('[favoriteDesigners] save failed:', error.message);
}

function mergeFavoriteLists(remote: DesignerId[], local: DesignerId[]): DesignerId[] {
	const seen = new Set<DesignerId>();
	const merged: DesignerId[] = [];
	for (const id of remote) {
		if (seen.has(id)) continue;
		seen.add(id);
		merged.push(id);
	}
	for (const id of local) {
		if (seen.has(id)) continue;
		seen.add(id);
		merged.push(id);
	}
	return merged;
}

export function isFavoriteDesigner(id: string): boolean {
	return isDesignerId(id) && favoriteIds.includes(id);
}

export function favoriteSortIndex(id: string): number {
	if (!isDesignerId(id)) return -1;
	return favoriteIds.indexOf(id);
}

export async function loadFavoriteDesigners(uid: string | null): Promise<void> {
	userId = uid;
	loaded = false;
	const local = loadLocalFavorites();

	if (!uid) {
		favoriteIds = local;
		loaded = true;
		return;
	}

	try {
		const remote = await fetchRemoteFavorites(uid);
		if (remote === null) {
			favoriteIds = local;
		} else if (remote.length === 0 && local.length > 0) {
			favoriteIds = local;
			await saveRemoteFavorites(uid, local);
		} else {
			const merged = mergeFavoriteLists(remote, local);
			favoriteIds = merged;
			if (merged.length !== remote.length || merged.some((id, i) => remote[i] !== id)) {
				await saveRemoteFavorites(uid, merged);
			}
		}
		saveLocalFavorites(favoriteIds);
	} catch (e) {
		console.warn('[favoriteDesigners] load failed:', e);
		favoriteIds = local;
	} finally {
		loaded = true;
	}
}

export async function toggleFavoriteDesigner(id: string): Promise<void> {
	if (!isDesignerId(id)) return;

	const next = favoriteIds.includes(id)
		? favoriteIds.filter((entry) => entry !== id)
		: [id, ...favoriteIds];

	favoriteIds = next;
	saveLocalFavorites(next);

	if (userId) {
		await saveRemoteFavorites(userId, next);
	}
}
