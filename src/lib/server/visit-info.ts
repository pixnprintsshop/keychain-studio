/**
 * Server-only helpers for resolving the visitor's IP address and country.
 *
 * Strategy (cheapest → most expensive):
 *  1. Trust the platform's geo headers when present (`x-vercel-ip-country` on
 *     Vercel, `cf-ipcountry` on Cloudflare). Free, instant.
 *  2. Fall back to ipify (public IP) + ipinfo.io (country lookup) when the
 *     platform doesn't expose them (e.g. local dev). Both calls are cached
 *     in-memory so we don't round-trip on every request.
 */

import { env } from '$env/dynamic/private';

const DEFAULT_FLAG = '🌐';
const IPIFY_CACHE_TTL_MS = 5 * 60 * 1000;
const IPINFO_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
/** Soft cap on the in-memory ipinfo cache to avoid unbounded growth. */
const IPINFO_CACHE_MAX = 1000;

let ipifyCache: { ip: string; expiresAt: number } | null = null;
const ipinfoCountryCache = new Map<string, { country: string | undefined; expiresAt: number }>();

function pruneIpinfoCache(now: number): void {
	if (ipinfoCountryCache.size < IPINFO_CACHE_MAX) return;
	for (const [k, v] of ipinfoCountryCache) {
		if (v.expiresAt <= now) ipinfoCountryCache.delete(k);
	}
	if (ipinfoCountryCache.size < IPINFO_CACHE_MAX) return;
	// Still over budget — evict in insertion order (Map iterates oldest first).
	const evict = ipinfoCountryCache.size - IPINFO_CACHE_MAX + 1;
	let i = 0;
	for (const k of ipinfoCountryCache.keys()) {
		if (i++ >= evict) break;
		ipinfoCountryCache.delete(k);
	}
}

/** Convert a 2-letter ISO country code into its 🇺🇳 emoji flag. Falls back to a globe glyph. */
export function getFlag(code?: string): string {
	if (!code || code.trim().length < 2) return DEFAULT_FLAG;
	const letters = code.trim().toUpperCase().slice(0, 2).split('');
	const points = letters.map((ch) => 127397 + ch.charCodeAt(0));
	try {
		return String.fromCodePoint(...points) || DEFAULT_FLAG;
	} catch {
		return DEFAULT_FLAG;
	}
}

function getRequestIp(request: Request): string | undefined {
	const xff = request.headers.get('x-forwarded-for');
	if (xff) {
		const first = xff.split(',')[0]?.trim();
		if (first) return first;
	}
	const real = request.headers.get('x-real-ip');
	if (real?.trim()) return real.trim();
	const cf = request.headers.get('cf-connecting-ip');
	if (cf?.trim()) return cf.trim();
	return undefined;
}

function getCountryFromHeaders(request: Request): string | undefined {
	const c = request.headers.get('x-vercel-ip-country') ?? request.headers.get('cf-ipcountry');
	if (c && c.trim().length >= 2) return c.trim().toUpperCase();
	return undefined;
}

async function getPublicIpWithCache(): Promise<string | undefined> {
	const now = Date.now();
	if (ipifyCache && ipifyCache.expiresAt > now) return ipifyCache.ip;
	try {
		const ipRes = await fetch('https://api.ipify.org?format=json');
		if (!ipRes.ok) return undefined;
		const ipJson = (await ipRes.json()) as { ip?: string };
		const ip = typeof ipJson.ip === 'string' && ipJson.ip.trim() ? ipJson.ip.trim() : undefined;
		if (!ip) return undefined;
		ipifyCache = { ip, expiresAt: now + IPIFY_CACHE_TTL_MS };
		return ip;
	} catch {
		return undefined;
	}
}

async function getIpInfoCountryWithCache(ip: string): Promise<string | undefined> {
	const now = Date.now();
	const cached = ipinfoCountryCache.get(ip);
	if (cached && cached.expiresAt > now) return cached.country;

	const infoToken = env.IPINFO_TOKEN;
	const infoUrl = infoToken
		? `https://ipinfo.io/${encodeURIComponent(ip)}/json?token=${encodeURIComponent(infoToken)}`
		: `https://ipinfo.io/${encodeURIComponent(ip)}/json`;
	try {
		const infoRes = await fetch(infoUrl);
		if (!infoRes.ok) {
			ipinfoCountryCache.set(ip, { country: undefined, expiresAt: now + IPINFO_CACHE_TTL_MS });
			pruneIpinfoCache(now);
			return undefined;
		}
		const info = (await infoRes.json()) as { country?: string };
		const country =
			typeof info.country === 'string' && info.country.trim().length >= 2
				? info.country.trim().toUpperCase()
				: undefined;
		ipinfoCountryCache.set(ip, { country, expiresAt: now + IPINFO_CACHE_TTL_MS });
		pruneIpinfoCache(now);
		return country;
	} catch {
		return undefined;
	}
}

/**
 * Resolve `{ ip, country }` for the inbound request. Prefers platform geo
 * headers; falls back to ipify + ipinfo for local dev. Either field may be
 * `undefined` if no source produced a value.
 */
export async function resolveIpAndCountry(
	request: Request
): Promise<{ ip?: string; country?: string }> {
	const headerIp = getRequestIp(request);
	const headerCountry = getCountryFromHeaders(request);
	if (headerIp || headerCountry) return { ip: headerIp, country: headerCountry };

	try {
		const ip = await getPublicIpWithCache();
		if (!ip) return {};
		const country = await getIpInfoCountryWithCache(ip);
		return { ip, country };
	} catch {
		return {};
	}
}

/** Best-effort short device label like "Chrome on macOS". */
export function summarizeUserAgent(ua: string | null | undefined): string {
	if (!ua) return '—';

	let browser = 'Browser';
	if (/Edg\//i.test(ua)) browser = 'Edge';
	else if (/OPR\//i.test(ua) || /Opera/i.test(ua)) browser = 'Opera';
	else if (/Chrome|CriOS/i.test(ua)) browser = 'Chrome';
	else if (/Firefox|FxiOS/i.test(ua)) browser = 'Firefox';
	else if (/Safari/i.test(ua)) browser = 'Safari';

	let os = 'Unknown OS';
	if (/Windows NT/i.test(ua)) os = 'Windows';
	else if (/iPhone|iPad|iPod/i.test(ua)) os = 'iOS';
	else if (/Mac OS X|Macintosh/i.test(ua)) os = 'macOS';
	else if (/Android/i.test(ua)) os = 'Android';
	else if (/Linux/i.test(ua)) os = 'Linux';

	return `${browser} on ${os}`;
}
