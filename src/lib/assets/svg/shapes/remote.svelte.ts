/**
 * SVG icon library backed by Supabase.
 *
 * Catalog lives in the `public.canvas_studio_shapes` table — see
 * `supabase/migrations/*_canvas_studio_shapes.sql`. Each row carries:
 *
 *   id          – stable shapeId persisted in saved documents
 *   label       – display name in the picker
 *   category    – free-form group name; picker tabs come from distinct values
 *   url         – absolute SVG URL (icones.js.org / Iconify CDN / any CORS-OK
 *                 direct link)
 *   sort_order  – ascending within a category
 *   enabled     – soft delete / preview gate
 *
 * To add an icon: pick one on icones.js.org, copy the SVG URL (e.g.
 * `https://api.iconify.design/mingcute/cake-fill.svg`), and insert a row.
 *
 * Icons should use `fill="currentColor"` on visible paths so the picker
 * preview adopts text color. Decorator `<path fill="none">` entries are
 * filtered automatically by the extruder.
 */

import { supabase } from '$lib/supabase';
import type { ShapeDefinition } from './index';

const TABLE = 'canvas_studio_shapes';
const CACHE_KEY = 'canvas-studio-remote-shapes-v4';
const CACHE_TTL_MS = 60 * 60 * 1000; // 1h

interface ShapeRow {
	id: string;
	label: string;
	category: string;
	url: string;
	sort_order: number;
}

interface CachedPayload {
	ts: number;
	shapes: ShapeDefinition[];
}

class RemoteShapesStore {
	shapes = $state<ShapeDefinition[]>([]);
	loading = $state(false);
	error = $state<string | null>(null);

	private index = new Map<string, ShapeDefinition>();
	private loadPromise: Promise<void> | null = null;

	/** Synchronous lookup used by `getShape` in `./index.ts`. */
	get(id: string): ShapeDefinition | undefined {
		return this.index.get(id);
	}

	/** Idempotent: kicks off a single load + background refresh. */
	ensure(): Promise<void> {
		if (this.loadPromise) return this.loadPromise;
		this.loadPromise = this.load();
		return this.loadPromise;
	}

	/** Force a refresh, ignoring cache TTL. */
	async refresh(): Promise<void> {
		this.loadPromise = null;
		await this.ensure();
	}

	private async load() {
		// 1. Hydrate from cache so the picker is populated synchronously.
		const cached = readCache();
		if (cached) this.apply(cached);

		// 2. Network refresh (best-effort).
		this.loading = true;
		try {
			const fresh = await fetchRemoteShapes();
			this.apply(fresh);
			writeCache(fresh);
			this.error = null;
		} catch (e) {
			console.warn('Canvas Studio: remote shapes load failed', e);
			this.error = e instanceof Error ? e.message : String(e);
		} finally {
			this.loading = false;
		}
	}

	private apply(shapes: ShapeDefinition[]) {
		this.shapes = shapes;
		this.index.clear();
		for (const s of shapes) this.index.set(s.id, s);
	}
}

export const remoteShapesStore = new RemoteShapesStore();

// ─── Network / cache helpers ──────────────────────────────────────────────

async function fetchRemoteShapes(): Promise<ShapeDefinition[]> {
	const { data, error } = await supabase
		.from(TABLE)
		.select('id, label, category, url, sort_order')
		.order('category', { ascending: true })
		.order('sort_order', { ascending: true })
		.order('label', { ascending: true });
	if (error) throw error;

	const rows = (data ?? []) as ShapeRow[];

	const results = await Promise.all(
		rows.map(async (row): Promise<ShapeDefinition | null> => {
			try {
				const res = await fetch(row.url, { cache: 'force-cache' });
				if (!res.ok) throw new Error(`HTTP ${res.status}`);
				const rawSvg = await res.text();
				return {
					id: row.id,
					label: row.label,
					category: row.category,
					rawSvg
				};
			} catch (e) {
				console.warn(`Canvas Studio: failed to fetch ${row.url}`, e);
				return null;
			}
		})
	);

	return results.filter((s): s is ShapeDefinition => s !== null);
}

function readCache(): ShapeDefinition[] | null {
	try {
		const raw = localStorage.getItem(CACHE_KEY);
		if (!raw) return null;
		const parsed = JSON.parse(raw) as CachedPayload;
		if (!parsed || !Array.isArray(parsed.shapes)) return null;
		if (Date.now() - parsed.ts > CACHE_TTL_MS) return null;
		return parsed.shapes;
	} catch {
		return null;
	}
}

function writeCache(shapes: ShapeDefinition[]) {
	try {
		const payload: CachedPayload = { ts: Date.now(), shapes };
		localStorage.setItem(CACHE_KEY, JSON.stringify(payload));
	} catch (e) {
		console.warn('Canvas Studio: failed to cache remote shapes', e);
	}
}
