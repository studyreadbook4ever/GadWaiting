export type LocalAdMode = "checking" | "provider" | "fallback";
export type LocalAdHealth = "checking" | "healthy" | "unhealthy";

export interface AdSize {
  width: number;
  height: number;
}

export interface HouseAdAsset {
  src: string;
  width: number;
  height: number;
  media?: string;
  density?: number;
}

export interface HouseAdConfig {
  assets: HouseAdAsset[];
  alt: string;
  href?: string;
  target?: "_self" | "_blank" | "_parent" | "_top";
  label?: string;
}

export interface AdProviderConfig {
  client: string;
  slot: string;
  format?: string;
  fullWidthResponsive?: boolean;
  scriptUrl?: string;
  testMode?: "on" | "off" | boolean;
}

export interface AdSlotConfig {
  id: string;
  mount: string | HTMLElement;
  size: AdSize;
  provider: AdProviderConfig;
  fallback: HouseAdConfig;
  unfilledFallbackDelayMs?: number;
}

export interface HealthCheckConfig {
  endpoint?: string;
  intervalMs?: number;
  timeoutMs?: number;
  consecutiveFailures?: number;
  consecutiveSuccesses?: number;
  startHealthy?: boolean;
}

export interface RenderConfig {
  reserveSpace?: boolean;
  className?: string;
}

export interface GadWaitingConfig {
  slots: AdSlotConfig[];
  check?: HealthCheckConfig;
  render?: RenderConfig;
}

export interface HealthSnapshot {
  health: LocalAdHealth;
  ok: boolean;
  reason: string;
  checkedAt: number;
  changed: boolean;
}

export interface GadWaitingController {
  start(): void;
  stop(): void;
  destroy(): void;
  renderFallback(reason?: string): void;
  renderProvider(force?: boolean): void;
  getHealth(): HealthSnapshot;
}

declare global {
  interface Window {
    adsbygoogle?: unknown[];
    GadWaiting?: {
      mount(config: GadWaitingConfig): GadWaitingController;
    };
  }
}

const DEFAULT_AD_SCRIPT_URL = "https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js";
const STYLE_ID = "gadwaiting-style";
const SLOT_ATTR = "data-gadwaiting-slot";
const DEFAULT_CHECK_INTERVAL_MS = 60_000;
const DEFAULT_TIMEOUT_MS = 2_500;
const scriptPromises = new Map<string, Promise<void>>();

class BrowserHealthMonitor {
  private config: Required<HealthCheckConfig>;
  private endpoint: string;
  private listeners = new Set<(snapshot: HealthSnapshot) => void>();
  private timer: number | undefined;
  private inFlight = false;
  private failures = 0;
  private successes = 0;
  private snapshot: HealthSnapshot;

  constructor(config: HealthCheckConfig | undefined, endpoint: string) {
    this.config = {
      endpoint: config?.endpoint ?? endpoint,
      intervalMs: config?.intervalMs ?? DEFAULT_CHECK_INTERVAL_MS,
      timeoutMs: config?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      consecutiveFailures: Math.max(1, config?.consecutiveFailures ?? 1),
      consecutiveSuccesses: Math.max(1, config?.consecutiveSuccesses ?? 1),
      startHealthy: config?.startHealthy ?? false
    };
    this.endpoint = this.config.endpoint;
    this.snapshot = {
      health: this.config.startHealthy ? "healthy" : "checking",
      ok: this.config.startHealthy,
      reason: this.config.startHealthy ? "optimistic-start" : "initial-check-pending",
      checkedAt: 0,
      changed: true
    };
  }

  start(): void {
    if (this.timer !== undefined) {
      return;
    }

    void this.checkNow();
    this.timer = window.setInterval(() => void this.checkNow(), this.config.intervalMs);
  }

