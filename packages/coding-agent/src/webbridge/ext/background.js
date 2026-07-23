/**
 * Loom WebBridge — MV3 background service worker.
 *
 * Maintains a WebSocket to the local Loom WebBridge daemon and executes the
 * commands it forwards against the real browser using `chrome.*` APIs
 * (tabs / scripting / debugger). All browser + session + tab state lives here;
 * the daemon is a stateless router. Wire frames:
 *   inbound  { id, action, args, session }
 *   outbound { id, ok: true, data } | { id, ok: false, error: { code, message } }
 *   hello    { type: "hello", version }
 *
 * Service workers are killed aggressively in MV3, so an alarm reconnects the
 * socket and per-session state is persisted to chrome.storage.session.
 */

const PROTOCOL_VERSION = "1";
const DEFAULT_PORT = 10088;
const RECONNECT_MS = 3000;
const SESSION_PREFIX = "loom:session:";
const KEEPALIVE_ALARM = "loom-webbridge-keepalive";

let socket = null;
let reconnectTimer = null;
/** tabIds we currently hold a debugger attachment on. */
const attachedTabs = new Set();

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

async function resolvePort() {
	try {
		const stored = await chrome.storage.local.get("webbridgePort");
		const port = Number(stored.webbridgePort);
		if (Number.isInteger(port) && port > 0) return port;
	} catch {}
	return DEFAULT_PORT;
}

async function connect() {
	if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;
	const port = await resolvePort();
	try {
		socket = new WebSocket(`ws://127.0.0.1:${port}/ext`);
	} catch (err) {
		scheduleReconnect();
		return;
	}
	socket.addEventListener("open", () => {
		send({ type: "hello", version: PROTOCOL_VERSION });
	});
	socket.addEventListener("message", event => {
		void onMessage(event.data);
	});
	socket.addEventListener("close", () => {
		socket = null;
		scheduleReconnect();
	});
	socket.addEventListener("error", () => {
		try {
			socket && socket.close();
		} catch {}
	});
}

function scheduleReconnect() {
	if (reconnectTimer) return;
	reconnectTimer = setTimeout(() => {
		reconnectTimer = null;
		void connect();
	}, RECONNECT_MS);
}

function send(obj) {
	if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(obj));
}

async function onMessage(raw) {
	let frame;
	try {
		frame = JSON.parse(typeof raw === "string" ? raw : String(raw));
	} catch {
		return;
	}
	if (!frame || typeof frame.id !== "string") return;
	const { id, action, args, session } = frame;
	try {
		const handler = HANDLERS[action];
		if (!handler) throw fail("unknown_action", `unknown action: ${action}`);
		const data = await handler(args || {}, session || "default");
		send({ id, ok: true, data });
	} catch (err) {
		send({ id, ok: false, error: toError(err) });
	}
}

function fail(code, message) {
	const e = new Error(message);
	e.code = code;
	return e;
}

function toError(err) {
	if (err && typeof err === "object" && err.code) return { code: err.code, message: err.message || String(err) };
	return { code: "extension_error", message: err && err.message ? err.message : String(err) };
}

// ---------------------------------------------------------------------------
// Session / tab state (persisted so it survives SW restarts)
// ---------------------------------------------------------------------------

// Each session is stored under its OWN key (`loom:session:<name>`) so
// concurrent sessions never read-modify-write a shared object and clobber each
// other — the invariant that lets many loom sessions drive one browser at once.
async function getSession(session) {
	const key = SESSION_PREFIX + session;
	const stored = await chrome.storage.session.get(key);
	return stored[key] || { currentTabId: null, tabIds: [], groupId: null };
}

async function updateSession(session, patch) {
	const key = SESSION_PREFIX + session;
	const next = { ...(await getSession(session)), ...patch };
	await chrome.storage.session.set({ [key]: next });
	return next;
}

async function deleteSession(session) {
	await chrome.storage.session.remove(SESSION_PREFIX + session);
}

// Tab groups: every session's tabs live in one auto-created, auto-labelled
// Chrome tab group so concurrent loom sessions stay visually separated.
const GROUP_COLORS = ["blue", "red", "yellow", "green", "pink", "purple", "cyan", "orange"];

function colorForSession(session) {
	let hash = 0;
	for (let i = 0; i < session.length; i += 1) hash = (hash * 31 + session.charCodeAt(i)) >>> 0;
	return GROUP_COLORS[hash % GROUP_COLORS.length];
}

