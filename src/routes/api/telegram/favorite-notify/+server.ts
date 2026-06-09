import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { env } from '$env/dynamic/private';
import { isDesignerId } from '$lib/designers/ids';
import { isTelegramNotifyEnabled } from '$lib/server/opsInDev';
import { getFlag, resolveIpAndCountry, summarizeUserAgent } from '$lib/server/visit-info';

const TELEGRAM_API = 'https://api.telegram.org';
const TELEGRAM_BODY_MAX = 3500;

export const POST: RequestHandler = async ({ request }) => {
	if (!isTelegramNotifyEnabled()) return json({ ok: true, skipped: true });

	const token = env.TELEGRAM_BOT_TOKEN;
	const chatId = env.TELEGRAM_CHAT_ID;

	if (!token || !chatId) {
		console.warn('Telegram favorite notify: TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not configured');
		return json({ ok: true });
	}

	let data: unknown;
	try {
		data = await request.json();
	} catch {
		return json({ error: 'Invalid JSON' }, { status: 400 });
	}

	const { designerId, designerTitle, action, email, userId, subscriptionStatus } = (data ?? {}) as {
		designerId?: string;
		designerTitle?: string;
		action?: string;
		email?: string;
		userId?: string;
		subscriptionStatus?: string;
	};

	if (!designerId || typeof designerId !== 'string' || !isDesignerId(designerId)) {
		return json({ error: 'Invalid designer' }, { status: 400 });
	}

	if (action !== 'added' && action !== 'removed') {
		return json({ error: 'Invalid action' }, { status: 400 });
	}

	const title =
		typeof designerTitle === 'string' && designerTitle.trim()
			? designerTitle.trim().slice(0, 120)
			: designerId;

	const { ip, country } = await resolveIpAndCountry(request);
	const flag = getFlag(country);
	const device = summarizeUserAgent(request.headers.get('user-agent'));

	const lines: string[] = [
		action === 'added' ? '⭐ Designer favorited' : '☆ Designer unfavorited',
		`🧩 Designer: ${title}`,
		`🆔 Id: ${designerId}`,
		`${flag} Country: ${country ?? '—'}`,
		`🌐 IP: ${ip ?? '—'}`,
		''
	];

	if (email || userId) {
		if (email) lines.push(`📧 Email: ${email}`);
		if (userId) lines.push(`🆔 User: ${userId}`);
		if (subscriptionStatus) lines.push(`📋 Status: ${subscriptionStatus}`);
	} else {
		lines.push('👤 Guest');
	}

	lines.push('', `📱 Device: ${device}`, `🕐 Time: ${new Date().toISOString()}`);

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
			console.error('Telegram favorite notify error:', res.status, errBody);
			return json({ error: 'Failed to send' }, { status: 500 });
		}
		return json({ ok: true });
	} catch (err) {
		console.error('Telegram favorite notify error:', err);
		return json({ error: 'Failed to send' }, { status: 500 });
	}
};