  stop(): void {
    if (this.timer !== undefined) {
      window.clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  getSnapshot(): HealthSnapshot {
    return { ...this.snapshot, changed: false };
  }

  subscribe(listener: (snapshot: HealthSnapshot) => void): () => void {
    this.listeners.add(listener);
    listener(this.snapshot);
    return () => this.listeners.delete(listener);
  }

  private async checkNow(): Promise<void> {
    if (this.inFlight) {
      return;
    }

    this.inFlight = true;
    const result = await probeEndpoint(this.endpoint, this.config.timeoutMs);
    this.inFlight = false;

    if (result.ok) {
      this.successes += 1;
      this.failures = 0;
    } else {
      this.failures += 1;
      this.successes = 0;
    }

    const previous = this.snapshot.health;
    let next = previous;

    if (this.successes >= this.config.consecutiveSuccesses) {
      next = "healthy";
    }

    if (this.failures >= this.config.consecutiveFailures) {
      next = "unhealthy";
    }

    this.snapshot = {
      health: next,
      ok: next === "healthy",
      reason: result.reason,
      checkedAt: Date.now(),
      changed: previous !== next
    };

    this.emit(this.snapshot);
  }

  private emit(snapshot: HealthSnapshot): void {
    for (const listener of this.listeners) {
      listener(snapshot);
    }
  }
}

class SlotRenderer {
  private lastMode: LocalAdMode | undefined;
  private fallbackReason = "not-rendered";
  private observer: MutationObserver | undefined;
  private unfilledTimer: number | undefined;
  private slot: AdSlotConfig;
  private renderConfig: RenderConfig | undefined;

  constructor(slot: AdSlotConfig, renderConfig: RenderConfig | undefined) {
    this.slot = slot;
    this.renderConfig = renderConfig;
  }

  renderFallback(reason = "provider-unavailable"): void {
    this.cleanupPendingWatchers();

    if (this.lastMode === "fallback" && this.fallbackReason === reason) {
      return;
    }

    const mount = this.resolveMount();
    if (!mount) {
      return;
    }

    this.lastMode = "fallback";
    this.fallbackReason = reason;
    const frame = this.createOuterFrame("fallback");
    frame.replaceChildren(this.createHouseAd(false));
    mount.replaceChildren(frame);
  }

  async renderProvider(force = false): Promise<void> {
    if (this.lastMode === "provider" && !force) {
      return;
    }

    const mount = this.resolveMount();
    if (!mount) {
      return;
    }

    this.cleanupPendingWatchers();
    this.lastMode = "provider";
    this.fallbackReason = "not-fallback";

    const frame = this.createOuterFrame("provider");
    const ins = this.createProviderElement();
    frame.replaceChildren(ins);
    mount.replaceChildren(frame);

    this.watchAdStatus(ins);

    try {
      await ensureAdScript(this.getScriptUrl());
      const queue = (window.adsbygoogle = window.adsbygoogle || []);
      queue.push({});
    } catch (error) {
      this.renderFallback(error instanceof Error ? error.message : "provider-script-load-failed");
    }
  }

  destroy(): void {
    this.cleanupPendingWatchers();
    const mount = this.resolveMount();
    if (mount) {
      mount.querySelector(`[${SLOT_ATTR}="${cssEscape(this.slot.id)}"]`)?.remove();
    }
  }

  private resolveMount(): HTMLElement | null {
    if (typeof this.slot.mount === "string") {
      const found = document.querySelector<HTMLElement>(this.slot.mount);
      if (!found) {
        console.warn(`[gadwaiting] mount not found: ${this.slot.mount}`);
      }
      return found;
    }

    return this.slot.mount;
  }

  private createOuterFrame(mode: LocalAdMode): HTMLDivElement {
    const frame = document.createElement("div");
    frame.className = ["gw-slot", this.renderConfig?.className ?? ""].filter(Boolean).join(" ");
    frame.setAttribute(SLOT_ATTR, this.slot.id);
    frame.dataset.adMode = mode;
    frame.dataset.adSize = `${this.slot.size.width}x${this.slot.size.height}`;

    if (this.renderConfig?.reserveSpace !== false) {
      frame.style.width = `${this.slot.size.width}px`;
      frame.style.height = `${this.slot.size.height}px`;
      frame.style.maxWidth = "100%";
      frame.style.aspectRatio = `${this.slot.size.width} / ${this.slot.size.height}`;
    }

    return frame;
  }

  private createProviderElement(): HTMLElement {
    const provider = getSlotProvider(this.slot);
    const ins = document.createElement("ins");
    ins.className = "adsbygoogle gw-provider";
    ins.style.display = "inline-block";
    ins.style.width = `${this.slot.size.width}px`;
    ins.style.height = `${this.slot.size.height}px`;
    ins.style.maxWidth = "100%";
    ins.dataset.adClient = provider.client;
    ins.dataset.adSlot = provider.slot;

    if (provider.format) {
      ins.dataset.adFormat = provider.format;
    }

    if (provider.fullWidthResponsive !== undefined) {
      ins.dataset.fullWidthResponsive = String(provider.fullWidthResponsive);
    }

    if (provider.testMode !== undefined) {
      ins.dataset.adtest = provider.testMode === true ? "on" : String(provider.testMode);
    }

    ins.appendChild(this.createHouseAd(true));
    return ins;
  }

  private createHouseAd(insideProvider: boolean): HTMLElement {
    const fallback = this.slot.fallback;
    const asset = pickAsset(fallback.assets, this.slot.size);
    const linkOrSpan = fallback.href ? document.createElement("a") : document.createElement("span");
    linkOrSpan.className = insideProvider ? "gw-house-ad gw-house-ad--inside-provider" : "gw-house-ad";

    if (fallback.href) {
      const anchor = linkOrSpan as HTMLAnchorElement;
      anchor.href = fallback.href;
      anchor.target = fallback.target ?? "_self";
      anchor.rel = anchor.target === "_blank" ? "sponsored noopener noreferrer" : "sponsored";
    }

    const picture = document.createElement("picture");
    const mediaAssets = fallback.assets.filter((item) => item.media);
    for (const mediaAsset of mediaAssets) {
      const source = document.createElement("source");
      source.media = mediaAsset.media ?? "";
      source.srcset = mediaAsset.src;
      picture.appendChild(source);
    }

    const img = document.createElement("img");
    img.className = "gw-house-ad__image";
    img.src = asset.src;
    img.alt = fallback.alt;
    img.width = asset.width;
    img.height = asset.height;
    img.loading = "lazy";
    img.decoding = "async";
    img.sizes = `${this.slot.size.width}px`;
    img.srcset = createSrcSet(fallback.assets);
    picture.appendChild(img);

    linkOrSpan.appendChild(picture);

    if (fallback.label) {
      const label = document.createElement("span");
      label.className = "gw-house-ad__label";
      label.textContent = fallback.label;
      linkOrSpan.appendChild(label);
    }

    return linkOrSpan;
  }

  private watchAdStatus(ins: HTMLElement): void {
    const applyStatus = (): void => {
      const status = ins.getAttribute("data-ad-status");
      if (status === "filled") {
        this.cleanupUnfilledTimer();
        return;
      }

      if (status === "unfilled" || status === "unfill-optimized") {
        this.cleanupUnfilledTimer();
        this.unfilledTimer = window.setTimeout(() => {
          this.renderFallback(`provider-${status}`);
        }, this.slot.unfilledFallbackDelayMs ?? 600);
      }
    };

    this.observer = new MutationObserver(applyStatus);
    this.observer.observe(ins, {
      attributes: true,
      attributeFilter: ["data-ad-status"]
    });
    applyStatus();
  }

  private getScriptUrl(): string {
    const provider = getSlotProvider(this.slot);
    return buildAdScriptUrl(provider.scriptUrl, provider.client);
  }

  private cleanupPendingWatchers(): void {
    this.observer?.disconnect();
    this.observer = undefined;
    this.cleanupUnfilledTimer();
  }

  private cleanupUnfilledTimer(): void {
    if (this.unfilledTimer !== undefined) {
      window.clearTimeout(this.unfilledTimer);
      this.unfilledTimer = undefined;
    }
  }
}

class GadWaitingRuntime implements GadWaitingController {
  private monitor: BrowserHealthMonitor;
  private renderers: SlotRenderer[];
  private unsubscribe: (() => void) | undefined;
  private config: GadWaitingConfig;

  constructor(config: GadWaitingConfig) {
    this.config = config;
    assertConfig(config);
    const endpoint = buildHealthEndpoint(config);
    this.monitor = new BrowserHealthMonitor(config.check, endpoint);
    this.renderers = config.slots.map((slot) => new SlotRenderer(slot, config.render));
  }

  start(): void {
    installStyles();
    this.unsubscribe = this.monitor.subscribe((snapshot) => {
      if (snapshot.health === "healthy") {
        this.renderProvider(!snapshot.changed);
      } else {
        this.renderFallback(snapshot.reason);
      }
    });
    this.monitor.start();
  }

  stop(): void {
    this.monitor.stop();
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  destroy(): void {
    this.stop();
    for (const renderer of this.renderers) {
      renderer.destroy();
    }
  }

  renderFallback(reason = "manual-fallback"): void {
    for (const renderer of this.renderers) {
      renderer.renderFallback(reason);
    }
  }

  renderProvider(force = false): void {
    for (const renderer of this.renderers) {
      void renderer.renderProvider(force);
    }
  }

  getHealth(): HealthSnapshot {
    return this.monitor.getSnapshot();
  }
}

export function mountGadWaiting(config: GadWaitingConfig): GadWaitingController {
  const controller = new GadWaitingRuntime(config);
  controller.start();
  return controller;
}

export function buildAdScriptUrl(scriptUrl: string | undefined, client: string): string {
  const base = scriptUrl ?? DEFAULT_AD_SCRIPT_URL;
  const url = new URL(base, document.baseURI);

  if (client && !url.searchParams.has("client")) {
    url.searchParams.set("client", client);
  }

  return url.toString();
}

function buildHealthEndpoint(config: GadWaitingConfig): string {
  if (config.check?.endpoint) {
    return config.check.endpoint;
  }

  const firstSlot = config.slots[0];
  const provider = getSlotProvider(firstSlot);
  return buildAdScriptUrl(provider.scriptUrl, provider.client);
}

async function ensureAdScript(src: string): Promise<void> {
  if (window.adsbygoogle && document.querySelector(`script[data-gw-ad-script="${cssEscape(src)}"]`)) {
    return;
  }

  const existing = scriptPromises.get(src);
  if (existing) {
    return existing;
  }

  const promise = new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    script.async = true;
    script.crossOrigin = "anonymous";
    script.src = src;
    script.dataset.gwAdScript = src;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("provider-script-load-failed"));
    document.head.appendChild(script);
  });

