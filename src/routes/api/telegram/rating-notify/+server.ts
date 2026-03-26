import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { env } from '$env/dynamic/private';

const TELEGRAM_API = 'https://api.telegram.org';

/** Telegram message max length; keep headroom for fixed lines. */
const COMMENT_MAX_IN_MESSAGE = 3500;

export const POST: RequestHandler = async ({ request }) => {
	const token = env.TELEGRAM_BOT_TOKEN;
	const chatId = env.TELEGRAM_CHAT_ID;

	if (!token || !chatId) {
		console.warn('Telegram rating notify: TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not configured');
		return json({ ok: true });
	}

	let data: unknown;
	try {
		data = await request.json();
	} catch {
		return json({ error: 'Invalid JSON' }, { status: 400 });
	}

	const { email, userId, submissionId, stars, comment, appVersion, createdAt } = (data ?? {}) as {
		email?: string;
		userId?: string;
		submissionId?: string;
		stars?: number;
		comment?: string;
		appVersion?: string;
		createdAt?: string;
	};

	const n = Math.round(Number(stars));
	if (!Number.isFinite(n) || n < 1 || n > 5) {
		return json({ error: 'Invalid stars' }, { status: 400 });
	}

	let commentBlock = '💬 Comment: —';
	if (comment && String(comment).trim()) {
		let c = String(comment).trim();
		if (c.length > COMMENT_MAX_IN_MESSAGE) {
			c = `${c.slice(0, COMMENT_MAX_IN_MESSAGE)}…`;
		}
		commentBlock = `💬 Comment:\n${c}`;
	}

	const lines: string[] = [
		'⭐ App rating submitted',
		'',
		`📧 Email: ${email ?? '—'}`,
		`🆔 User: ${userId ?? '—'}`,
		`🪪 Submission: ${submissionId ?? '—'}`,
		`⭐ Stars: ${n}/5`,
		'',
		commentBlock,
		'',
		`📱 App version: ${appVersion ?? '—'}`,
		`🕐 Submitted: ${createdAt ?? '—'}`
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
			console.error('Telegram rating notify error:', res.status, errBody);
			return json({ error: 'Failed to send' }, { status: 500 });
		}

		return json({ ok: true });
	} catch (err) {
		console.error('Telegram rating notify error:', err);
		return json({ error: 'Failed to send' }, { status: 500 });
	}
};
