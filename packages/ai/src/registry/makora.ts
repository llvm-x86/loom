import { createApiKeyLogin } from "./api-key-login";
import type { OAuthLoginCallbacks } from "./oauth/types";
import type { ProviderDefinition } from "./types";

const API_BASE_URL = "https://inference.makora.com/v1";
const VALIDATION_MODEL = "deepseek-ai/DeepSeek-V4-Flash";

export const loginMakora = createApiKeyLogin({
	providerLabel: "Makora",
	authUrl: "https://inference.makora.com",
	instructions: "Copy your API key from the Makora dashboard",
	promptMessage: "Paste your Makora API key",
	placeholder: "mk_...",
	validation: {
		kind: "chat-completions",
		provider: "Makora",
		baseUrl: API_BASE_URL,
		model: VALIDATION_MODEL,
	},
});

export const makoraProvider = {
	id: "makora",
	name: "Makora",
	login: (cb: OAuthLoginCallbacks) => loginMakora(cb),
} as const satisfies ProviderDefinition;
