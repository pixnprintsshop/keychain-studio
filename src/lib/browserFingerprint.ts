/** Stable browser fingerprint for free-trial abuse prevention (hashed client-side). */

const STORAGE_KEY = 'pixnprints-trial-fingerprint';

let cachedHash: string | null = null;

async function sha256Hex(input: string): Promise<string> {
	const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
	return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function canvasFingerprint(): string {
	if (typeof document === 'undefined') return '';
	try {
		const canvas = document.createElement('canvas');
		canvas.width = 220;
		canvas.height = 48;
		const ctx = canvas.getContext('2d');
		if (!ctx) return '';
		ctx.textBaseline = 'top';
		ctx.font = '16px "Arial", sans-serif';
		ctx.fillStyle = '#e85d04';
		ctx.fillRect(0, 0, canvas.width, canvas.height);
		ctx.fillStyle = '#023047';
		ctx.fillText('PixnPrints trial', 8, 12);
		return canvas.toDataURL();
	} catch {
		return '';
	}
}

function collectFingerprintParts(): string[] {
	if (typeof navigator === 'undefined') return ['ssr'];
	return [
		navigator.userAgent,
		navigator.language,
		navigator.languages?.join(',') ?? '',
		navigator.platform ?? '',
		String(screen.width),
		String(screen.height),
		String(screen.colorDepth),
		String(window.devicePixelRatio ?? 1),
		String(new Date().getTimezoneOffset()),
		canvasFingerprint()
	];
}

/**
 * Returns a hex SHA-256 fingerprint for this browser. Cached for the tab session.
 * Not cryptographically bound to the server — paired with server-side registration.
 */
export async function getBrowserFingerprintHash(): Promise<string> {
	if (cachedHash) return cachedHash;

	if (typeof window !== 'undefined') {
		try {
			const stored = sessionStorage.getItem(STORAGE_KEY);
			if (stored && stored.length >= 32) {
				cachedHash = stored;
				return stored;
			}
		} catch {
			// ignore
		}
	}

	const hash = await sha256Hex(collectFingerprintParts().join('|'));
	cachedHash = hash;

	if (typeof window !== 'undefined') {
		try {
			sessionStorage.setItem(STORAGE_KEY, hash);
		} catch {
			// ignore
		}
	}

	return hash;
}

/** Preload fingerprint during app init so trial RPCs do not await on first export. */
export function preloadBrowserFingerprint(): void {
	if (typeof window === 'undefined') return;
	void getBrowserFingerprintHash();
}
