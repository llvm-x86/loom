import { createApiKeyLogin } from "./api-key-login";
import type { OAuthLoginCallbacks } from "./oauth/types";
import type { ProviderDefinition } from "./types";

const API_BASE_URL = "https://tokenhub-intl.tencentcloudmaas.com/v1";

export const loginTencent = createApiKeyLogin({
	providerLabel: "Tencent Cloud TokenHub",
	authUrl: "https://console.tencentcloud.com/tokenhub/apikey",
	instructions: "Create or copy your API key from the Tencent Cloud TokenHub console",
	promptMessage: "Paste your Tencent Cloud TokenHub API key",
	// TokenHub's key prefix is not documented and no key was available to verify one, so this stays
	// format-neutral (same as `deepinfra`) rather than asserting an unconfirmed `sk-` shape.
	placeholder: "...",
	validation: {
		kind: "models-endpoint",
		provider: "tencent",
		modelsUrl: `${API_BASE_URL}/models`,
	},
});

export const tencentProvider = {
	id: "tencent",
	name: "Tencent Cloud (TokenHub)",
	login: (cb: OAuthLoginCallbacks) => loginTencent(cb),
} as const satisfies ProviderDefinition;
