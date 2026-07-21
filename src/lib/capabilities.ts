import type { BrowserBucket, CapabilityReport } from "../types";

const DESKTOP_SAFARI_REASON = "데스크톱 Safari는 V1 지원 대상이 아닙니다.";
const MOBILE_BROWSER_REASON = "모바일 브라우저는 현재 데스크톱 우선 지원 범위 밖입니다.";

function getUserAgent(): string {
  return typeof navigator === "undefined" ? "" : navigator.userAgent;
}

function hasCanvas2DContext(runtime: typeof globalThis): boolean {
  if (typeof runtime.OffscreenCanvas !== "undefined") {
    try {
      return runtime.OffscreenCanvas.prototype.getContext.call(
        new runtime.OffscreenCanvas(1, 1),
        "2d",
      ) !== null;
    } catch {
      return false;
    }
  }

  if (typeof runtime.document !== "undefined") {
    const canvas = runtime.document.createElement("canvas");
    return canvas.getContext("2d") !== null;
  }

  return false;
}

export function detectBrowserBucket(userAgent = getUserAgent()): BrowserBucket {
  const ua = userAgent;
  const isAndroid = /Android/i.test(ua);
  const isIOS = /iPhone|iPad|iPod/i.test(ua);
  const isMobile = isAndroid || isIOS || /Mobile/i.test(ua);
  const isDesktopFirefox = /Firefox\//i.test(ua) && !isMobile;
  const isDesktopChromium = /(?:Chrome|Chromium|Edg)\/(\d+)/i.test(ua) && !isMobile && !/OPR/i.test(ua);
  const isMobileSafari = isIOS && /Version\/(\d+)/i.test(ua) && /Safari/i.test(ua) && !/CriOS|FxiOS|EdgiOS|OPiOS/i.test(ua);
  const isAndroidChrome = isAndroid && /Chrome\/(\d+)/i.test(ua) && !/EdgA|OPR/i.test(ua);
  const isDesktopSafari = /Safari/i.test(ua) && !isMobile && !/Chrome|Chromium|Edg|OPR|Firefox/i.test(ua);

  if (isDesktopSafari) {
    return "unsupported";
  }

  if (isDesktopChromium) {
    return "desktop-chromium";
  }

  if (isDesktopFirefox) {
    return "desktop-firefox";
  }

  if (isMobileSafari) {
    return "mobile-safari";
  }

  if (isAndroidChrome) {
    return "mobile-chromium";
  }

  return "unsupported";
}

function extractMajorVersion(bucket: BrowserBucket, userAgent: string): number | null {
  const pick = (pattern: RegExp) => {
    const match = userAgent.match(pattern);
    return match ? Number(match[1]) : null;
  };

  switch (bucket) {
    case "desktop-chromium":
      return pick(/(?:Chrome|Chromium|Edg)\/(\d+)/);
    case "mobile-chromium":
      return pick(/Chrome\/(\d+)/);
    case "desktop-firefox":
      return pick(/Firefox\/(\d+)/);
    case "mobile-safari":
      return pick(/Version\/(\d+)/);
    default:
      return null;
  }
}

function meetsLaunchFloor(bucket: BrowserBucket, userAgent: string): boolean {
  const version = extractMajorVersion(bucket, userAgent);
  if (version === null) {
    return false;
  }

  const minimums: Record<Exclude<BrowserBucket, "unsupported">, number> = {
    "desktop-chromium": 121,
    "desktop-firefox": 122,
    "mobile-safari": 17,
    "mobile-chromium": 121,
  };

  return bucket === "unsupported" ? false : version >= minimums[bucket];
}

export function getCapabilityReport(
  runtime: typeof globalThis = globalThis,
  userAgent = getUserAgent(),
): CapabilityReport {
  const bucket = detectBrowserBucket(userAgent);
  const hasCanvas2D = hasCanvas2DContext(runtime);
  const hasWorker = typeof runtime.Worker !== "undefined";
  const hasCreateImageBitmap = typeof runtime.createImageBitmap === "function";
  const hasOffscreenCanvas = typeof runtime.OffscreenCanvas !== "undefined";
  const hasWebGPU = typeof runtime.navigator !== "undefined" && "gpu" in runtime.navigator;
  const hasWebGL2 = (() => {
    if (typeof runtime.document === "undefined") {
      return false;
    }

    const canvas = runtime.document.createElement("canvas");
    return canvas.getContext("webgl2") !== null;
  })();

  let reason: string | undefined;

  if (bucket === "unsupported") {
    reason = /Safari/i.test(userAgent) && !/Mobile/i.test(userAgent)
      ? DESKTOP_SAFARI_REASON
      : "이 브라우저 계열은 V1 지원 대상이 아닙니다.";
  } else if (bucket === "mobile-safari" || bucket === "mobile-chromium") {
    reason = MOBILE_BROWSER_REASON;
  } else if (!meetsLaunchFloor(bucket, userAgent)) {
    reason = "이 브라우저 버전은 V1 최소 지원 버전보다 낮습니다.";
  } else if (!hasCanvas2D) {
    reason = "Canvas 2D가 필요합니다.";
  } else if (!hasWorker) {
    reason = "Web Worker가 필요합니다.";
  }

  return {
    bucket,
    supported: reason === undefined,
    hasCanvas2D,
    hasWorker,
    hasCreateImageBitmap,
    hasOffscreenCanvas,
    hasWebGL2,
    hasWebGPU,
    reason,
  };
}

export function isSupportedBrowser(
  runtime: typeof globalThis = globalThis,
  userAgent = getUserAgent(),
): boolean {
  return getCapabilityReport(runtime, userAgent).supported;
}

export function getFourXSupport(capabilities: CapabilityReport) {
  if (capabilities.bucket !== "desktop-chromium") {
    return {
      supported: false,
      reason: "4x 업스케일은 현재 데스크톱 Chromium 계열에서만 지원합니다.",
    };
  }

  if (!capabilities.hasCanvas2D || !capabilities.hasWorker || !capabilities.hasOffscreenCanvas) {
    return {
      supported: false,
      reason: "4x 업스케일에는 Canvas 2D, Web Worker, OffscreenCanvas가 필요합니다.",
    };
  }

  return { supported: true, reason: null };
}

export const unsupportedDesktopSafariReason = DESKTOP_SAFARI_REASON;