/** Ensure `tabId` is in the session's tab group, creating + labelling it once. Returns the group id. */
async function ensureTabGroup(session, tabId, state) {
	let groupId = state.groupId ?? null;
	if (groupId != null) {
		try {
			await chrome.tabGroups.get(groupId);
		} catch {
			groupId = null;
		}
	}
	try {
		if (groupId == null) {
			groupId = await chrome.tabs.group({ tabIds: [tabId] });
			await chrome.tabGroups.update(groupId, { title: `loom:${session}`, color: colorForSession(session) });
		} else {
			await chrome.tabs.group({ groupId, tabIds: [tabId] });
		}
		return groupId;
	} catch {
		return groupId;
	}
}

/** The tab a single-tab action targets. Throws if the session has none live. */
async function requireTab(session) {
	const state = await getSession(session);
	if (state.currentTabId != null) {
		try {
			const tab = await chrome.tabs.get(state.currentTabId);
			if (tab) return tab;
		} catch {}
	}
	throw fail("no_tab", `session "${session}" has no active tab — navigate first`);
}

function waitForTabLoad(tabId, timeoutMs = 30000) {
	return new Promise((resolve, reject) => {
		let done = false;
		const finish = fn => arg => {
			if (done) return;
			done = true;
			chrome.tabs.onUpdated.removeListener(onUpdated);
			clearTimeout(timer);
			fn(arg);
		};
		const ok = finish(resolve);
		const bad = finish(reject);
		const timer = setTimeout(() => bad(fail("timeout", "page load timed out")), timeoutMs);
		const onUpdated = (id, info) => {
			if (id === tabId && info.status === "complete") ok();
		};
		chrome.tabs.onUpdated.addListener(onUpdated);
		chrome.tabs.get(tabId).then(tab => {
			if (tab && tab.status === "complete") ok();
		}, () => {});
	});
}

// ---------------------------------------------------------------------------
// Injected page functions (must be self-contained — run in the page world)
// ---------------------------------------------------------------------------

function pageSnapshot() {
	let counter = 0;
	const MAX_NAME = 120;
	const isVisible = el => {
		const style = window.getComputedStyle(el);
		if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return false;
		const rect = el.getBoundingClientRect();
		return rect.width > 0 && rect.height > 0;
	};
	const roleOf = el => {
		const explicit = el.getAttribute("role");
		if (explicit) return explicit;
		const tag = el.tagName.toLowerCase();
		const map = {
			a: "link",
			button: "button",
			input: "textbox",
			select: "combobox",
			textarea: "textbox",
			img: "image",
			h1: "heading",
			h2: "heading",
			h3: "heading",
			h4: "heading",
			nav: "navigation",
			ul: "list",
			ol: "list",
			li: "listitem",
		};
		return map[tag] || tag;
	};
	const nameOf = el => {
		const aria = el.getAttribute("aria-label");
		if (aria) return aria.trim().slice(0, MAX_NAME);
		if (el.tagName === "INPUT") {
			const ph = el.getAttribute("placeholder") || el.getAttribute("value") || el.getAttribute("name");
			if (ph) return ph.trim().slice(0, MAX_NAME);
		}
		let text = "";
		for (const node of el.childNodes) {
			if (node.nodeType === Node.TEXT_NODE) text += node.textContent;
		}
		text = text.replace(/\s+/g, " ").trim();
		if (text) return text.slice(0, MAX_NAME);
		const alt = el.getAttribute && el.getAttribute("alt");
		return alt ? alt.trim().slice(0, MAX_NAME) : "";
	};
	const interactiveTags = new Set(["A", "BUTTON", "INPUT", "SELECT", "TEXTAREA"]);
	const isInteractive = el =>
		interactiveTags.has(el.tagName) || el.hasAttribute("onclick") || el.getAttribute("role") === "button" || el.tabIndex >= 0;
	const walk = el => {
		if (!(el instanceof Element) || !isVisible(el)) return null;
		const children = [];
		for (const child of el.children) {
			const node = walk(child);
			if (node) children.push(node);
		}
		const interactive = isInteractive(el);
		const name = nameOf(el);
		if (!interactive && !name && children.length === 0) return null;
		// Collapse pure wrapper elements (no ref, no name, single child).
		if (!interactive && !name && children.length === 1) return children[0];
		const out = { role: roleOf(el) };
		if (interactive) {
			counter += 1;
			const ref = "e" + counter;
			el.setAttribute("data-loom-ref", ref);
			out.ref = ref;
		}
		if (name) out.name = name;
		if (children.length) out.children = children;
		return out;
	};
	return { url: location.href, title: document.title, tree: walk(document.body) };
}

