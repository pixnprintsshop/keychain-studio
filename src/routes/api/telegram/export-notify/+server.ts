import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { env } from '$env/dynamic/private';

const TELEGRAM_API = 'https://api.telegram.org';

export const POST: RequestHandler = async ({ request }) => {
	const token = env.TELEGRAM_BOT_TOKEN;
	const chatId = env.TELEGRAM_CHAT_ID;

	if (!token || !chatId) {
		console.warn('Telegram export notify: TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not configured');
		return json({ ok: true }); // Don't fail the request; just skip
	}

	let data: unknown;
	try {
		data = await request.json();
	} catch {
		return json({ error: 'Invalid JSON' }, { status: 400 });
	}

	const { email, name, subscriptionStatus, onTrial, designName, format } = (data ?? {}) as {
		email?: string;
		name?: string;
		subscriptionStatus?: string;
		onTrial?: boolean;
		designName?: string;
		format?: string;
	};

	const lines: string[] = [
		'🖨️ Export Event',
		'',
		`📧 Email: ${email ?? '—'}`,
		`👤 Name: ${name ?? '—'}`,
		`📋 Status: ${subscriptionStatus ?? '—'}`,
		...(onTrial ? ['⚠️ On trial'] : []),
		`📦 Design: ${designName ?? '—'}`,
		`📄 Format: ${format ?? '—'}`
	];

	const text = lines.join('\n');

	try {
		const res = await fetch(`${TELEGRAM_API}/bot${token}/sendMessage`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				chat_id: chatId,
				text
			})
		});

		if (!res.ok) {
			const errBody = await res.text();
			console.error('Telegram export notify error:', res.status, errBody);
			return json({ error: 'Failed to send' }, { status: 500 });
		}

		return json({ ok: true });
	} catch (err) {
		console.error('Telegram export notify error:', err);
		return json({ error: 'Failed to send' }, { status: 500 });
	}
};
