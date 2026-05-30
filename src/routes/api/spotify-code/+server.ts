import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import {
	buildSpotifyCodeSvgUrl,
	parseSpotifyCodeSvgToLayout,
	parseSpotifyUri,
	validateSpotifyCodeLayout
} from '$lib/spotifyKeychainLayout';

function isSpotifyUri(uri: string): boolean {
	return /^spotify:(album|track|playlist|artist):[a-zA-Z0-9]+$/i.test(uri);
}

export const GET: RequestHandler = async ({ url }) => {
	const raw = url.searchParams.get('uri')?.trim() ?? '';
	const normalized = parseSpotifyUri(raw) ?? (isSpotifyUri(raw) ? raw : null);
	if (!normalized) {
		return json({ error: 'Invalid Spotify album, track, playlist, or artist URI' }, { status: 400 });
	}

	try {
		const downloadUrl = buildSpotifyCodeSvgUrl(normalized);
		const res = await fetch(downloadUrl, {
			headers: {
				Accept: 'image/svg+xml,text/plain,*/*',
				'User-Agent': 'pixnprints/1.0'
			}
		});
		if (!res.ok) {
			return json({ error: 'Spotify code service unavailable' }, { status: 502 });
		}
		const svg = await res.text();
		const layout = parseSpotifyCodeSvgToLayout(svg);
		if (!layout) {
			return json({ error: 'Could not parse Spotify code SVG' }, { status: 502 });
		}
		const validation = validateSpotifyCodeLayout(layout);
		if (!validation.ok) {
			return json({ error: validation.message ?? 'Incomplete Spotify code' }, { status: 502 });
		}
		return json(layout, {
			headers: {
				'Content-Type': 'application/json; charset=utf-8',
				'Cache-Control': 'no-store'
			}
		});
	} catch {
		return json({ error: 'Failed to fetch Spotify code' }, { status: 502 });
	}
};