async function runInPage(tabId, func, args) {
	const results = await chrome.scripting.executeScript({
		target: { tabId },
		world: "MAIN",
		func,
		args: args || [],
	});
	return results && results[0] ? results[0].result : undefined;
}

// Injected page functions must be self-contained (executeScript serializes the
// function body), so each inlines its own selector resolver.
function pageClickBundled(selector) {
	const resolve = sel => (sel && sel.charAt(0) === "@" ? document.querySelector('[data-loom-ref="' + sel.slice(1) + '"]') : document.querySelector(sel));
	const el = resolve(selector);
	if (!el) return { ok: false, code: "not_found", message: "no element for selector: " + selector };
	el.scrollIntoView({ block: "center", inline: "center" });
	el.click();
	return { ok: true, tag: el.tagName, text: (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 120) };
}

function pageFillBundled(selector, value) {
	const resolve = sel => (sel && sel.charAt(0) === "@" ? document.querySelector('[data-loom-ref="' + sel.slice(1) + '"]') : document.querySelector(sel));
	const el = resolve(selector);
	if (!el) return { ok: false, code: "not_found", message: "no element for selector: " + selector };
	el.focus();
	if (el.isContentEditable) {
		el.textContent = value;
	} else {
		const proto = el.tagName === "TEXTAREA" ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
		const setter = Object.getOwnPropertyDescriptor(proto, "value");
		if (setter && setter.set) setter.set.call(el, value);
		else el.value = value;
	}
	el.dispatchEvent(new Event("input", { bubbles: true }));
	el.dispatchEvent(new Event("change", { bubbles: true }));
	return { ok: true, tag: el.tagName };
}

// ---------------------------------------------------------------------------
// Debugger (CDP) helpers
// ---------------------------------------------------------------------------

async function ensureDebugger(tabId) {
	if (attachedTabs.has(tabId)) return;
	await chrome.debugger.attach({ tabId }, "1.3");
	attachedTabs.add(tabId);
}

async function detachDebugger(tabId) {
	if (!attachedTabs.has(tabId)) return;
	try {
		await chrome.debugger.detach({ tabId });
	} catch {}
	attachedTabs.delete(tabId);
}

function cdpSend(tabId, method, params) {
	return new Promise((resolve, reject) => {
		chrome.debugger.sendCommand({ tabId }, method, params || {}, result => {
			const lastError = chrome.runtime.lastError;
			if (lastError) reject(fail("cdp_error", lastError.message));
			else resolve(result);
		});
	});
}

// ---------------------------------------------------------------------------
// Action handlers
// ---------------------------------------------------------------------------

