import { connect, launch, type Browser, type Download, type Page } from "@cloudflare/playwright";
import { getSandbox } from "@cloudflare/sandbox";
import type { HostedBrowserActionRequest, HostedBrowserControl, HostedBrowserDownloadSnapshot, HostedBrowserNavigateRequest, HostedBrowserSnapshot } from "@fable/protocol";
import { DurableObject } from "cloudflare:workers";
import { Readable } from "node:stream";
import { safeDownloadFileName } from "./browser-download";
import { validateBrowserActionRequest, validateBrowserNavigateRequest, validateComputerId, validatePublicHttpsUrl } from "./contracts";
import {
  MAX_BROWSER_HISTORY,
  appendBrowserHistory,
  browserNavigationSnapshot,
  moveBrowserHistory,
  replaceCurrentBrowserHistory,
  type BrowserHistoryState
} from "./browser-history";

const KEEP_ALIVE_MS = 10 * 60_000;
const MAX_PREVIEW_BYTES = 300 * 1024;
const MAX_DOWNLOAD_BYTES = 25 * 1024 * 1024;

interface BrowserRow extends Record<string, SqlStorageValue> {
  computer_id: string;
  generation: number;
  session_id: string | null;
  current_url: string | null;
  title: string | null;
  last_request_key: string | null;
  last_action_request_key: string | null;
  observation_id: string | null;
  history_json: string;
  history_index: number;
  last_download_json: string | null;
  updated_at: string;
}


