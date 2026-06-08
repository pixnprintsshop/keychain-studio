/**
 * Export counters backed by Supabase:
 * - platform_total: all successful exports from every user (global)
 * - byDesigner: exports per designer route id (global per designer)
 * - userExports: signed-in user's lifetime export count
 */

import type { DesignerId } from '$lib/designers/ids';
import { supabase } from './supabase';

/** Pre-tracking exports (before Supabase counter). Override with VITE_EXPORT_STATS_BASE. */
const LEGACY_UNTRACKED_EXPORTS = 1229;

const DISPLAY_BASE = (() => {
	const raw = import.meta.env.VITE_EXPORT_STATS_BASE as string | undefined;
	if (raw === undefined || raw === '') return LEGACY_UNTRACKED_EXPORTS;
	const n = Number.parseInt(raw, 10);
	return Number.isFinite(n) && n >= 0 ? n : LEGACY_UNTRACKED_EXPORTS;
})();

let platformRaw = $state(0);
let userExportCount = $state(0);
let byDesigner = $state<Record<string, number>>({});
let loaded = $state(false);
let userId: string | null = $state(null);

export const exportStats = {
	/** All users, all designers — optional marketing base from env. */
	get platformTotal(): number {
		return DISPLAY_BASE + platformRaw;
	},
	get userExports(): number {
		return userExportCount;
	},
	get byDesigner(): Readonly<Record<string, number>> {
		return byDesigner;
	},
	get loaded(): boolean {
		return loaded;
	},
	get displayBase(): number {
		return DISPLAY_BASE;
	}
};

export function getDesignerExportCount(designerId: string): number {
	return byDesigner[designerId] ?? 0;
}

function applyPlatformTotal(value: unknown) {
	platformRaw =
		typeof value === 'number'
			? Math.max(0, value)
			: typeof value === 'string'
				? Math.max(0, Number.parseInt(value, 10) || 0)
				: 0;
}

function applyUserTotal(value: unknown) {
	userExportCount = typeof value === 'number' ? Math.max(0, value) : 0;
}

function applyDesignerRows(rows: unknown) {
	const next: Record<string, number> = {};
	if (!Array.isArray(rows)) {
		byDesigner = next;
		return;
	}
	for (const row of rows) {
		if (!row || typeof row !== 'object') continue;
		const id = (row as { designer_id?: string }).designer_id;
		const count = (row as { export_count?: number | string }).export_count;
		if (!id) continue;
		const n =
			typeof count === 'number'
				? count
				: typeof count === 'string'
					? Number.parseInt(count, 10)
					: 0;
		next[id] = Math.max(0, Number.isFinite(n) ? n : 0);
	}
	byDesigner = next;
}

/** Load global totals and per-designer breakdown; optional per-user count when signed in. */
export async function loadExportStats(uid: string | null): Promise<void> {
	userId = uid;
	loaded = false;
	try {
		const platformPromise = supabase.rpc('get_platform_export_stats');
		const designerPromise = supabase.rpc('get_designer_export_stats');
		const userPromise = uid
			? supabase.rpc('get_user_export_stats')
			: Promise.resolve({ data: 0, error: null });

		const [platformRes, designerRes, userRes] = await Promise.all([
			platformPromise,
			designerPromise,
			userPromise
		]);

		if (platformRes.error) {
			console.warn('[exportStats] platform load failed:', platformRes.error.message);
			platformRaw = 0;
		} else {
			applyPlatformTotal(platformRes.data);
		}

		if (designerRes.error) {
			console.warn('[exportStats] designer load failed:', designerRes.error.message);
			byDesigner = {};
		} else {
			applyDesignerRows(designerRes.data);
		}

		if (userRes.error) {
			console.warn('[exportStats] user load failed:', userRes.error.message);
			userExportCount = 0;
		} else {
			applyUserTotal(userRes.data);
		}
	} catch (e) {
		console.warn('[exportStats] load failed:', e);
		platformRaw = 0;
		userExportCount = 0;
		byDesigner = {};
	} finally {
		loaded = true;
	}
}

export function formatExportCount(n: number): string {
	return new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(Math.max(0, n));
}

/**
 * Increment global, per-user, and per-designer counters after a successful export.
 */
export function recordExport(
	designerId: DesignerId | null,
	format: 'stl' | '3mf' | 'bambu_studio' = 'stl'
): void {
	if (!userId) return;

	void (async () => {
		try {
			const { data, error } = await supabase.rpc('record_platform_export', {
				p_designer_id: designerId ?? undefined,
				p_format: format
			});
			if (error) {
				console.warn('[exportStats] record failed:', error.message);
				return;
			}
			const row = (Array.isArray(data) ? data[0] : data) as
				| {
						platform_total?: number | string;
						user_total?: number;
						designer_total?: number | string;
				  }
				| undefined;
			if (row) {
				if (row.platform_total != null) applyPlatformTotal(row.platform_total);
				if (typeof row.user_total === 'number') applyUserTotal(row.user_total);
				if (designerId && row.designer_total != null) {
					const n =
						typeof row.designer_total === 'number'
							? row.designer_total
							: Number.parseInt(String(row.designer_total), 10) || 0;
					byDesigner = { ...byDesigner, [designerId]: Math.max(0, n) };
				}
			}
		} catch (e) {
			console.warn('[exportStats] record failed:', e);
		}
	})();
}