const HANDLERS = {
	async navigate(args, session) {
		let url = String(args.url || "").trim();
		if (!url) throw fail("bad_args", "navigate requires args.url");
		if (!/^[a-z][a-z0-9+.-]*:/i.test(url)) url = "https://" + url;
		const state = await getSession(session);
		let tabId = state.currentTabId;
		const wantNewTab = Boolean(args.newTab) || tabId == null;
		if (!wantNewTab) {
			try {
				await chrome.tabs.get(tabId);
				await chrome.tabs.update(tabId, { url, active: true });
			} catch {
				tabId = null;
			}
		}
		if (tabId == null) {
			const tab = await chrome.tabs.create({ url, active: true });
			tabId = tab.id;
		}
		await waitForTabLoad(tabId);
		const tab = await chrome.tabs.get(tabId);
		const tabIds = state.tabIds.includes(tabId) ? state.tabIds : [...state.tabIds, tabId];
		const groupId = await ensureTabGroup(session, tabId, state);
		await updateSession(session, { currentTabId: tabId, tabIds, groupId });
		return { success: true, url: tab.url, tabId, groupId };
	},

	async snapshot(_args, session) {
		const tab = await requireTab(session);
		const result = await runInPage(tab.id, pageSnapshot, []);
		if (!result) throw fail("snapshot_failed", "could not snapshot page");
		return result;
	},

	async click(args, session) {
		if (!args.selector) throw fail("bad_args", "click requires args.selector");
		const tab = await requireTab(session);
		const result = await runInPage(tab.id, pageClickBundled, [String(args.selector)]);
		if (!result || !result.ok) throw fail(result ? result.code : "click_failed", result ? result.message : "click failed");
		return { success: true, tag: result.tag, text: result.text };
	},

	async fill(args, session) {
		if (!args.selector) throw fail("bad_args", "fill requires args.selector");
		const tab = await requireTab(session);
		const result = await runInPage(tab.id, pageFillBundled, [String(args.selector), String(args.value ?? "")]);
		if (!result || !result.ok) throw fail(result ? result.code : "fill_failed", result ? result.message : "fill failed");
		return { success: true, tag: result.tag };
	},

	async evaluate(args, session) {
		const code = String(args.code ?? args.expression ?? "");
		if (!code) throw fail("bad_args", "evaluate requires args.code");
		const tab = await requireTab(session);
		await ensureDebugger(tab.id);
		try {
			const res = await cdpSend(tab.id, "Runtime.evaluate", {
				expression: code,
				returnByValue: true,
				awaitPromise: true,
				userGesture: true,
			});
			if (res.exceptionDetails) {
				const ex = res.exceptionDetails;
				throw fail("evaluate_error", (ex.exception && ex.exception.description) || ex.text || "evaluate threw");
			}
			return { type: res.result.type, value: res.result.value };
		} finally {
			// Keep the debugger attached for subsequent evaluate/cdp calls in this session.
		}
	},

	async cdp(args, session) {
		if (!args.method) throw fail("bad_args", "cdp requires args.method");
		const tab = await requireTab(session);
		await ensureDebugger(tab.id);
		const result = await cdpSend(tab.id, String(args.method), args.params || {});
		return { result };
	},

	async screenshot(args, session) {
		const tab = await requireTab(session);
		await chrome.tabs.update(tab.id, { active: true });
		const format = args.format === "jpeg" || args.format === "jpg" ? "jpeg" : "png";
		const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format });
		const base64 = dataUrl.split(",")[1] || "";
		return { format, base64 };
	},

	async list_tabs() {
		const tabs = await chrome.tabs.query({});
		return { tabs: tabs.map(t => ({ id: t.id, url: t.url, title: t.title, active: t.active })) };
	},

	async focus() {
		// Raise the user's real browser. Prefer the last-focused normal window
		// (un-minimize it); create one if the browser has no windows open.
		const wins = await chrome.windows.getAll({ windowTypes: ["normal"] });
		if (!wins.length) {
			const created = await chrome.windows.create({ focused: true });
			return { focused: true, windowId: created.id, created: true };
		}
		const target = wins.find(w => w.focused) || wins.find(w => w.state !== "minimized") || wins[0];
		const patch = target.state === "minimized" ? { focused: true, state: "normal" } : { focused: true };
		await chrome.windows.update(target.id, patch);
		return { focused: true, windowId: target.id, created: false };
	},

	async find_tab(args, session) {
		const query = String(args.query || "").toLowerCase();
		const tabs = await chrome.tabs.query({});
		const matches = tabs.filter(
			t => (t.url && t.url.toLowerCase().includes(query)) || (t.title && t.title.toLowerCase().includes(query)),
		);
		if (matches.length && args.activate !== false) {
			const state = await getSession(session);
			const adoptedId = matches[0].id;
			const tabIds = state.tabIds.includes(adoptedId) ? state.tabIds : [...state.tabIds, adoptedId];
			const groupId = await ensureTabGroup(session, adoptedId, state);
			await updateSession(session, { currentTabId: adoptedId, tabIds, groupId });
		}
		return { matched: matches.length, tabs: matches.map(t => ({ id: t.id, url: t.url, title: t.title })) };
	},

	async close_tab(args, session) {
		const state = await getSession(session);
		const tabId = args.tabId != null ? Number(args.tabId) : state.currentTabId;
		if (tabId == null) throw fail("no_tab", "no tab to close");
		await detachDebugger(tabId);
		try {
			await chrome.tabs.remove(tabId);
		} catch {}
		const tabIds = state.tabIds.filter(id => id !== tabId);
		await updateSession(session, {
			tabIds,
			currentTabId: state.currentTabId === tabId ? (tabIds[tabIds.length - 1] ?? null) : state.currentTabId,
		});
		return { success: true };
	},

	async close_session(_args, session) {
		const state = await getSession(session);
		for (const tabId of state.tabIds) {
			await detachDebugger(tabId);
			try {
				await chrome.tabs.remove(tabId);
			} catch {}
		}
		await deleteSession(session);
		return { success: true };
	},
};

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

chrome.runtime.onInstalled.addListener(() => {
	chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.4 });
	void connect();
});
chrome.runtime.onStartup.addListener(() => {
	chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.4 });
	void connect();
});
chrome.alarms.onAlarm.addListener(alarm => {
	if (alarm.name === KEEPALIVE_ALARM) void connect();
});
chrome.debugger.onDetach.addListener(source => {
	if (source.tabId != null) attachedTabs.delete(source.tabId);
});

void connect();
