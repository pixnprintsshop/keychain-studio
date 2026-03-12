import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { sendFeedbackEmail } from '$lib/server/email';

export const POST: RequestHandler = async ({ request }) => {
	let data: unknown;
	try {
		data = await request.json();
	} catch {
		return json({ error: 'Invalid JSON' }, { status: 400 });
	}

	const { userEmail, category, title, message, createdAt } = (data ?? {}) as {
		userEmail?: string;
		category?: string;
		title?: string | null;
		message?: string;
		createdAt?: string;
	};

	if (!userEmail || !category || !message || !createdAt) {
		return json({ error: 'Missing fields' }, { status: 400 });
	}

	try {
		sendFeedbackEmail({
			userEmail,
			category,
			title: title ?? null,
			message,
			createdAt
		});
		return json({ ok: true });
	} catch (error) {
		console.error('Failed to send feedback email', error);
		return json({ error: 'Failed to send email' }, { status: 500 });
	}
};
