import { afterEach, beforeAll, describe, expect, it, type Mock, vi } from "bun:test";
import type { Model } from "@oh-my-pi/pi-ai";
import type { ModelPickerCallbacks, ModelPickerOptions } from "@oh-my-pi/pi-coding-agent/modes/components/model-picker";
import * as modelPicker from "@oh-my-pi/pi-coding-agent/modes/components/model-picker";
import { SelectorController } from "@oh-my-pi/pi-coding-agent/modes/controllers/selector-controller";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";

beforeAll(async () => {
	await initTheme();
});

afterEach(() => {
	vi.restoreAllMocks();
});

function createHarness(options?: { statusHint?: string; footerHint?: string; currentSelector?: string }) {
	let capturedCallbacks: ModelPickerCallbacks | undefined;
	let capturedOptions: ModelPickerOptions | undefined;
	const overlayHandle = { hide: vi.fn() };
	const setModelTemporary = vi.fn();
	const applyRoleModel = vi.fn();
	const showStatus = vi.fn();
	const invalidate = vi.fn();
	const updateEditorBorderColor = vi.fn();
	const requestRender = vi.fn();
	const setFocus = vi.fn();
	const focusActiveEditorArea = vi.fn();

	const model = { provider: "openai", id: "gpt-4" } as Model;

	const ctx = {
		ui: {
			showOverlay: vi.fn((_picker, overlayOptions) => {
				expect(overlayOptions).toEqual({
					anchor: "bottom-center",
					width: "100%",
					maxHeight: "100%",
					margin: 0,
				});
				return overlayHandle;
			}),
			setFocus,
			requestRender,
		},
		settings: { get: vi.fn() },
		session: {
			model,
			getContextUsage: vi.fn(() => ({ tokens: 12_000 })),
			modelRegistry: {},
			scopedModels: [],
			setModelTemporary,
			applyRoleModel,
			resolveTemporaryModelThinkingLevel: vi.fn(),
		},
		showStatus,
		statusLine: { invalidate },
		updateEditorBorderColor,
		editorContainer: { children: [] },
		editor: {},
	} as unknown as InteractiveModeContext;

	const controller = new SelectorController(ctx);
	controller.focusActiveEditorArea = focusActiveEditorArea;

	const modelPickerSpy = vi.spyOn(modelPicker, "ModelPickerComponent") as unknown as Mock<
		(...args: ConstructorParameters<typeof modelPicker.ModelPickerComponent>) => modelPicker.ModelPickerComponent
	>;
	modelPickerSpy.mockImplementation((...args) => {
		capturedCallbacks = args[4];
		capturedOptions = args[5];
		return {} as modelPicker.ModelPickerComponent;
	});

	const promise = controller.pickModel(options);

	return {
		promise,
		getCallbacks: () => {
			if (!capturedCallbacks) throw new Error("ModelPickerComponent was not constructed");
			return capturedCallbacks;
		},
		getOptions: () => {
			if (!capturedOptions) throw new Error("ModelPickerComponent was not constructed");
			return capturedOptions;
		},
		overlayHandle,
		setModelTemporary,
		applyRoleModel,
		showStatus,
		invalidate,
		updateEditorBorderColor,
		requestRender,
		setFocus,
		focusActiveEditorArea,
		model,
	};
}

describe("SelectorController.pickModel", () => {
	it("resolves model and selector on pick", async () => {
		const { promise, getCallbacks, overlayHandle, focusActiveEditorArea, requestRender } = createHarness();
		const picked = { provider: "anthropic", id: "claude" } as Model;

		getCallbacks().onPick(picked, "anthropic/claude");
		await expect(promise).resolves.toEqual({ model: picked, selector: "anthropic/claude" });
		expect(overlayHandle.hide).toHaveBeenCalledTimes(1);
		expect(focusActiveEditorArea).toHaveBeenCalledTimes(1);
		expect(requestRender).toHaveBeenCalled();
	});

	it("resolves undefined on cancel", async () => {
		const { promise, getCallbacks, overlayHandle } = createHarness();

		getCallbacks().onCancel();
		await expect(promise).resolves.toBeUndefined();
		expect(overlayHandle.hide).toHaveBeenCalledTimes(1);
	});

	it("resolves once even if pick and cancel fire again", async () => {
		const { promise, getCallbacks, overlayHandle, focusActiveEditorArea } = createHarness();
		const picked = { provider: "openai", id: "gpt-4" } as Model;

		getCallbacks().onPick(picked, "openai/gpt-4");
		getCallbacks().onPick(picked, "openai/gpt-4");
		getCallbacks().onCancel();

		await expect(promise).resolves.toEqual({ model: picked, selector: "openai/gpt-4" });
		expect(overlayHandle.hide).toHaveBeenCalledTimes(1);
		expect(focusActiveEditorArea).toHaveBeenCalledTimes(1);
	});

	it("does not mutate session state or show status", async () => {
		const {
			promise,
			getCallbacks,
			setModelTemporary,
			applyRoleModel,
			showStatus,
			invalidate,
			updateEditorBorderColor,
		} = createHarness();
		const picked = { provider: "openai", id: "gpt-4" } as Model;

		getCallbacks().onPick(picked, "openai/gpt-4");
		await promise;

		expect(setModelTemporary).not.toHaveBeenCalled();
		expect(applyRoleModel).not.toHaveBeenCalled();
		expect(showStatus).not.toHaveBeenCalled();
		expect(invalidate).not.toHaveBeenCalled();
		expect(updateEditorBorderColor).not.toHaveBeenCalled();
	});

	it("omits quick-role wiring and session currentSelector fallback", async () => {
		const { promise, getCallbacks, getOptions } = createHarness();

		expect(getOptions()).toEqual({
			currentContextTokens: 12_000,
			currentSelector: undefined,
		});
		expect(getCallbacks()).toEqual({
			onPick: expect.any(Function),
			onCancel: expect.any(Function),
		});
		expect(getCallbacks()).not.toHaveProperty("onPickRole");
		expect(getOptions()).not.toHaveProperty("quickRoles");
		expect(getOptions()).not.toHaveProperty("quickRoleOrder");
		expect(getOptions()).not.toHaveProperty("currentQuickRole");

		getCallbacks().onCancel();
		await expect(promise).resolves.toBeUndefined();
	});

	it("forwards hint overrides and currentSelector to ModelPickerComponent", async () => {
		const { promise, getOptions, getCallbacks } = createHarness({
			statusHint: "Choose a default model",
			footerHint: "Enter confirm · Esc dismiss",
			currentSelector: "anthropic/claude",
		});

		expect(getOptions()).toMatchObject({
			statusHint: "Choose a default model",
			footerHint: "Enter confirm · Esc dismiss",
			currentSelector: "anthropic/claude",
			currentContextTokens: 12_000,
		});

		getCallbacks().onCancel();
		await expect(promise).resolves.toBeUndefined();
	});
});