  scriptPromises.set(src, promise);
  return promise;
}

async function probeEndpoint(endpoint: string, timeoutMs: number): Promise<{ ok: boolean; reason: string }> {
  const fetchResult = await probeByFetch(endpoint, timeoutMs);
  if (fetchResult.ok || fetchResult.reason !== "fetch-blocked") {
    return fetchResult;
  }

  return probeByScript(endpoint, timeoutMs);
}

async function probeByFetch(endpoint: string, timeoutMs: number): Promise<{ ok: boolean; reason: string }> {
  if (!("fetch" in window) || !("AbortController" in window)) {
    return { ok: false, reason: "fetch-blocked" };
  }

  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(cacheBust(endpoint), {
      cache: "no-store",
      credentials: "omit",
      mode: "cors",
      signal: controller.signal
    });
    return {
      ok: response.ok,
      reason: response.ok ? `http-${response.status}` : `http-${response.status}`
    };
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      return { ok: false, reason: "timeout" };
    }

    return { ok: false, reason: "fetch-blocked" };
  } finally {
    window.clearTimeout(timer);
  }
}

function probeByScript(endpoint: string, timeoutMs: number): Promise<{ ok: boolean; reason: string }> {
  return new Promise((resolve) => {
    const script = document.createElement("script");
    let settled = false;
    const finish = (ok: boolean, reason: string): void => {
      if (settled) {
        return;
      }
      settled = true;
      window.clearTimeout(timer);
      script.remove();
      resolve({ ok, reason });
    };
    const timer = window.setTimeout(() => finish(false, "timeout"), timeoutMs);

    script.async = true;
    script.crossOrigin = "anonymous";
    script.dataset.lasProbe = "true";
    script.src = cacheBust(endpoint);
    script.onload = () => finish(true, "script-load-ok");
    script.onerror = () => finish(false, "script-load-error");
    document.head.appendChild(script);
  });
}

