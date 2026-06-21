/** Find a Supabase auth user by email (case-insensitive). */
export async function findUserByEmail(admin, email) {
	const target = email.trim().toLowerCase();
	let page = 1;
	while (page <= 50) {
		const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 });
		if (error) throw new Error(`Auth listUsers failed: ${error.message}`);
		const user = data.users.find((u) => u.email?.toLowerCase() === target);
		if (user) return user;
		if (data.users.length < 1000) break;
		page += 1;
	}
	return null;
}

export function normalizeEmailArg(raw) {
	return String(raw ?? '')
		.trim()
		.replace(/\\@/g, '@');
}
