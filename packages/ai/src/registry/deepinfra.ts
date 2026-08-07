import { createApiKeyLogin } from "./api-key-login";
import type { OAuthLoginCallbacks } from "./oauth/types";
import type { ProviderDefinition } from "./types";

const API_BASE_URL = "https://api.deepinfra.com/v1/openai";
const VALIDATION_MODEL = "deepseek-ai/DeepSeek-V3";

export const loginDeepInfra = createApiKeyLogin({
	providerLabel: "DeepInfra",
	authUrl: "https://deepinfra.com/dash/api_keys",
	instructions: "Copy your API token from the DeepInfra dashboard",
	promptMessage: "Paste your DeepInfra API token",
	placeholder: "...",
	validation: {
		kind: "chat-completions",
		provider: "DeepInfra",
		baseUrl: API_BASE_URL,
		model: VALIDATION_MODEL,
	},
});

export const deepinfraProvider = {
	id: "deepinfra",
	name: "DeepInfra",
	login: (cb: OAuthLoginCallbacks) => loginDeepInfra(cb),
} as const satisfies ProviderDefinition;
