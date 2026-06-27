#!/usr/bin/env node
/**
 * Check whether a Print Studio user (by email) has valid access and can export.
 *
 * Usage:
 *   pnpm check-user user@example.com
 *   pnpm check-user user@example.com --json
 *
 * Requires in `.env` (or environment):
 *   VITE_SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *
 * Optional:
 *   VITE_FREE_TRIAL_CREDITS
 *   VITE_SUBSCRIPTION_TRIAL_EXPORTS_PER_DESIGN
 *   VITE_MAINTENANCE_MODE
 */

import { createClient } from '@supabase/supabase-js';
import { loadEnv } from './lib/load-env.mjs';
import {
	buildSubscriptionStatus,
	buildSubscriptionTrialDesignerStatus,
	buildTrialStatus,
	getExportTitleSimulation,
	parseFreeTrialBaseCredits,
	parseSubscriptionTrialExportsPerDesign,
	simulateExportAccess,
	subscriptionRowGrantsAccess
} from './lib/subscription-access.mjs';

/** Keep in sync with src/lib/comingSoonDesigners.ts */
const COMING_SOON_DESIGNER_IDS = ['letterRail', 'monogramInsert'];

function comingSoonEarlyAccessFeatureKey(id) {
	return `comingSoon_${id}`;
}

loadEnv();

const TRIAL_MAX_ACCOUNTS_PER_FINGERPRINT = 2;

/** Keep in sync with src/lib/exclusiveDesigners.ts */
const EXCLUSIVE_DESIGNER_IDS = ['textBlocks'];

function exclusiveDesignerFeatureKey(id) {
	return `designer_${id}`;
}

function usage() {
	console.error(`Usage: pnpm check-user <email> [--json] [--designer <designerId>]

Checks Supabase auth + subscription/license + free trial state for a Print Studio user.
Use --designer to simulate LS subscription-trial export limits for one designer.`);
	process.exit(1);
}

function isMaintenanceMode() {
	const v = process.env.VITE_MAINTENANCE_MODE;
	return v === 'true' || v === '1';
}

function formatDate(iso) {
	if (!iso) return '—';
	try {
		return new Date(iso).toISOString();
	} catch {
		return String(iso);
	}
}

async function findUserByEmail(admin, email) {
	const target = email.trim().toLowerCase();
	let page = 1;
	const perPage = 1000;

	while (true) {
		const { data, error } = await admin.auth.admin.listUsers({ page, perPage });
		if (error) throw new Error(`Auth listUsers failed: ${error.message}`);

		const user = data.users.find((u) => u.email?.toLowerCase() === target);
		if (user) return user;

		if (data.users.length < perPage) break;
		page += 1;
		if (page > 50) {
			throw new Error('Stopped after 50 pages — user not found (try Supabase dashboard search)');
		}
	}

	return null;
}

async function getFingerprintSummary(admin, userId) {
	const { data: userRows, error: userErr } = await admin
		.from('trial_fingerprint_users')
		.select('fingerprint_hash, email, created_at')
		.eq('user_id', userId);

	if (userErr) {
		return { error: userErr.message, hashes: [], fingerprintAllowed: true };
	}

	if (!userRows?.length) {
		return {
			registered: false,
			hashes: [],
			fingerprintAllowed: true,
			note: 'No fingerprint on file yet — first export from browser will register device'
		};
	}

	const hashes = [...new Set(userRows.map((r) => r.fingerprint_hash))];
	const hashDetails = [];

	for (const hash of hashes) {
		const { data: linked, error: linkErr } = await admin
			.from('trial_fingerprint_users')
			.select('user_id, email, created_at')
			.eq('fingerprint_hash', hash);

		if (linkErr) {
			hashDetails.push({ hash: hash.slice(0, 12) + '…', error: linkErr.message });
			continue;
		}

		const sorted = [...(linked ?? [])].sort((a, b) => {
			const t = new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
			if (t !== 0) return t;
			return String(a.user_id).localeCompare(String(b.user_id));
		});
		const distinctUsers = new Set(sorted.map((r) => r.user_id));
		const slotIdx = sorted.findIndex((r) => r.user_id === userId);
		const slot = slotIdx >= 0 ? slotIdx + 1 : null;
		const userAllowedOnHash =
			slot === null ? true : slot <= TRIAL_MAX_ACCOUNTS_PER_FINGERPRINT;
		hashDetails.push({
			hashPrefix: hash.slice(0, 12) + '…',
			linkedAccounts: distinctUsers.size,
			maxAccounts: TRIAL_MAX_ACCOUNTS_PER_FINGERPRINT,
			userSlot: slot,
			userAllowedOnHash,
			emails: sorted.map((r) => r.email).filter(Boolean) ?? []
		});
	}

	const fingerprintAllowed = hashDetails.every(
		(h) => h.error || h.userAllowedOnHash !== false
	);

	return {
		registered: true,
		hashes: hashDetails,
		fingerprintAllowed,
		note: fingerprintAllowed
			? undefined
			: 'Device fingerprint cap may block free trial exports for new accounts on this device'
	};
}

