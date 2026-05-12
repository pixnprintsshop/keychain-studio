import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { createClient } from '@supabase/supabase-js';
import { env } from '$env/dynamic/private';

const ICONIFY_BASE = 'https://api.iconify.design';
/** `collection:icon-name` — Iconify collection + icon id. */
const ICON_REF_RE = /^([a-z0-9][a-z0-9_-]*):([a-z0-9][a-z0-9._-]*)$/i;
const MAX_REF_LEN = 200;

function defaultLabel(iconName: string): string {
	return iconName
		.split('-')
		.filter(Boolean)
		.map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
		.join(' ');
}

function shapeRowId(collection: string, iconName: string): string {
	return `${collection.toLowerCase()}__${iconName.toLowerCase()}`;
}

function iconifySvgUrl(collection: string, iconName: string): string {
	const c = collection.toLowerCase();
	const n = iconName.toLowerCase();
	return `${ICONIFY_BASE}/${c}:${n}.svg`;
}

/** POST /canvas/upload — insert Iconify SVG into `canvas_studio_shapes` (admin). */
export const POST: RequestHandler = async ({ request }) => {
	const authHeader = request.headers.get('Authorization');
	const expected = env.CANVAS_STUDIO_UPLOAD_SECRET;
	if (!expected || authHeader !== `Bearer ${expected}`) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	const supabaseUrl = env.VITE_SUPABASE_URL;
	const supabaseServiceKey = env.SUPABASE_SERVICE_ROLE_KEY;
	if (!supabaseUrl || !supabaseServiceKey) {
		return json({ error: 'Server not configured' }, { status: 500 });
	}

	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return json({ error: 'Invalid JSON' }, { status: 400 });
	}

	const raw = (body ?? {}) as {
		icon?: string;
		category?: string;
		label?: string;
		sort_order?: number;
	};

	const ref = typeof raw.icon === 'string' ? raw.icon.trim() : '';
	if (!ref || ref.length > MAX_REF_LEN) {
		return json(
			{ error: 'Body must include non-empty "icon" as collection:icon-name' },
			{ status: 400 }
		);
	}

	const m = ref.match(ICON_REF_RE);
	if (!m) {
		return json(
			{
				error:
					'Invalid "icon" format. Expected Iconify ref, e.g. "mingcute:android-2-line" (collection:icon-name).'
			},
			{ status: 400 }
		);
	}

	const collection = m[1].toLowerCase();
	const iconName = m[2].toLowerCase();
	const url = iconifySvgUrl(collection, iconName);

	let verify: Response;
	try {
		verify = await fetch(url, { method: 'GET', redirect: 'follow' });
	} catch (e) {
		console.error('canvas/upload: Iconify fetch failed', e);
		return json({ error: 'Could not reach Iconify to verify the icon' }, { status: 502 });
	}

	if (!verify.ok) {
		return json(
			{ error: `Icon not found or unavailable (${verify.status})`, url },
			{ status: 400 }
		);
	}

	const snippet = (await verify.text()).slice(0, 400).toLowerCase();
	if (!snippet.includes('<svg')) {
		return json({ error: 'URL did not return SVG content', url }, { status: 400 });
	}

	const category =
		typeof raw.category === 'string' && raw.category.trim()
			? raw.category.trim()
			: collection;
	const label =
		typeof raw.label === 'string' && raw.label.trim()
			? raw.label.trim()
			: defaultLabel(iconName);
	const sort_order =
		typeof raw.sort_order === 'number' && Number.isFinite(raw.sort_order)
			? Math.round(raw.sort_order)
			: 100;

	const id = shapeRowId(collection, iconName);

	const supabase = createClient(supabaseUrl, supabaseServiceKey);
	const { data, error } = await supabase
		.from('canvas_studio_shapes')
		.insert({
			id,
			label,
			category,
			url,
			sort_order,
			enabled: true
		})
		.select('id, label, category, url, sort_order, enabled')
		.single();

	if (error) {
		if (error.code === '23505') {
			return json(
				{ error: 'This icon is already in the catalog', id, url },
				{ status: 409 }
			);
		}
		console.error('canvas/upload: insert error', error);
		return json({ error: error.message }, { status: 500 });
	}

	return json({ ok: true, row: data });
};
