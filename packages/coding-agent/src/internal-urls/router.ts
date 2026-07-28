/**
 * Internal URL router for internal protocols (`agent://`, `artifact://`, `history://`, `issue://`, `local://`, `loom://`, `mcp://`, `memory://`, `pr://`, `rule://`, `skill://`, `ssh://`, `vault://`, and `xd://`).
 *
 * One process-global router with one handler per scheme. Access via
 * `InternalUrlRouter.instance()`. Handlers are stateless; per-session and
 * shared state lives in `./state.ts`.
 */
import { AgentProtocolHandler } from "./agent-protocol";
import { ArtifactProtocolHandler } from "./artifact-protocol";
import { HistoryProtocolHandler } from "./history-protocol";
import { IssueProtocolHandler, PrProtocolHandler } from "./issue-pr-protocol";
import { LocalProtocolHandler } from "./local-protocol";
import { LoomProtocolHandler } from "./loom-protocol";
import { McpProtocolHandler } from "./mcp-protocol";
import { MemoryProtocolHandler } from "./memory-protocol";
import { parseInternalUrl } from "./parse";
import { RuleProtocolHandler } from "./rule-protocol";
import { SkillProtocolHandler } from "./skill-protocol";
import { SshProtocolHandler } from "./ssh-protocol";
import type {
	InternalResource,
	InternalUrl,
	ProtocolHandler,
	ResolveContext,
	UrlCompletion,
	WriteContext,
} from "./types";
import { VaultProtocolHandler } from "./vault-protocol";
import { XdProtocolHandler } from "./xd-protocol";

export class InternalUrlRouter {
	static #instance: InternalUrlRouter | undefined;

	#handlers = new Map<string, ProtocolHandler>();
	/** Deprecated scheme spellings kept resolvable but hidden from listings and completion. */
	#aliases = new Map<string, ProtocolHandler>();

	constructor() {
		const docs = new LoomProtocolHandler();
		this.register(docs);
		this.registerAlias("omp", docs);
		this.register(new AgentProtocolHandler());
		this.register(new ArtifactProtocolHandler());
		this.register(new MemoryProtocolHandler());
		this.register(new LocalProtocolHandler());
		this.register(new VaultProtocolHandler());
		this.register(new SkillProtocolHandler());
		this.register(new RuleProtocolHandler());
		this.register(new McpProtocolHandler());
		this.register(new IssueProtocolHandler());
		this.register(new PrProtocolHandler());
		this.register(new HistoryProtocolHandler());
		this.register(new SshProtocolHandler());
		this.register(new XdProtocolHandler());
	}

	/** Process-global router instance. */
	static instance(): InternalUrlRouter {
		InternalUrlRouter.#instance ??= new InternalUrlRouter();
		return InternalUrlRouter.#instance;
	}

	/** Reset the global instance in tests. */
	static resetForTests(): void {
		InternalUrlRouter.#instance = undefined;
	}

	register(handler: ProtocolHandler): void {
		this.#handlers.set(handler.scheme.toLowerCase(), handler);
	}

	/**
	 * Bind an additional scheme to an already-registered handler without listing
	 * it anywhere the user can see it. Used for legacy scheme spellings so URLs
	 * baked into old transcripts, skills, and rules keep resolving.
	 */
	registerAlias(scheme: string, handler: ProtocolHandler): void {
		this.#aliases.set(scheme.toLowerCase(), handler);
	}

	unregister(scheme: string): boolean {
		const key = scheme.toLowerCase();
		const removedAlias = this.#aliases.delete(key);
		return this.#handlers.delete(key) || removedAlias;
	}

	getHandler(scheme: string): ProtocolHandler | undefined {
		const key = scheme.toLowerCase();
		return this.#handlers.get(key) ?? this.#aliases.get(key);
	}

	canHandle(input: string): boolean {
		const match = input.match(/^([a-z][a-z0-9+.-]*):\/\//i);
		if (!match) return false;
		const key = match[1].toLowerCase();
		return this.#handlers.has(key) || this.#aliases.has(key);
	}

	/** Schemes whose handler supports host/path autocomplete. */
	completionSchemes(): string[] {
		const schemes: string[] = [];
		for (const [scheme, handler] of this.#handlers) {
			if (handler.complete) schemes.push(scheme);
		}
		return schemes;
	}

	/**
	 * Candidate completions for the host/path portion of `scheme://<query>`.
	 * Returns `null` when the scheme is unknown or does not support completion.
	 * Aliases resolve here too — callers name the scheme explicitly, so this is
	 * a lookup rather than a listing; {@link completionSchemes} stays canonical.
	 */
	async complete(scheme: string, query: string, context?: ResolveContext): Promise<UrlCompletion[] | null> {
		const key = scheme.toLowerCase();
		const handler = this.#handlers.get(key) ?? this.#aliases.get(key);
		if (!handler?.complete) return null;
		return handler.complete(query, context);
	}

	#route(input: string): { parsed: InternalUrl; handler: ProtocolHandler } {
		const parsed = parseInternalUrl(input);
		const scheme = parsed.protocol.replace(/:$/, "").toLowerCase();
		const handler = this.#handlers.get(scheme) ?? this.#aliases.get(scheme);
		if (!handler) {
			const available = Array.from(this.#handlers.keys())
				.map(candidate => `${candidate}://`)
				.join(", ");
			throw new Error(`Unknown protocol: ${scheme}://\nSupported: ${available || "none"}`);
		}
		return { parsed, handler };
	}

	/** Resolve an internal URL through its registered protocol handler. */
	async resolve(input: string, context?: ResolveContext): Promise<InternalResource> {
		const { parsed, handler } = this.#route(input);
		const resource = await handler.resolve(parsed, context);
		return { ...resource, immutable: resource.immutable ?? handler.immutable };
	}

	/** Write an internal URL through its registered protocol handler. */
	async write(input: string, content: string, context?: WriteContext): Promise<void> {
		const { parsed, handler } = this.#route(input);
		if (!handler.write) {
			const scheme = parsed.protocol.replace(/:$/, "").toLowerCase();
			throw new Error(`${scheme}:// URLs are read-only for write; use the protocol-specific tool for mutations.`);
		}
		await handler.write(parsed, content, context);
	}
}
