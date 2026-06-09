/** Tracks open app modals so only one can show at a time. */

const blockingOwners = new Set<string>();

let dialogBlockingRevision = $state(0);

/** Read inside `$effect` to re-run when a blocking dialog opens or closes. */
export function getDialogBlockingRevision(): number {
	return dialogBlockingRevision;
}

export function setDialogBlocking(owner: string, blocking: boolean): void {
	const had = blockingOwners.has(owner);
	if (blocking) blockingOwners.add(owner);
	else blockingOwners.delete(owner);
	if (blocking !== had) dialogBlockingRevision++;
}

export function isAnyDialogBlocking(): boolean {
	return blockingOwners.size > 0;
}

export function isHomePath(pathname: string): boolean {
	return pathname === '/' || pathname === '';
}

const SESSION_PENDING_RATING = 'pixnprints-pending-rating-prompt-v1';

export function setPendingRatingPrompt(): void {
	try {
		sessionStorage.setItem(SESSION_PENDING_RATING, '1');
	} catch {
		/* sessionStorage unavailable */
	}
}

export function hasPendingRatingPrompt(): boolean {
	if (typeof window === 'undefined') return false;
	try {
		return sessionStorage.getItem(SESSION_PENDING_RATING) === '1';
	} catch {
		return false;
	}
}

export function clearPendingRatingPrompt(): void {
	try {
		sessionStorage.removeItem(SESSION_PENDING_RATING);
	} catch {
		/* sessionStorage unavailable */
	}
}
