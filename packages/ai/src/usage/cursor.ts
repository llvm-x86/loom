import type {
	UsageAmount,
	UsageFetchContext,
	UsageFetchParams,
	UsageLimit,
	UsageProvider,
	UsageReport,
	UsageStatus,
	UsageWindow,
} from "../usage";
import { toNumber } from "./shared";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseTimestamp(value: unknown): number | undefined {
	const numeric = toNumber(value);
	if (numeric !== undefined) return numeric < 1_000_000_000_000 ? numeric * 1000 : numeric;
	if (typeof value !== "string" || !value.trim()) return undefined;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}

function normalizeCursorBaseUrl(baseUrl?: string): string {
	if (!baseUrl) return "https://api2.cursor.sh";
	return baseUrl.replace(/\/+$/, "");
}

function buildCursorAmount(
	used: number | undefined,
	limit: number | undefined,
	unit: UsageAmount["unit"],
	options?: {
		usedFraction?: number;
		remainingFraction?: number;
	},
): UsageAmount {
	const safeLimit = limit !== undefined && Number.isFinite(limit) ? limit : undefined;
	const safeUsed = used !== undefined && Number.isFinite(used) ? used : undefined;
	const remaining = safeLimit !== undefined && safeUsed !== undefined ? Math.max(0, safeLimit - safeUsed) : undefined;
	const usedFraction =
		options?.usedFraction ??
		(safeLimit !== undefined && safeUsed !== undefined && safeLimit > 0 ? safeUsed / safeLimit : undefined);
	const remainingFraction =
		options?.remainingFraction ??
		(usedFraction !== undefined
			? Math.max(0, 1 - usedFraction)
			: safeLimit !== undefined && remaining !== undefined && safeLimit > 0
				? remaining / safeLimit
				: undefined);
	return {
		used: safeUsed,
		limit: safeLimit,
		remaining,
		usedFraction,
		remainingFraction,
		unit,
	};
}

function deriveCursorStatus(amount: UsageAmount): UsageStatus {
	const usedFraction = amount.usedFraction;
	if (usedFraction === undefined) return "unknown";
	if (usedFraction >= 1) return "exhausted";
	if (usedFraction >= 0.9) return "warning";
	return "ok";
}

function deriveResetsAt(payload: Record<string, unknown>): number | undefined {
	const endKeys = ["billingCycleEnd", "endOfMonth", "resetsAt", "nextReset"];
	for (const key of endKeys) {
		const parsed = parseTimestamp(payload[key]);
		if (parsed !== undefined) return parsed;
	}

	const startKeys = ["startOfMonth", "billingCycleStart", "startOfBillingCycle"];
	for (const key of startKeys) {
		const parsed = parseTimestamp(payload[key]);
		if (parsed !== undefined) {
			const date = new Date(parsed);
			date.setUTCMonth(date.getUTCMonth() + 1);
			return date.getTime();
		}
	}
	return undefined;
}

export function parseCursorUsage(payload: unknown, fetchedAt = Date.now()): UsageReport | null {
	if (!isRecord(payload)) return null;
	const limits: UsageLimit[] = [];
	const resetsAt = deriveResetsAt(payload);

	const window: UsageWindow = {
		id: "monthly",
		label: "Monthly",
		...(resetsAt !== undefined ? { resetsAt } : {}),
	};

	for (const [key, value] of Object.entries(payload)) {
		if (!isRecord(value)) continue;

		// used can be: numRequests, used, amountUsed, usdUsed
		const usedVal =
			toNumber(value.numRequests) ?? toNumber(value.used) ?? toNumber(value.amountUsed) ?? toNumber(value.usdUsed);

		// limit can be: maxRequestUsage, limit, amountLimit, usdLimit
		const limitVal =
			toNumber(value.maxRequestUsage) ??
			toNumber(value.limit) ??
			toNumber(value.amountLimit) ??
			toNumber(value.usdLimit);

		if (usedVal === undefined) continue;

		const isUsd =
			key === "planUsage" ||
			key.toLowerCase().includes("usd") ||
			key.toLowerCase().includes("billing") ||
			key.toLowerCase().includes("stripe");

		const unit = isUsd ? "usd" : "requests";
		const cleanBucket = key.toLowerCase().trim();
		const limitId = isUsd ? `cursor:usd:${cleanBucket}` : `cursor:requests:${cleanBucket}`;

		const label = isUsd ? `${key} spend` : `${key} requests`;

		const amount = buildCursorAmount(usedVal, limitVal, unit);
		const status = deriveCursorStatus(amount);

		limits.push({
			id: limitId,
			label,
			scope: {
				provider: "cursor",
				...(window ? { windowId: window.id } : {}),
			},
			...(window ? { window } : {}),
			amount,
			status,
		});
	}

	if (limits.length === 0) {
		return null;
	}

	return {
		provider: "cursor",
		fetchedAt,
		limits,
		raw: payload,
	};
}

