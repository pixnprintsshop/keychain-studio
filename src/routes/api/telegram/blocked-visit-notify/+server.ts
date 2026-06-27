import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { env } from '$env/dynamic/private';
import { isTelegramNotifyEnabled } from '$lib/server/opsInDev';
import { getFlag, resolveIpAndCountry, summarizeUserAgent } from '$lib/server/visit-info';

const TELEGRAM_API = 'https://api.telegram.org';
const TELEGRAM_BODY_MAX = 3500;

const BLOCK_KIND_LABELS: Record<string, string> = {
	account: 'Account blocked (admin)',
	fingerprint: 'Device fingerprint blocked (admin)',
	device_limit: 'Device trial limit (2 accounts)'
};

export const POST: RequestHandler = async ({ request }) => {
	if (!isTelegramNotifyEnabled()) return json({ ok: true, skipped: true });

	const token = env.TELEGRAM_BOT_TOKEN;
	const chatId = env.TELEGRAM_CHAT_ID;

	if (!token || !chatId) {
		console.warn(
			'Telegram blocked visit notify: TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not configured'
		);
		return json({ ok: true });
	}

	let data: unknown;
	try {
		data = await request.json();
	} catch {
		return json({ error: 'Invalid JSON' }, { status: 400 });
	}

	const { email, userId, blockKind, reason, fingerprintHash, subscriptionStatus, view } =
		(data ?? {}) as {
			email?: string;
			userId?: string;
			blockKind?: string;
			reason?: string;
			fingerprintHash?: string;
			subscriptionStatus?: string;
			view?: string;
		};

	if (!userId) {
		return json({ error: 'userId required' }, { status: 400 });
	}

	const { ip, country } = await resolveIpAndCountry(request);
	const flag = getFlag(country);
	const ua = request.headers.get('user-agent');
	const device = summarizeUserAgent(ua);

	const kindLabel =
		(blockKind && BLOCK_KIND_LABELS[blockKind]) || blockKind || 'Restricted';

	const fpShort =
		fingerprintHash && fingerprintHash.length > 12
			? `${fingerprintHash.slice(0, 12)}…`
			: (fingerprintHash ?? '—');

	const lines: string[] = [
		'🚫 Blocked user visit',
		`${flag} Country: ${country ?? '—'}`,
		`🌐 IP: ${ip ?? '—'}`,
		'',
		`📧 Email: ${email ?? '—'}`,
		`🆔 User: ${userId}`,
		`⛔ Restriction: ${kindLabel}`,
		...(reason ? [`📝 Reason: ${reason}`] : []),
		...(subscriptionStatus ? [`📋 Status: ${subscriptionStatus}`] : []),
		`🔑 Fingerprint: ${fpShort}`,
		''
	];

	if (view && view !== '/' && view !== 'home') lines.push(`📍 View: ${view}`);
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
			console.error('Telegram blocked visit notify error:', res.status, errBody);
			return json({ error: 'Failed to send' }, { status: 500 });
		}
		return json({ ok: true });
	} catch (err) {
		console.error('Telegram blocked visit notify error:', err);
		return json({ error: 'Failed to send' }, { status: 500 });
	}
};
