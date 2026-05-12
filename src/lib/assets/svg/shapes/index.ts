/**
 * Public types + lookup for the Canvas Studio SVG icon library.
 *
 * The catalog is sourced entirely from Supabase Storage with a
 * folder-as-category layout — see `./remote.svelte.ts`. Originals for the
 * bucket files live as static assets under `src/lib/assets/svg/*.svg` for
 * reference / (re-)uploading, but they are no longer imported at runtime.
 */

import { remoteShapesStore } from './remote.svelte';

/** Free-form category string sourced from the DB. */
export type ShapeCategory = string;

export interface ShapeDefinition {
	id: string;
	category: ShapeCategory;
	label: string;
	/** Raw SVG markup as fetched from the `print-studio` bucket. */
	rawSvg: string;
}

/** Look up a shape definition by id. Returns `undefined` until the remote
 *  catalog has finished its initial load (the store hydrates from a
 *  localStorage cache first to keep this window short for repeat visitors). */
export function getShape(id: string): ShapeDefinition | undefined {
	return remoteShapesStore.get(id);
}
