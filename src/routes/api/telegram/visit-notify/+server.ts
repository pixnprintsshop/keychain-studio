import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { env } from '$env/dynamic/private';
import { getFlag, resolveIpAndCountry, summarizeUserAgent } from '$lib/server/visit-info';

const TELEGRAM_API = 'https://api.telegram.org';
/** Telegram messages over this many characters get rejected; well below the 4096 hard cap. */
const TELEGRAM_BODY_MAX = 3500;

export const POST: RequestHandler = async ({ request }) => {
	const token = env.TELEGRAM_BOT_TOKEN;
	const chatId = env.TELEGRAM_CHAT_ID;

	if (!token || !chatId) {
		console.warn('Telegram visit notify: TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not configured');
		return json({ ok: true });
	}

	let data: unknown;
	try {
		data = await request.json();
	} catch {
		return json({ error: 'Invalid JSON' }, { status: 400 });
	}

	const { email, userId, subscriptionStatus, referrer, view } = (data ?? {}) as {
		email?: string;
		userId?: string;
		subscriptionStatus?: string;
		referrer?: string;
		view?: string;
	};

	const { ip, country } = await resolveIpAndCountry(request);
	const flag = getFlag(country);
	const ua = request.headers.get('user-agent');
	const device = summarizeUserAgent(ua);

	const lines: string[] = [
		'🚪 New visit',
		`${flag} Country: ${country ?? '—'}`,
		`🌐 IP: ${ip ?? '—'}`,
		''
	];

	if (email || userId) {
		if (email) lines.push(`📧 Email: ${email}`);
		if (userId) lines.push(`🆔 User: ${userId}`);
		if (subscriptionStatus) lines.push(`📋 Status: ${subscriptionStatus}`);
	} else {
		lines.push('👤 Guest visitor');
	}
	lines.push('');

	if (view && view !== 'home') lines.push(`📍 View: ${view}`);
	if (referrer) {
		const ref = referrer.length > 200 ? `${referrer.slice(0, 200)}…` : referrer;
		lines.push(`🔗 Referrer: ${ref}`);
	}
	lines.push(`📱 Device: ${device}`);
	lines.push(`🕐 Time: ${new Date().toISOString()}`);

	let text = lines.join('\n');
	if (text.length > TELEGRAM_BODY_MAX) text = `${text.slice(0, TELEGRAM_BODY_MAX)}…`;

	try {
		const res = await fetch(`${TELEGRAM_API}/bot${token}/sendMessage`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				chat_id: chatId,
				text,
				disable_web_page_preview: true
			})
		});
		if (!res.ok) {
			const errBody = await res.text();
			console.error('Telegram visit notify error:', res.status, errBody);
			return json({ error: 'Failed to send' }, { status: 500 });
		}
		return json({ ok: true });
	} catch (err) {
		console.error('Telegram visit notify error:', err);
		return json({ error: 'Failed to send' }, { status: 500 });
	}
};
