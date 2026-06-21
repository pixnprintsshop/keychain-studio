const LEMONSQUEEZY_API = 'https://api.lemonsqueezy.com/v1';

export function getLemonSqueezyApiKey() {
	return process.env.LEMONSQUEEZY_API_KEY ?? null;
}

export async function lemonSqueezyFetch(path, init = {}) {
	const apiKey = getLemonSqueezyApiKey();
	if (!apiKey) {
		throw new Error('LEMONSQUEEZY_API_KEY is not set');
	}
	return fetch(`${LEMONSQUEEZY_API}${path}`, {
		...init,
		headers: {
			Accept: 'application/vnd.api+json',
			'Content-Type': 'application/vnd.api+json',
			Authorization: `Bearer ${apiKey}`,
			...init.headers
		}
	});
}

/** Cancel a Lemon Squeezy subscription immediately (DELETE). */
export async function cancelLemonSqueezySubscription(subscriptionId) {
	const res = await lemonSqueezyFetch(`/subscriptions/${subscriptionId}`, { method: 'DELETE' });
	const text = await res.text();
	if (!res.ok) {
		throw new Error(`Lemon Squeezy cancel failed (${res.status}): ${text.slice(0, 300)}`);
	}
	return text ? JSON.parse(text) : null;
}
