import { LRUCache } from "lru-cache/raw";
import type { FileDiagnosticsResult } from "./index";
import { summarizeDiagnosticMessages } from "./utils";

const DIAGNOSTIC_LOCATION_PREFIX_RE = /^.*?:\d+:\d+\s+/;

export function diagnosticIdentity(message: string): string {
	return message.replace(DIAGNOSTIC_LOCATION_PREFIX_RE, "");
}

/**
 * Files whose already-reported diagnostic identities are remembered so a
 * writethrough only surfaces *new* problems. Least-recently-diagnosed files
 * are evicted first.
 */
export const DIAGNOSTICS_LEDGER_MAX_FILES = 256;
/**
 * Ceiling on remembered diagnostic identities summed across every tracked
 * file. Worst case 8192 identities; an identity is a diagnostic message with
 * its `path:line:col` prefix stripped, so ~200 UTF-16 units each — about
 * 3 MB resident at the cap, versus unbounded before (one entry per file ever
 * touched, times every distinct diagnostic that file ever produced).
 *
 * A file whose single diagnostics run exceeds the ceiling on its own is not
 * tracked at all (`lru-cache` refuses entries above `maxEntrySize`); its
 * diagnostics are reported in full every writethrough, which is the
 * pre-ledger behaviour.
 */
export const DIAGNOSTICS_LEDGER_MAX_IDENTITIES = 8192;

export class DiagnosticsLedger {
	readonly #seen = new LRUCache<string, Set<string>>({
		max: DIAGNOSTICS_LEDGER_MAX_FILES,
		maxSize: DIAGNOSTICS_LEDGER_MAX_IDENTITIES,
		sizeCalculation: identities => identities.size + 1,
	});

	reduce(absPath: string, result: FileDiagnosticsResult): FileDiagnosticsResult {
		const previous = this.#seen.get(absPath);
		const currentIdentities = new Set<string>();
		const fresh: string[] = [];

		for (const message of result.messages) {
			const identity = diagnosticIdentity(message);
			currentIdentities.add(identity);
			if (!previous?.has(identity)) {
				fresh.push(message);
			}
		}

		if (currentIdentities.size === 0) {
			this.#seen.delete(absPath);
		} else {
			this.#seen.set(absPath, currentIdentities);
		}

		if (fresh.length === result.messages.length) {
			return result;
		}

		return {
			...result,
			messages: fresh,
			...summarizeDiagnosticMessages(fresh),
		};
	}
}

export interface DiagnosticsLedgerOwner {
	diagnosticsLedger?: DiagnosticsLedger;
}

export function getDiagnosticsLedger(owner: DiagnosticsLedgerOwner): DiagnosticsLedger {
	owner.diagnosticsLedger ??= new DiagnosticsLedger();
	return owner.diagnosticsLedger;
}
