/** Spotify URI + bar layout parsing (no Three.js — safe for API routes). */

const SPOTIFY_URI_TYPES = ['album', 'track', 'playlist', 'artist'] as const;
export type SpotifyUriType = (typeof SPOTIFY_URI_TYPES)[number];

const SPOTIFY_URI_RE = new RegExp(
	`^spotify:(${SPOTIFY_URI_TYPES.join('|')}):([a-zA-Z0-9]+)$`,
	'i'
);

export const SPOTIFY_CODE_IMAGE_WIDTH = 640;
const SPOTIFY_CODE_MIN_BAR_X = 95;
const SPOTIFY_CODE_MAX_BAR_WIDTH = 50;
const MIN_EXPECTED_BARS = 12;

export interface SpotifyCodeBar {
	x: number;
	y: number;
	width: number;
	height: number;
	/** Corner radius in code units (from SVG `rx`, or derived). */
	cornerRadius?: number;
}

export interface SpotifyCodeLayout {
	width: number;
	height: number;
	bars: SpotifyCodeBar[];
}

export interface SpotifyCodeLayoutValidation {
	ok: boolean;
	barCount: number;
	message?: string;
}

/** Parse open.spotify.com links or spotify: URIs into `spotify:type:id`. */
export function parseSpotifyUri(input: string): string | null {
	const trimmed = (input ?? '').trim();
	if (!trimmed) return null;

	const direct = trimmed.match(SPOTIFY_URI_RE);
	if (direct) return `spotify:${direct[1].toLowerCase()}:${direct[2]}`;

	try {
		const url = new URL(trimmed.startsWith('http') ? trimmed : `https://${trimmed}`);
		const parts = url.pathname.split('/').filter(Boolean);
		for (let i = 0; i < parts.length - 1; i++) {
			const type = parts[i].toLowerCase();
			if (!SPOTIFY_URI_TYPES.includes(type as SpotifyUriType)) continue;
			const id = parts[i + 1].split('?')[0];
			if (/^[a-zA-Z0-9]+$/.test(id)) return `spotify:${type}:${id}`;
		}
	} catch {
		// not a URL
	}

	return null;
}

export function buildSpotifyCodePngUrl(spotifyUri: string): string {
	const encoded = encodeURIComponent(spotifyUri);
	return `https://scannables.scdn.co/uri/plain/png/FFFFFF/black/${SPOTIFY_CODE_IMAGE_WIDTH}/${encoded}`;
}

export function buildSpotifyCodeSvgUrl(spotifyUri: string): string {
	const encoded = encodeURIComponent(spotifyUri);
	return `https://www.spotifycodes.com/downloadCode.php?uri=svg/FFFFFF/black/${SPOTIFY_CODE_IMAGE_WIDTH}/${encoded}`;
}

/** @deprecated Use {@link buildSpotifyCodeSvgUrl}. */
export function buildSpotifyCodeDownloadUrl(spotifyUri: string): string {
	return buildSpotifyCodeSvgUrl(spotifyUri);
}

function readSvgAttr(tag: string, name: string, fallback = 0): number {
	const match = tag.match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']+)["']`, 'i'));
	if (!match) return fallback;
	const value = Number.parseFloat(match[1]);
	return Number.isFinite(value) ? value : fallback;
}

function parseSvgViewBox(svgText: string): { width: number; height: number } {
	const match = svgText.match(/viewBox\s*=\s*["']([^"']+)["']/i);
	if (match) {
		const parts = match[1].trim().split(/\s+/).map(Number);
		if (parts.length === 4 && parts.every(Number.isFinite)) {
			return { width: parts[2], height: parts[3] };
		}
	}
	return {
		width: readSvgAttr(svgText, 'width', SPOTIFY_CODE_IMAGE_WIDTH),
		height: readSvgAttr(svgText, 'height', SPOTIFY_CODE_IMAGE_WIDTH / 4)
	};
}

export function parseSpotifyBarRectsFromSvg(svgText: string): SpotifyCodeBar[] {
	const bars: SpotifyCodeBar[] = [];
	const tagRe = /<rect\b[^>]*\/?>/gi;
	let match: RegExpExecArray | null;

	while ((match = tagRe.exec(svgText)) !== null) {
		const tag = match[0];
		const x = readSvgAttr(tag, 'x');
		const width = readSvgAttr(tag, 'width');
		const height = readSvgAttr(tag, 'height');
		if (x < SPOTIFY_CODE_MIN_BAR_X) continue;
		if (width > SPOTIFY_CODE_MAX_BAR_WIDTH || width <= 0 || height <= 0) continue;
		const rx = readSvgAttr(tag, 'rx');
		bars.push({
			x,
			y: readSvgAttr(tag, 'y'),
			width,
			height,
			cornerRadius: rx > 0 ? rx : undefined
		});
	}

	bars.sort((a, b) => a.x - b.x || a.y - b.y);
	return bars;
}

export function parseSpotifyCodeSvgToLayout(svgText: string): SpotifyCodeLayout | null {
	const trimmed = svgText.trim();
	if (!trimmed.includes('<svg')) return null;
	const { width, height } = parseSvgViewBox(trimmed);
	const bars = parseSpotifyBarRectsFromSvg(trimmed);
	if (bars.length === 0) return null;
	return { width, height, bars };
}

export function isSpotifyCodeLayout(value: unknown): value is SpotifyCodeLayout {
	if (!value || typeof value !== 'object') return false;
	const layout = value as SpotifyCodeLayout;
	return (
		typeof layout.width === 'number' &&
		typeof layout.height === 'number' &&
		Array.isArray(layout.bars) &&
		layout.bars.every(
			(bar) =>
				typeof bar.x === 'number' &&
				typeof bar.y === 'number' &&
				typeof bar.width === 'number' &&
				typeof bar.height === 'number'
		)
	);
}

export function validateSpotifyCodeLayout(layout: SpotifyCodeLayout): SpotifyCodeLayoutValidation {
	const barCount = layout.bars.length;
	if (barCount === 0) {
		return {
			ok: false,
			barCount: 0,
			message: 'No scannable bars found — try reloading the Spotify link'
		};
	}
	if (barCount < MIN_EXPECTED_BARS) {
		return {
			ok: false,
			barCount,
			message: `Code image incomplete (${barCount} bars). Reload the Spotify link.`
		};
	}
	return { ok: true, barCount };
}