function cacheBust(url: string): string {
  const parsed = new URL(url, document.baseURI);
  parsed.searchParams.set("_las_probe", String(Date.now()));
  return parsed.toString();
}

function pickAsset(assets: HouseAdAsset[], size: AdSize): HouseAdAsset {
  return assets
    .slice()
    .sort((a, b) => assetScore(a, size) - assetScore(b, size))[0];
}

function assetScore(asset: HouseAdAsset, size: AdSize): number {
  const widthDelta = Math.abs(asset.width - size.width);
  const heightDelta = Math.abs(asset.height - size.height);
  const ratioDelta = Math.abs(asset.width / asset.height - size.width / size.height) * 100;
  return widthDelta + heightDelta + ratioDelta;
}

function createSrcSet(assets: HouseAdAsset[]): string {
  return assets
    .map((asset) => {
      if (asset.density) {
        return `${asset.src} ${asset.density}x`;
      }
      return `${asset.src} ${asset.width}w`;
    })
    .join(", ");
}

function installStyles(): void {
  if (document.getElementById(STYLE_ID)) {
    return;
  }

  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
.gw-slot {
  position: relative;
  display: inline-block;
  overflow: hidden;
  vertical-align: middle;
  background: #f8fafc;
  color: #0f172a;
  contain: layout paint style;
}
.gw-slot iframe,
.gw-slot ins,
.gw-slot picture,
.gw-slot img {
  max-width: 100%;
}
.gw-provider {
  background: transparent;
}
.gw-house-ad {
  position: relative;
  display: flex;
  width: 100%;
  height: 100%;
  align-items: stretch;
  justify-content: stretch;
  overflow: hidden;
  color: inherit;
  text-decoration: none;
}
.gw-house-ad picture {
  display: flex;
  width: 100%;
  height: 100%;
}
.gw-house-ad__image {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.gw-house-ad__label {
  position: absolute;
  top: 4px;
  right: 4px;
  max-width: calc(100% - 8px);
  padding: 2px 5px;
  border-radius: 4px;
  background: rgba(15, 23, 42, 0.72);
  color: #fff;
  font: 500 10px/1.2 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  white-space: nowrap;
}
ins.adsbygoogle .gw-house-ad--inside-provider {
  display: none !important;
}
ins.adsbygoogle[data-ad-status="unfilled"] .gw-house-ad--inside-provider,
ins.adsbygoogle[data-ad-status="unfill-optimized"] .gw-house-ad--inside-provider {
  display: flex !important;
}
`;
  document.head.appendChild(style);
}

function assertConfig(config: GadWaitingConfig): void {
  if (!config.slots.length) {
    throw new Error("gadwaiting requires at least one slot");
  }

  for (const slot of config.slots) {
    if (!slot.id) {
      throw new Error("slot.id is required");
    }
    if (!slot.provider.client || !slot.provider.slot) {
      throw new Error(`slot ${slot.id} requires provider.client and provider.slot`);
    }
    if (!slot.fallback.assets.length) {
      throw new Error(`slot ${slot.id} requires at least one fallback asset`);
    }
  }
}

function getSlotProvider(slot: AdSlotConfig): AdProviderConfig {
  return slot.provider;
}

function cssEscape(value: string): string {
  if ("CSS" in window && typeof CSS.escape === "function") {
    return CSS.escape(value);
  }

  return value.replace(/["\\]/g, "\\$&");
}

if (typeof window !== "undefined") {
  window.GadWaiting = {
    mount: mountGadWaiting
  };
}