/** Parses the dashboard-style aggregate quota from `/auth/usage-summary`. */
export function parseCursorUsageSummary(payload: unknown, fetchedAt = Date.now()): UsageReport | null {
	if (!isRecord(payload)) return null;
	const individualUsage = payload.individualUsage;
	if (!isRecord(individualUsage)) return null;
	const plan = individualUsage.plan;
	if (!isRecord(plan) || plan.enabled !== true) return null;

	const breakdown = isRecord(plan.breakdown) ? plan.breakdown : undefined;
	const used = toNumber(plan.used);
	const limit = toNumber(breakdown?.total) ?? toNumber(plan.limit);
	const totalPercentUsed = toNumber(plan.totalPercentUsed);
	const usedFraction = totalPercentUsed !== undefined ? totalPercentUsed / 100 : undefined;
	if (used === undefined && usedFraction === undefined) return null;

	const resetsAt = parseTimestamp(payload.billingCycleEnd) ?? deriveResetsAt(payload);
	const window: UsageWindow = {
		id: "billing",
		label: "Billing cycle",
		...(resetsAt !== undefined ? { resetsAt } : {}),
	};
	const amount = buildCursorAmount(used, limit, "requests", { usedFraction });
	const notes: string[] = [];
	const autoMessage = payload.autoModelSelectedDisplayMessage;
	if (typeof autoMessage === "string" && autoMessage.trim()) {
		notes.push(autoMessage.trim());
	}
	const namedMessage = payload.namedModelSelectedDisplayMessage;
	if (typeof namedMessage === "string" && namedMessage.trim()) {
		notes.push(namedMessage.trim());
	}

	const limits: UsageLimit[] = [
		{
			id: "cursor:models:included",
			label: "Cursor Models",
			scope: {
				provider: "cursor",
				windowId: window.id,
			},
			window,
			amount,
			status: deriveCursorStatus(amount),
			...(notes.length > 0 ? { notes } : {}),
		},
	];

	const onDemand = individualUsage.onDemand;
	if (isRecord(onDemand) && onDemand.enabled === true) {
		const onDemandUsed = toNumber(onDemand.used);
		const onDemandLimit = toNumber(onDemand.limit);
		if (onDemandUsed !== undefined || onDemandLimit !== undefined) {
			const onDemandAmount = buildCursorAmount(onDemandUsed, onDemandLimit, "usd");
			limits.push({
				id: "cursor:usd:on-demand",
				label: "On-demand spend",
				scope: {
					provider: "cursor",
					windowId: window.id,
				},
				window,
				amount: onDemandAmount,
				status: deriveCursorStatus(onDemandAmount),
			});
		}
	}

	const metadata: UsageReport["metadata"] = {};
	if (typeof payload.membershipType === "string" && payload.membershipType) {
		metadata.planType = payload.membershipType;
	}

	return {
		provider: "cursor",
		fetchedAt,
		limits,
		...(Object.keys(metadata).length > 0 ? { metadata } : {}),
		raw: payload,
	};
}

function attachCursorUsageMetadata(
	report: UsageReport,
	credential: UsageFetchParams["credential"],
): void {
	const metadata = {
		...(credential.email ? { email: credential.email } : {}),
		...(credential.accountId ? { accountId: credential.accountId } : {}),
		...(credential.projectId ? { projectId: credential.projectId } : {}),
		...(report.metadata ?? {}),
	};
	if (Object.keys(metadata).length > 0) {
		report.metadata = metadata;
	}
}

export const cursorUsageProvider: UsageProvider = {
	id: "cursor",
	supports(params: UsageFetchParams): boolean {
		if (params.provider !== "cursor") return false;
		const { credential } = params;
		if (credential.type === "oauth") {
			return Boolean(credential.accessToken);
		}
		if (credential.type === "api_key") {
			return Boolean(credential.apiKey);
		}
		return false;
	},
	async fetchUsage(params: UsageFetchParams, ctx: UsageFetchContext): Promise<UsageReport | null> {
		if (params.provider !== "cursor") return null;
		const { credential } = params;
		const token = credential.type === "oauth" ? credential.accessToken : credential.apiKey;
		if (!token) return null;

		const baseUrl = normalizeCursorBaseUrl(params.baseUrl ?? credential.apiEndpoint);
		const summaryUrl = `${baseUrl}/auth/usage-summary`;
		const usageUrl = `${baseUrl}/auth/usage`;

		const headers: Record<string, string> = {
			Accept: "application/json",
			Authorization: `Bearer ${token}`,
		};

		try {
			const summaryResponse = await ctx.fetch(summaryUrl, {
				headers,
				signal: params.signal,
			});
			if (summaryResponse.ok) {
				const summaryPayload = await summaryResponse.json();
				const summaryReport = parseCursorUsageSummary(summaryPayload);
				if (summaryReport) {
					attachCursorUsageMetadata(summaryReport, credential);
					return summaryReport;
				}
			} else {
				ctx.logger?.warn("Cursor usage summary request failed", {
					status: summaryResponse.status,
					provider: params.provider,
				});
			}

			const response = await ctx.fetch(usageUrl, {
				headers,
				signal: params.signal,
			});
			if (!response.ok) {
				ctx.logger?.warn("Cursor usage request failed", {
					status: response.status,
					provider: params.provider,
				});
				return null;
			}
			const payload = await response.json();
			const report = parseCursorUsage(payload);
			if (report) {
				attachCursorUsageMetadata(report, credential);
			}
			return report;
		} catch (error) {
			ctx.logger?.warn("Cursor usage request error", {
				provider: params.provider,
				error: String(error),
			});
			return null;
		}
	},
};
