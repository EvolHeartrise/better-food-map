// ---------------------------------------------------------------------------
// Shared dismissal plumbing for the audit_locations checks.
//
// Every audit finding carries an opaque `dismiss_key` — "<subject>#<fingerprint>"
// — that dismiss_audit_finding stores verbatim (split on the FIRST '#') in
// audit_dismissals (migration 0025). The subject identifies WHAT was flagged;
// the fingerprint pins the EVIDENCE that was judged, so a dismissal suppresses
// a finding only while the audit keeps computing the same fingerprint for that
// subject — materially new evidence (a different occupant name, a different
// matched brand, a changed item count) re-flags.
//
// Each finder builds a DismissFilter from the per-check dismissal map the MCP
// handler loads (auditDismissals in db-write.ts) and runs every would-be
// finding through evaluate(): suppressed findings are dropped and counted
// (`suppressed_dismissed` on every audit result); under include_dismissed they
// are kept, annotated with the stored reason/date instead.
// ---------------------------------------------------------------------------

import type { DismissalRecord } from '../../src/lib/server/db-write';

/** The dismissal inputs every audit finder accepts. */
export interface DismissalOpts {
	/** This check's stored dismissals, keyed by subject (from auditDismissals). */
	dismissals?: Map<string, DismissalRecord>;
	/** Surface dismissed findings anyway, annotated, instead of suppressing them. */
	include_dismissed?: boolean;
}

/** The annotation a surfaced-but-dismissed finding carries under include_dismissed. */
export interface DismissedMark {
	reason: string;
	dismissed_at: string;
}

/** The dismissal fields present on every audit finding. */
export interface DismissableFinding {
	/** Pass verbatim to dismiss_audit_finding to record "not a problem". */
	dismiss_key: string;
	/** Present only under include_dismissed, on findings a dismissal matches. */
	dismissed?: DismissedMark;
}

/** "<subject>#<fingerprint>" — the copyable key a finding carries. */
export function dismissKey(subject: string, fingerprint: string): string {
	return `${subject}#${fingerprint}`;
}

/** Splits a dismiss_key at its FIRST '#' (subjects never contain one; fingerprints may). */
export function splitDismissKey(key: string): { subject: string; fingerprint: string } | null {
	const at = key.indexOf('#');
	if (at <= 0) return null;
	return { subject: key.slice(0, at), fingerprint: key.slice(at + 1) };
}

/**
 * FNV-1a 32-bit hex hash — fingerprints free-form text (html_entities values)
 * without carrying the text itself into keys.
 */
export function fnv1a(text: string): string {
	let hash = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) {
		hash ^= text.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193);
	}
	return (hash >>> 0).toString(16).padStart(8, '0');
}

export interface DismissDecision {
	/** True when the finding must be omitted from the result (dismissed, not included). */
	drop: boolean;
	/** The finding's dismissal fields (dismiss_key always; dismissed when surfaced). */
	fields: DismissableFinding;
}

/**
 * Per-audit-run dismissal filter. evaluate() decides one would-be finding:
 * counts a fingerprint-matched dismissal in `suppressed` and either drops the
 * finding (default) or, under include_dismissed, keeps it annotated.
 */
export class DismissFilter {
	private readonly dismissals: Map<string, DismissalRecord>;
	private readonly includeDismissed: boolean;
	/** Findings a stored dismissal matched (dropped or annotated). */
	suppressed = 0;

	constructor(opts: DismissalOpts) {
		this.dismissals = opts.dismissals ?? new Map();
		this.includeDismissed = opts.include_dismissed ?? false;
	}

	evaluate(subject: string, fingerprint: string): DismissDecision {
		const fields: DismissableFinding = { dismiss_key: dismissKey(subject, fingerprint) };
		const record = this.dismissals.get(subject);
		if (!record || record.fingerprint !== fingerprint) return { drop: false, fields };
		this.suppressed++;
		if (!this.includeDismissed) return { drop: true, fields };
		fields.dismissed = { reason: record.reason, dismissed_at: record.dismissed_at };
		return { drop: false, fields };
	}
}
