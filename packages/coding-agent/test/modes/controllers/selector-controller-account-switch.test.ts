import { beforeAll, describe, expect, it, vi } from "bun:test";
import { LogoutAccountSelectorComponent } from "@oh-my-pi/pi-coding-agent/modes/components/logout-account-selector";
import { SelectorController } from "@oh-my-pi/pi-coding-agent/modes/controllers/selector-controller";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import type { AuthStorage, StoredAuthCredential } from "@oh-my-pi/pi-coding-agent/session/auth-storage";

interface TestEditorContainer {
	children: unknown[];
	clear: () => void;
	addChild: (child: unknown) => void;
}

function createEditorContainer(): TestEditorContainer {
	return {
		children: [],
		clear() {
			this.children = [];
		},
		addChild(child: unknown) {
			this.children.push(child);
		},
	};
}

function createStoredCredential(id: number, email: string, accountId: string): StoredAuthCredential {
	return {
		id,
		provider: "anthropic",
		disabledCause: null,
		credential: {
			type: "oauth",
			access: `access-${id}`,
			refresh: `refresh-${id}`,
			expires: Date.now() + 60_000,
			email,
			accountId,
		},
	};
}

beforeAll(async () => {
	await initTheme();
});

function baseCtx(overrides: {
	authStorage: AuthStorage;
	editorContainer: TestEditorContainer;
	sessionId?: string;
}): InteractiveModeContext {
	return {
		editorContainer: overrides.editorContainer,
		editor: {},
		ui: {
			setFocus: vi.fn(),
			requestRender: vi.fn(),
		},
		session: {
			sessionId: overrides.sessionId ?? "session-account-switch-test",
			modelRegistry: {
				authStorage: overrides.authStorage,
			},
		},
		statusLine: { invalidate: vi.fn() },
		showError: vi.fn(),
		showStatus: vi.fn(),
	} as unknown as InteractiveModeContext;
}

describe("SelectorController /account switch", () => {
	it("pins the session to the selected stored credential", async () => {
		const editorContainer = createEditorContainer();
		const credentials = [
			createStoredCredential(21, "a@example.com", "acct-a"),
			createStoredCredential(22, "b@example.com", "acct-b"),
		];
		const setSessionCredentialPin = vi.fn(
			(_provider: string, _sessionId: string | undefined, credentialId: number) =>
				credentials.some(row => row.id === credentialId) ? 1 : undefined,
		);
		const clearSessionCredentialPin = vi.fn();
		const authStorage = {
			reload: vi.fn(async () => undefined),
			listStoredCredentials: (_provider?: string) => credentials,
			getOAuthAccountIdentity: (_provider: string, _sessionId?: string) => ({ accountId: "acct-a" }),
			isSessionCredentialPinned: (_provider: string, _sessionId?: string) => false,
			setSessionCredentialPin,
			clearSessionCredentialPin,
		} as unknown as AuthStorage;
		const ctx = baseCtx({ authStorage, editorContainer });
		const controller = new SelectorController(ctx);

		await controller.showAccountSelector("anthropic");

		const selector = editorContainer.children[0];
		if (!(selector instanceof LogoutAccountSelectorComponent)) {
			throw new Error("Expected account switch selector");
		}
		// Row 0 is "Auto"; move down twice to land on the second stored account (id 22).
		selector.handleInput("\x1b[B");
		selector.handleInput("\x1b[B");
		selector.handleInput("\n");
		await Promise.resolve();

		expect(setSessionCredentialPin).toHaveBeenCalledWith("anthropic", "session-account-switch-test", 22);
		expect(clearSessionCredentialPin).not.toHaveBeenCalled();
		expect(ctx.showError).not.toHaveBeenCalled();
		expect(ctx.showStatus).toHaveBeenCalled();
	});

	it("clears the pin when the Auto row is selected", async () => {
		const editorContainer = createEditorContainer();
		const credentials = [
			createStoredCredential(21, "a@example.com", "acct-a"),
			createStoredCredential(22, "b@example.com", "acct-b"),
		];
		const setSessionCredentialPin = vi.fn();
		const clearSessionCredentialPin = vi.fn();
		const authStorage = {
			reload: vi.fn(async () => undefined),
			listStoredCredentials: (_provider?: string) => credentials,
			getOAuthAccountIdentity: (_provider: string, _sessionId?: string) => ({ accountId: "acct-a" }),
			isSessionCredentialPinned: (_provider: string, _sessionId?: string) => true,
			setSessionCredentialPin,
			clearSessionCredentialPin,
		} as unknown as AuthStorage;
		const ctx = baseCtx({ authStorage, editorContainer });
		const controller = new SelectorController(ctx);

		await controller.showAccountSelector("anthropic");

		const selector = editorContainer.children[0];
		if (!(selector instanceof LogoutAccountSelectorComponent)) {
			throw new Error("Expected account switch selector");
		}
		// isSessionCredentialPinned=true means the "Auto" row is not pre-selected;
		// the cursor starts on the currently pinned stored row, so step up once to reach Auto.
		selector.handleInput("\x1b[A");
		selector.handleInput("\n");
		await Promise.resolve();

		expect(clearSessionCredentialPin).toHaveBeenCalledWith("anthropic", "session-account-switch-test");
		expect(setSessionCredentialPin).not.toHaveBeenCalled();
		expect(ctx.showError).not.toHaveBeenCalled();
	});

	it("shows a status message instead of a picker when only one account is stored", async () => {
		const editorContainer = createEditorContainer();
		const credentials = [createStoredCredential(21, "a@example.com", "acct-a")];
		const authStorage = {
			reload: vi.fn(async () => undefined),
			listStoredCredentials: (_provider?: string) => credentials,
			getOAuthAccountIdentity: (_provider: string, _sessionId?: string) => ({ accountId: "acct-a" }),
			isSessionCredentialPinned: (_provider: string, _sessionId?: string) => false,
			setSessionCredentialPin: vi.fn(),
			clearSessionCredentialPin: vi.fn(),
		} as unknown as AuthStorage;
		const ctx = baseCtx({ authStorage, editorContainer });
		const controller = new SelectorController(ctx);

		await controller.showAccountSelector("anthropic");

		expect(editorContainer.children.length).toBe(0);
		expect(ctx.showStatus).toHaveBeenCalled();
	});
});