/** One browser coordination atom per hosted computer. */
export class BrowserAuthority extends DurableObject<Env> {
  private browser: Browser | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.migrate();
    });
  }

  async navigate(
    rawComputerId: string,
    rawRequest: unknown,
    generation: number
  ): Promise<HostedBrowserSnapshot> {
    const computerId = validateComputerId(rawComputerId);
    const request = validateBrowserNavigateRequest(rawRequest);
    const page = await this.page(computerId, generation);
    const stored = this.readState();
    if (stored?.last_request_key !== request.requestKey || page.url() !== request.url) {
      await this.guardPage(page);
      await page.goto(request.url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    }
    const currentUrl = validatePublicHttpsUrl(page.url());
    const title = (await page.title()).trim().slice(0, 240);
    const updatedAt = new Date().toISOString();
    const history = this.history(stored, currentUrl);
    const snapshot = await this.snapshotFromPage(page, currentUrl, title, updatedAt, history, true, null);
    this.writeState({
      computerId,
      generation,
      sessionId: this.requiredBrowser().sessionId(),
      currentUrl,
      title,
      lastRequestKey: request.requestKey,
      lastActionRequestKey: stored?.last_action_request_key ?? null,
      observationId: snapshot.observationId,
      history,
      lastDownload: null,
      updatedAt
    });
    return snapshot;
  }

  async act(rawComputerId: string, rawRequest: unknown, generation: number): Promise<HostedBrowserSnapshot> {
    const computerId = validateComputerId(rawComputerId);
    const request = validateBrowserActionRequest(rawRequest);
    const page = await this.page(computerId, generation);
    const stored = this.readState();
    if (stored?.last_action_request_key === request.requestKey) {
      const currentUrl = validatePublicHttpsUrl(page.url());
      const title = (await page.title()).trim().slice(0, 240);
      const updatedAt = new Date().toISOString();
      const history = this.history(stored, currentUrl);
      const lastDownload = this.lastDownload(stored);
      const snapshot = await this.snapshotFromPage(page, currentUrl, title, updatedAt, history, true, lastDownload);
      this.writeState({
        computerId,
        generation,
        sessionId: this.requiredBrowser().sessionId(),
        currentUrl,
        title,
        lastRequestKey: stored.last_request_key,
        lastActionRequestKey: stored.last_action_request_key,
        observationId: snapshot.observationId,
        history,
        lastDownload,
        updatedAt
      });
      return snapshot;
    }
    if (
      !stored
      || stored.observation_id !== request.observationId
      || stored.current_url !== validatePublicHttpsUrl(page.url())
    ) {
      throw new Error("browser-observation-stale");
    }
    let history = this.history(stored, stored.current_url);
    let lastDownload: HostedBrowserDownloadSnapshot | null = null;
    await this.guardPage(page);
    if (request.action === "history") {
      const moved = moveBrowserHistory(history, request.value === "back" ? "back" : "forward");
      if (!moved) throw new Error("browser-history-unavailable");
      await page.goto(moved.target, { waitUntil: "domcontentloaded", timeout: 30_000 });
      history = moved.history;
    } else if (request.action === "scroll") {
        const viewportHeight = page.viewportSize()?.height ?? 800;
        const distance = request.value?.startsWith("half-page") ? Math.round(viewportHeight / 2) : viewportHeight;
        const direction = request.value?.endsWith("-up") ? -1 : 1;
        await page.evaluate((delta) => {
          window.scrollBy({ top: delta, left: 0, behavior: "instant" });
        }, distance * direction);
    } else {
        const locator = page.locator(`[data-fable-control-ref="${request.elementRef}"]`);
        if (await locator.count() !== 1 || !await locator.isVisible() || !await locator.isEnabled()) {
          throw new Error("browser-control-stale");
        }
        if (
          await locator.getAttribute("data-fable-control-role") !== request.controlRole
          || await locator.getAttribute("data-fable-control-name") !== request.controlName
        ) {
          throw new Error("browser-control-changed");
        }
        const controlType = (await locator.getAttribute("type") || "").toLowerCase();
        const autocomplete = (await locator.getAttribute("autocomplete") || "").toLowerCase();
        if (
          request.action === "fill"
          && (controlType === "password" || /password|one-time-code|cc-|transaction|webauthn/u.test(autocomplete))
        ) {
          throw new Error("browser-sensitive-input-blocked");
        }
        if (request.action === "download") {
          const downloadPromise = page.waitForEvent("download", { timeout: 15_000 });
          await locator.click({ timeout: 10_000 });
          lastDownload = await this.saveDownload(computerId, generation, request.requestKey, await downloadPromise);
          // Fence the irreversible file write before screenshot/Live View work.
          // A retry after later presentation failure returns the same retained
          // file metadata instead of clicking the download control twice.
          this.writeState({
            computerId,
            generation,
            sessionId: this.requiredBrowser().sessionId(),
            currentUrl: stored.current_url,
            title: stored.title ?? "",
            lastRequestKey: stored.last_request_key,
            lastActionRequestKey: request.requestKey,
            observationId: stored.observation_id,
            history,
            lastDownload,
            updatedAt: new Date().toISOString()
          });
        } else if (request.action === "click") await locator.click({ timeout: 10_000 });
        else if (request.action === "fill") await locator.fill(request.value ?? "", { timeout: 10_000 });
        else if (request.action === "select") {
          if (await locator.evaluate((element) => element.tagName.toLowerCase()) !== "select") {
            throw new Error("browser-select-control-invalid");
          }
          await locator.selectOption({ label: request.value ?? "" }, { timeout: 10_000 });
        } else await locator.press(request.key ?? "", { timeout: 10_000 });
    }
    await page.waitForTimeout(250);
    const currentUrl = validatePublicHttpsUrl(page.url());
    history = request.action === "history"
      ? replaceCurrentBrowserHistory(history, currentUrl)
      : appendBrowserHistory(history, currentUrl);
    const title = (await page.title()).trim().slice(0, 240);
    const updatedAt = new Date().toISOString();
    const snapshot = await this.snapshotFromPage(page, currentUrl, title, updatedAt, history, true, lastDownload);
    this.writeState({
      computerId,
      generation,
      sessionId: this.requiredBrowser().sessionId(),
      currentUrl,
      title,
      lastRequestKey: stored.last_request_key,
      lastActionRequestKey: request.requestKey,
      observationId: snapshot.observationId,
      history,
      lastDownload,
      updatedAt
    });
    return snapshot;
  }

  async snapshot(rawComputerId: string, generation: number): Promise<HostedBrowserSnapshot> {
    const computerId = validateComputerId(rawComputerId);
    const page = await this.page(computerId, generation);
    const currentUrl = validatePublicHttpsUrl(page.url());
    const title = (await page.title()).trim().slice(0, 240);
    const updatedAt = new Date().toISOString();
    const stored = this.readState();
    const history = this.history(stored, currentUrl);
    const lastDownload = this.lastDownload(stored);
    const snapshot = await this.snapshotFromPage(page, currentUrl, title, updatedAt, history, false, lastDownload);
    this.writeState({
      computerId,
      generation,
      sessionId: this.requiredBrowser().sessionId(),
      currentUrl,
      title,
      lastRequestKey: stored?.last_request_key ?? null,
      lastActionRequestKey: stored?.last_action_request_key ?? null,
      observationId: snapshot.observationId,
      history,
      lastDownload,
      updatedAt
    });
    return snapshot;
  }

  async destroy(rawComputerId: string): Promise<void> {
    validateComputerId(rawComputerId);
    if (this.browser) {
      try {
        await this.browser.close();
      } catch {
        // A Browser Run session may already have reached its inactivity limit.
      }
    }
    this.browser = null;
    this.ctx.storage.sql.exec("DELETE FROM browser_state");
  }

  private async page(computerId: string, generation: number): Promise<Page> {
    const state = this.readState();
    if (state && (state.computer_id !== computerId || state.generation !== generation)) {
      await this.destroy(computerId);
    }
    const browser = await this.ensureBrowser(state?.session_id ?? null);
    const contexts = browser.contexts();
    const context = contexts[0] ?? await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const pages = context.pages();
    const page = pages[0] ?? await context.newPage();
    await page.setViewportSize({ width: 1280, height: 800 });
    return page;
  }

  private async ensureBrowser(sessionId: string | null): Promise<Browser> {
    if (this.browser?.isConnected()) return this.browser;
    if (sessionId) {
      try {
        this.browser = await connect(this.env.MYBROWSER, sessionId);
        return this.browser;
      } catch {
        this.browser = null;
      }
    }
    this.browser = await launch(this.env.MYBROWSER, { keep_alive: KEEP_ALIVE_MS });
    return this.browser;
  }

  private requiredBrowser(): Browser {
    if (!this.browser?.isConnected()) throw new Error("browser-session-unavailable");
    return this.browser;
  }

  private async guardPage(page: Page): Promise<void> {
    await page.unroute("**/*");
    await page.route("**/*", async (route) => {
      try {
        validatePublicHttpsUrl(route.request().url());
        await route.continue();
      } catch {
        await route.abort("blockedbyclient");
      }
    });
  }

  private async snapshotFromPage(
    page: Page,
    currentUrl: string,
    title: string,
    updatedAt: string,
    history: BrowserHistoryState,
    includeLiveView: boolean,
    lastDownload: HostedBrowserDownloadSnapshot | null
  ): Promise<HostedBrowserSnapshot> {
    let image = await page.screenshot({ type: "jpeg", quality: 68, animations: "disabled" });
    if (image.byteLength > MAX_PREVIEW_BYTES) {
      image = await page.screenshot({ type: "jpeg", quality: 42, animations: "disabled" });
    }
    if (image.byteLength > MAX_PREVIEW_BYTES) throw new Error("browser-preview-too-large");
    const previewDataUrl = `data:image/jpeg;base64,${Buffer.from(image).toString("base64")}`;
    const { observationId, controls, viewport } = await this.observeControls(page);
    const navigation = browserNavigationSnapshot(history);
    const download = lastDownload ? { lastDownload } : {};
    if (!includeLiveView) return { currentUrl, title, observationId, viewport, navigation, controls, previewDataUrl, ...download, updatedAt };
    const liveViewUrl = await this.liveViewUrl(page);
    return { currentUrl, title, observationId, viewport, navigation, controls, previewDataUrl, liveViewUrl, ...download, updatedAt };
  }

  private async saveDownload(
    computerId: string,
    generation: number,
    requestKey: string,
    download: Download
  ): Promise<HostedBrowserDownloadSnapshot> {
    const state = this.readState();
    if (!state || state.computer_id !== computerId || state.generation !== generation) throw new Error("capability-stale");
    if (await download.failure()) throw new Error("browser-download-failed");
    const fileName = safeDownloadFileName(download.suggestedFilename());
    const suffix = requestKey.replace(/^browser-action-/u, "").replace(/[^A-Za-z0-9_-]/gu, "").slice(0, 48);
    const workspacePath = `/workspace/downloads/${suffix}-${fileName}`;
    const temporaryPath = `/workspace/.fable/download-${suffix}.part`;
    const source = Readable.toWeb(await download.createReadStream()) as ReadableStream<Uint8Array>;
    let bytesWritten = 0;
    const bounded = source.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
        bytesWritten += bytes.byteLength;
        if (bytesWritten > MAX_DOWNLOAD_BYTES) throw new Error("browser-download-too-large");
        controller.enqueue(bytes);
      }
    }));
    const sandbox = getSandbox(this.env.Sandbox, computerId, { keepAlive: true, normalizeId: true });
    await sandbox.mkdir("/workspace/downloads", { recursive: true });
    try {
      const result = await sandbox.writeFile(temporaryPath, bounded);
      const reportedBytes = Reflect.get(result, "bytesWritten");
      const actualBytes = typeof reportedBytes === "number" ? reportedBytes : bytesWritten;
      if (!Number.isSafeInteger(actualBytes) || actualBytes < 0 || actualBytes > MAX_DOWNLOAD_BYTES) {
        throw new Error("browser-download-size-invalid");
      }
      await sandbox.renameFile(temporaryPath, workspacePath);
      return { fileName, workspacePath, bytesWritten: actualBytes };
    } catch (error) {
      await sandbox.deleteFile(temporaryPath).catch(() => undefined);
      throw error;
    } finally {
      await download.delete().catch(() => undefined);
    }
  }

  private async observeControls(page: Page): Promise<{
    observationId: string;
    controls: HostedBrowserControl[];
    viewport: HostedBrowserSnapshot["viewport"];
  }> {
    const token = crypto.randomUUID().replace(/-/g, "");
    const observationId = `observation-${token}`;
    const observed = await page.locator(
      "a[href],button,input:not([type=hidden]),textarea,select,[role=button],[role=link],[role=checkbox],[role=radio],[role=tab],[contenteditable=true]"
    ).evaluateAll((nodes, prefix) => {
      const visible = (element: Element) => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 0
          && rect.height > 0
          && rect.bottom > 0
          && rect.right > 0
          && rect.top < window.innerHeight
          && rect.left < window.innerWidth
          && style.visibility !== "hidden"
          && style.display !== "none";
      };
      const clean = (value: string) => value.replace(/\s+/g, " ").trim().slice(0, 160);
      const roleFor = (element: Element) => {
        const explicit = element.getAttribute("role");
        if (explicit) return explicit;
        const tag = element.tagName.toLowerCase();
        if (tag === "a") return "link";
        if (tag === "button") return "button";
        if (tag === "textarea") return "textbox";
        if (tag === "select") return "combobox";
        if (tag === "input") {
          const type = (element.getAttribute("type") || "text").toLowerCase();
          if (type === "checkbox" || type === "radio") return type;
          if (type === "submit" || type === "button") return "button";
          return "textbox";
        }
        return "control";
      };
      const nameFor = (element: Element) => {
        const labelledBy = element.getAttribute("aria-labelledby");
        const labelled = labelledBy
          ? labelledBy.split(/\s+/).map((id) => document.getElementById(id)?.textContent || "").join(" ")
          : "";
        const html = element as HTMLElement;
        const input = element as HTMLInputElement;
        const label = input.labels ? [...input.labels].map((entry) => entry.textContent || "").join(" ") : "";
        return clean(element.getAttribute("aria-label") || labelled || label || input.placeholder || html.innerText || element.getAttribute("title") || element.getAttribute("name") || roleFor(element));
      };
      const safeControl = (element: Element) => {
        if (!visible(element)) return false;
        const input = element as HTMLInputElement;
        const type = (input.type || "").toLowerCase();
        const autocomplete = (input.autocomplete || "").toLowerCase();
        return type !== "password" && !/password|one-time-code|cc-|transaction|webauthn/u.test(autocomplete);
      };
      const controls = nodes.filter(safeControl).slice(0, 39).map((element, index) => {
        const ref = `control-${prefix}-${index + 1}`;
        const role = clean(roleFor(element)).slice(0, 40);
        const name = nameFor(element);
        element.setAttribute("data-fable-control-ref", ref);
        element.setAttribute("data-fable-control-role", role);
        element.setAttribute("data-fable-control-name", name);
        const options = element instanceof HTMLSelectElement
          ? [...new Set([...element.options]
            .filter((option) => !option.disabled)
            .map((option) => clean(option.label || option.textContent || option.value))
            .filter(Boolean))].slice(0, 20)
          : [];
        return { ref, role, name, ...(options.length ? { options } : {}) };
      });
      const documentElement = document.documentElement;
      const rawScrollX = Math.max(0, Math.round(window.scrollX));
      const rawScrollY = Math.max(0, Math.round(window.scrollY));
      const width = Math.max(1, Math.min(4_096, Math.round(window.innerWidth)));
      const height = Math.max(1, Math.min(4_096, Math.round(window.innerHeight)));
      const documentWidth = Math.max(width, Math.min(10_000_000, Math.round(documentElement.scrollWidth)));
      const documentHeight = Math.max(height, Math.min(10_000_000, Math.round(documentElement.scrollHeight)));
      const scrollX = Math.min(rawScrollX, documentWidth);
      const scrollY = Math.min(rawScrollY, documentHeight);
      return {
        controls,
        viewport: {
          scrollX,
          scrollY,
          width,
          height,
          documentWidth,
          documentHeight,
          canScrollUp: scrollY > 0,
          canScrollDown: scrollY + height < documentHeight - 1
        }
      };
    }, token);
    const controls: HostedBrowserControl[] = [
      { ref: `control-${token}-0`, role: "document", name: "Page" },
      ...observed.controls
    ];
    return { observationId, controls, viewport: observed.viewport };
  }

  private async liveViewUrl(page: Page): Promise<string> {
    const session = await page.context().newCDPSession(page);
    try {
      const result: unknown = await Reflect.apply(Reflect.get(session, "send"), session, [
        "Cloudflare.getLiveView",
        { mode: "tab", expiresInMs: 5 * 60_000 }
      ]);
      if (!isRecord(result) || typeof result.devtoolsFrontendUrl !== "string") {
        throw new Error("browser-live-view-unavailable");
      }
      const url = new URL(result.devtoolsFrontendUrl);
      if (url.protocol !== "https:" || url.hostname !== "live.browser.run" || !url.searchParams.has("wss")) {
        throw new Error("browser-live-view-invalid");
      }
      return url.toString();
    } finally {
      await session.detach();
    }
  }

  private migrate(): void {
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS browser_state (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        computer_id TEXT NOT NULL,
        generation INTEGER NOT NULL,
        session_id TEXT,
        current_url TEXT,
        title TEXT,
        last_request_key TEXT,
        last_action_request_key TEXT,
        observation_id TEXT,
        history_json TEXT NOT NULL DEFAULT '[]',
        history_index INTEGER NOT NULL DEFAULT -1,
        last_download_json TEXT,
        updated_at TEXT NOT NULL
      );
    `);
    const columns = new Set(
      this.ctx.storage.sql.exec<{ name: string }>("PRAGMA table_info(browser_state)")
        .toArray()
        .map((column) => column.name)
    );
    if (!columns.has("last_action_request_key")) {
      this.ctx.storage.sql.exec("ALTER TABLE browser_state ADD COLUMN last_action_request_key TEXT");
    }
    if (!columns.has("observation_id")) {
      this.ctx.storage.sql.exec("ALTER TABLE browser_state ADD COLUMN observation_id TEXT");
    }
    if (!columns.has("history_json")) {
      this.ctx.storage.sql.exec("ALTER TABLE browser_state ADD COLUMN history_json TEXT NOT NULL DEFAULT '[]'");
    }
    if (!columns.has("history_index")) {
      this.ctx.storage.sql.exec("ALTER TABLE browser_state ADD COLUMN history_index INTEGER NOT NULL DEFAULT -1");
    }
    if (!columns.has("last_download_json")) {
      this.ctx.storage.sql.exec("ALTER TABLE browser_state ADD COLUMN last_download_json TEXT");
    }
  }

  private readState(): BrowserRow | null {
    return this.ctx.storage.sql.exec<BrowserRow>("SELECT * FROM browser_state WHERE singleton = 1").toArray()[0] ?? null;
  }

  private history(stored: BrowserRow | null, currentUrl: string): BrowserHistoryState {
    let history: BrowserHistoryState = { entries: [], index: -1 };
    if (stored) {
      try {
        const parsed: unknown = JSON.parse(stored.history_json);
        if (
          Array.isArray(parsed)
          && parsed.length <= MAX_BROWSER_HISTORY
          && parsed.every((entry) => typeof entry === "string" && validatePublicHttpsUrl(entry) === entry)
          && Number.isInteger(stored.history_index)
          && stored.history_index >= -1
          && stored.history_index < parsed.length
        ) {
          history = { entries: [...parsed] as string[], index: stored.history_index };
        }
      } catch {
        // Corrupt history grants no navigation authority; the current public page becomes the new root.
      }
    }
    return appendBrowserHistory(history, validatePublicHttpsUrl(currentUrl));
  }

  private lastDownload(stored: BrowserRow | null): HostedBrowserDownloadSnapshot | null {
    if (!stored?.last_download_json) return null;
    try {
      const value: unknown = JSON.parse(stored.last_download_json);
      if (!isRecord(value)
        || typeof value.fileName !== "string" || safeDownloadFileName(value.fileName) !== value.fileName
        || typeof value.workspacePath !== "string" || !value.workspacePath.startsWith("/workspace/downloads/")
        || typeof value.bytesWritten !== "number" || !Number.isSafeInteger(value.bytesWritten)
        || value.bytesWritten < 0 || value.bytesWritten > MAX_DOWNLOAD_BYTES) return null;
      return { fileName: value.fileName, workspacePath: value.workspacePath, bytesWritten: value.bytesWritten };
    } catch {
      return null;
    }
  }

  private writeState(value: {
    computerId: string;
    generation: number;
    sessionId: string;
    currentUrl: string;
    title: string;
    lastRequestKey: string | null;
    lastActionRequestKey: string | null;
    observationId: string;
    history: BrowserHistoryState;
    lastDownload: HostedBrowserDownloadSnapshot | null;
    updatedAt: string;
  }): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO browser_state (singleton, computer_id, generation, session_id, current_url, title, last_request_key, last_action_request_key, observation_id, history_json, history_index, last_download_json, updated_at)
       VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(singleton) DO UPDATE SET computer_id = excluded.computer_id, generation = excluded.generation,
         session_id = excluded.session_id, current_url = excluded.current_url, title = excluded.title,
         last_request_key = excluded.last_request_key, last_action_request_key = excluded.last_action_request_key,
         observation_id = excluded.observation_id, history_json = excluded.history_json,
         history_index = excluded.history_index, last_download_json = excluded.last_download_json,
         updated_at = excluded.updated_at`,
      value.computerId,
      value.generation,
      value.sessionId,
      value.currentUrl,
      value.title,
      value.lastRequestKey,
      value.lastActionRequestKey,
      value.observationId,
      JSON.stringify(value.history.entries),
      value.history.index,
      value.lastDownload ? JSON.stringify(value.lastDownload) : null,
      value.updatedAt
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