async function main() {
	const jsonOut = process.argv.includes('--json');
	const designerIdx = process.argv.indexOf('--designer');
	const designerId = designerIdx >= 0 ? process.argv[designerIdx + 1] : undefined;
	const email = process.argv
		.slice(2)
		.find((a) => !a.startsWith('--') && a !== designerId);

	if (!email) usage();

	const supabaseUrl = process.env.VITE_SUPABASE_URL;
	const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

	if (!supabaseUrl || !serviceKey) {
		console.error(
			'Missing VITE_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env / environment.'
		);
		process.exit(1);
	}

	const admin = createClient(supabaseUrl, serviceKey, {
		auth: { autoRefreshToken: false, persistSession: false }
	});

	const user = await findUserByEmail(admin, email);
	if (!user) {
		const result = {
			ok: false,
			email,
			error: 'user_not_found',
			message: 'No auth user with this email'
		};
		if (jsonOut) console.log(JSON.stringify(result, null, 2));
		else {
			console.log('Print Studio — user access check\n');
			console.log(`Email: ${email}`);
			console.log('\n❌ User not found in Supabase Auth');
		}
		process.exit(2);
	}

	const userId = user.id;
	const baseCredits = parseFreeTrialBaseCredits();
	const subscriptionTrialMax = parseSubscriptionTrialExportsPerDesign();

	const [
		subResult,
		licenseRpcResult,
		activationResult,
		trialResult,
		subscriptionTrialResult,
		featureFlagsResult,
		fingerprintSummary,
		blockedResult
	] = await Promise.all([
		admin.from('subscriptions').select('*').eq('user_id', userId).maybeSingle(),
		admin.rpc('get_user_export_access', { p_user_id: userId }),
		admin
			.from('license_activations')
			.select('license_id, activated_at')
			.eq('user_id', userId)
			.maybeSingle(),
		admin.from('trial_usage').select('count, bonus_credits').eq('user_id', userId).maybeSingle(),
		admin
			.from('subscription_trial_designer_usage')
			.select('designer_id, count, updated_at')
			.eq('user_id', userId),
		admin.from('user_feature_flags').select('feature_key, enabled, granted_at, note').eq('user_id', userId),
		getFingerprintSummary(admin, userId),
		admin.from('blocked_users').select('reason, blocked_at, blocked_by').eq('user_id', userId).maybeSingle()
	]);

	let subscriptionStatus = buildSubscriptionStatus(subResult.data);
	let licenseDetails = null;
	let licenseExpired = false;

	if (!subscriptionStatus.isActive && licenseRpcResult.data === true) {
		subscriptionStatus = { isActive: true, source: 'license' };
	}

	if (activationResult.data?.license_id) {
		const { data: license } = await admin
			.from('licenses')
			.select('id, tier, is_active, expires_at, created_at')
			.eq('id', activationResult.data.license_id)
			.maybeSingle();

		licenseDetails = {
			activated_at: activationResult.data.activated_at,
			license
		};

		if (
			license &&
			!subscriptionStatus.isActive &&
			license.expires_at &&
			new Date(license.expires_at) <= new Date()
		) {
			licenseExpired = true;
			subscriptionStatus = { isActive: false, source: 'license', licenseExpired: true };
		}
	}

	const trial = buildTrialStatus(trialResult.data, baseCredits);
	const subscriptionTrialRows = subscriptionTrialResult.data ?? [];
	const subscriptionTrialForDesigner = designerId
		? buildSubscriptionTrialDesignerStatus(subscriptionTrialRows, designerId, subscriptionTrialMax)
		: null;
	const exportSim = simulateExportAccess({
		subscriptionStatus,
		hasUser: true,
		trialRemaining: fingerprintSummary.fingerprintAllowed === false ? 0 : trial.remaining,
		fingerprintAllowed: fingerprintSummary.fingerprintAllowed !== false,
		subscriptionTrialRemaining: subscriptionTrialForDesigner?.remaining,
		designerId
	});
	const isServiceBlocked = Boolean(blockedResult.data);
	const exportWorks = !isServiceBlocked && exportSim.allowed;
	const exportButtonTitle = isServiceBlocked
		? 'Account restricted'
		: getExportTitleSimulation({
				subscriptionStatus,
				hasUser: true,
				trialRemaining: trial.remaining,
				fingerprintBlocked: fingerprintSummary.fingerprintAllowed === false,
				subscriptionTrialRemaining: subscriptionTrialForDesigner?.remaining
			});

	const maintenance = isMaintenanceMode();
	const appUsable = !maintenance;

	const report = {
		ok: appUsable && exportWorks && !isServiceBlocked,
		email: user.email,
		user: {
			id: userId,
			created_at: user.created_at,
			email_confirmed_at: user.email_confirmed_at ?? null,
			last_sign_in_at: user.last_sign_in_at ?? null,
			banned: Boolean(user.banned_until && new Date(user.banned_until) > new Date())
		},
		blocked: blockedResult.data
			? {
					reason: blockedResult.data.reason,
					blocked_at: blockedResult.data.blocked_at,
					blocked_by: blockedResult.data.blocked_by
				}
			: null,
		app: {
			maintenance_mode: maintenance,
			app_loads: !maintenance,
			note: maintenance ? 'VITE_MAINTENANCE_MODE is on — all users see maintenance page' : undefined
		},
		subscription: subResult.data
			? {
					status: subResult.data.status,
					plan: subResult.data.plan,
					ends_at: subResult.data.ends_at,
					renews_at: subResult.data.renews_at,
					grants_access: subscriptionRowGrantsAccess(
						subResult.data.status,
						subResult.data.ends_at
					),
					lemonsqueezy_subscription_id: subResult.data.lemonsqueezy_subscription_id
				}
			: null,
		license: {
			rpc_grants_access: licenseRpcResult.data === true,
			rpc_error: licenseRpcResult.error?.message ?? null,
			activation: licenseDetails,
			expired: licenseExpired
		},
		free_trial: {
			...trial,
			fingerprint: fingerprintSummary
		},
		subscription_trial: {
			max_per_design: subscriptionTrialMax,
			simulated_designer: designerId ?? null,
			by_designer: subscriptionTrialRows.map((row) =>
				buildSubscriptionTrialDesignerStatus([row], row.designer_id, subscriptionTrialMax)
			),
			simulated: subscriptionTrialForDesigner
		},
		feature_flags: (featureFlagsResult.data ?? []).map((row) => ({
			feature_key: row.feature_key,
			enabled: row.enabled,
			granted_at: row.granted_at,
			note: row.note
		})),
		access: {
			subscription_status: {
				isActive: subscriptionStatus.isActive,
				source: subscriptionStatus.source,
				plan: subscriptionStatus.plan,
				onTrial: subscriptionStatus.onTrial,
				cancelledPendingEnd: subscriptionStatus.cancelledPendingEnd,
				licenseExpired: subscriptionStatus.licenseExpired
			},
			export: exportSim,
			export_button_title: exportButtonTitle
		},
		verdict: {
			can_use_app: appUsable && !isServiceBlocked,
			can_export: exportWorks,
			summary: isServiceBlocked
				? 'Account restricted by admin — service blocked'
				: exportWorks
					? appUsable
						? `Export allowed — ${exportSim.message}`
						: 'App in maintenance mode (exports would work if app were open)'
					: `Export blocked — ${exportSim.message}`
		}
	};

	if (jsonOut) {
		console.log(JSON.stringify(report, null, 2));
		process.exit(report.ok ? 0 : 1);
	}

	const lines = [];
	lines.push('Print Studio — user access check');
	lines.push('');
	lines.push(`Email: ${report.email}`);
	lines.push('');
	lines.push('USER');
	lines.push(`  ID:              ${report.user.id}`);
	lines.push(`  Email confirmed: ${report.user.email_confirmed_at ? 'yes' : 'no'}`);
	lines.push(`  Last sign-in:    ${formatDate(report.user.last_sign_in_at)}`);
	if (report.user.banned) lines.push('  ⚠ Banned until future date');
	if (report.blocked) {
		lines.push('  ⚠ Service blocked by admin');
		lines.push(`  Blocked at:      ${formatDate(report.blocked.blocked_at)}`);
		if (report.blocked.blocked_by) lines.push(`  Blocked by:      ${report.blocked.blocked_by}`);
		if (report.blocked.reason) lines.push(`  Reason:          ${report.blocked.reason}`);
	}

	lines.push('');
	lines.push('APP');
	lines.push(`  Maintenance mode: ${maintenance ? 'ON (app blocked)' : 'off'}`);
	lines.push(`  App loads:        ${appUsable ? 'yes' : 'no'}`);

	lines.push('');
	lines.push('SUBSCRIPTION (Lemon Squeezy)');
	if (report.subscription) {
		lines.push(`  Status:         ${report.subscription.status}`);
		lines.push(`  Plan:           ${report.subscription.plan ?? '—'}`);
		lines.push(`  Ends at:        ${formatDate(report.subscription.ends_at)}`);
		lines.push(`  Renews at:      ${formatDate(report.subscription.renews_at)}`);
		lines.push(`  Grants access:  ${report.subscription.grants_access ? 'yes' : 'no'}`);
		if (subscriptionStatus.cancelledPendingEnd) {
			lines.push(
				`  Note:           Cancelled — access until end of paid period (${formatDate(report.subscription.ends_at)})`
			);
		}
	} else {
		lines.push('  No subscription row');
	}

	lines.push('');
	lines.push('LICENSE');
	lines.push(`  RPC grants access: ${report.license.rpc_grants_access ? 'yes' : 'no'}`);
	if (report.license.activation?.license) {
		const lic = report.license.activation.license;
		lines.push(`  Tier:              ${lic.tier ?? '—'}`);
		lines.push(`  Active flag:       ${lic.is_active ? 'yes' : 'no'}`);
		lines.push(`  Expires at:        ${formatDate(lic.expires_at)}`);
		lines.push(`  Activated at:      ${formatDate(report.license.activation.activated_at)}`);
	} else {
		lines.push('  No license activation');
	}
	if (report.license.expired) lines.push('  ⚠ License expired');

	lines.push('');
	lines.push('FREE TRIAL');
	lines.push(`  Base credits:    ${trial.baseCredits}`);
	lines.push(`  Bonus credits:   ${trial.bonusCredits}`);
	lines.push(`  Used:            ${trial.used}`);
	lines.push(`  Remaining:       ${trial.remaining}`);
	if (fingerprintSummary.registered === false) {
		lines.push(`  Fingerprint:     not registered yet`);
		lines.push(`                   (${fingerprintSummary.note})`);
	} else if (fingerprintSummary.error) {
		lines.push(`  Fingerprint:     error — ${fingerprintSummary.error}`);
	} else {
		for (const h of fingerprintSummary.hashes) {
			if (h.error) {
				lines.push(`  Fingerprint:     ${h.hash} — ${h.error}`);
			} else {
				const slotLabel =
					h.userSlot != null ? `, this user slot ${h.userSlot}` : '';
				const capLabel = h.userAllowedOnHash === false ? ' — BLOCKED (over cap)' : '';
				lines.push(
					`  Fingerprint:     ${h.hashPrefix} — ${h.linkedAccounts}/${h.maxAccounts} account(s) on device${slotLabel}${capLabel}`
				);
				if (h.emails?.length) lines.push(`                   emails: ${h.emails.join(', ')}`);
			}
		}
		if (fingerprintSummary.fingerprintAllowed === false) {
			lines.push('  ⚠ Device trial account limit may block exports');
		}
	}

	lines.push('');
	lines.push('SUBSCRIPTION TRIAL (per designer, LS on_trial only)');
	lines.push(`  Max per design:  ${subscriptionTrialMax}`);
	if (subscriptionTrialRows.length) {
		for (const row of subscriptionTrialRows) {
			const status = buildSubscriptionTrialDesignerStatus(
				[row],
				row.designer_id,
				subscriptionTrialMax
			);
			lines.push(
				`  ${row.designer_id}: ${status.used} used, ${status.remaining} remaining`
			);
		}
	} else {
		lines.push('  No per-designer trial usage recorded');
	}
	if (designerId && subscriptionTrialForDesigner) {
		lines.push(
			`  Simulated (${designerId}): ${subscriptionTrialForDesigner.remaining} remaining`
		);
	}

	lines.push('');
	lines.push('FEATURE FLAGS');
	const featureRows = featureFlagsResult.data ?? [];
	if (featureRows.length) {
		for (const row of featureRows) {
			lines.push(
				`  ${row.feature_key}: ${row.enabled ? 'enabled' : 'disabled'}${row.note ? ` (${row.note})` : ''}`
			);
		}
	} else {
		lines.push('  None');
	}

	lines.push('');
	lines.push('EXCLUSIVE DESIGNERS');
	for (const id of EXCLUSIVE_DESIGNER_IDS) {
		const key = exclusiveDesignerFeatureKey(id);
		const granted = featureRows.some((row) => row.feature_key === key && row.enabled);
		lines.push(`  ${id}: ${granted ? 'unlocked' : 'locked'} (${key})`);
	}

	lines.push('');
	lines.push('COMING SOON (early access)');
	for (const id of COMING_SOON_DESIGNER_IDS) {
		const key = comingSoonEarlyAccessFeatureKey(id);
		const granted = featureRows.some((row) => row.feature_key === key && row.enabled);
		lines.push(`  ${id}: ${granted ? 'early access' : 'locked'} (${key})`);
	}

	lines.push('');
	lines.push('EXPORT (same rules as Print Studio)');
	lines.push(`  Unlimited paid:  ${subscriptionStatus.isActive && !subscriptionStatus.onTrial ? 'yes' : 'no'}`);
	lines.push(`  LS on trial:     ${subscriptionStatus.onTrial ? 'yes' : 'no'}`);
	if (subscriptionStatus.cancelledPendingEnd) {
		lines.push(`  Cancelled:       yes (access until ${formatDate(subscriptionStatus.endsAt)})`);
	}
	if (subscriptionStatus.isActive && !subscriptionStatus.onTrial) {
		lines.push(`  Source:            ${subscriptionStatus.source}${subscriptionStatus.plan ? ` (${subscriptionStatus.plan})` : ''}`);
	}
	lines.push(`  Export allowed:    ${exportWorks ? 'yes' : 'no'}`);
	lines.push(`  Reason:            ${exportSim.message}`);
	lines.push(`  Export button UI:  "${exportButtonTitle}"`);

	lines.push('');
	const icon = exportWorks && appUsable ? '✅' : exportWorks && !appUsable ? '⚠️' : '❌';
	lines.push(`${icon} ${report.verdict.summary}`);

	if (subResult.error) lines.push(`\n(subscriptions query error: ${subResult.error.message})`);
	if (trialResult.error) lines.push(`\n(trial_usage query error: ${trialResult.error.message})`);
	if (subscriptionTrialResult.error) {
		lines.push(
			`\n(subscription_trial_designer_usage query error: ${subscriptionTrialResult.error.message})`
		);
	}
	if (featureFlagsResult.error) {
		lines.push(`\n(user_feature_flags query error: ${featureFlagsResult.error.message})`);
	}

	console.log(lines.join('\n'));
	process.exit(report.ok ? 0 : 1);
}

main().catch((err) => {
	console.error(err instanceof Error ? err.message : err);
	process.exit(1);
});
