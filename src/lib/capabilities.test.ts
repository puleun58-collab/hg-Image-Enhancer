import { describe, expect, it } from "vitest";

import { detectBrowserBucket, getCapabilityReport, unsupportedDesktopSafariReason } from "./capabilities";

describe("capabilities", () => {
  it("maps supported and unsupported browser buckets", () => {
    expect(detectBrowserBucket("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/121.0 Safari/537.36")).toBe("desktop-chromium");
    expect(detectBrowserBucket("Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:122.0) Gecko/20100101 Firefox/122.0")).toBe("desktop-firefox");
    expect(detectBrowserBucket("Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 Chrome/121.0.0.0 Mobile Safari/537.36")).toBe("mobile-chromium");
    expect(detectBrowserBucket("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1")).toBe("mobile-safari");
    expect(detectBrowserBucket("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 CriOS/121.0.0.0 Mobile/15E148 Safari/604.1")).toBe("unsupported");
    expect(detectBrowserBucket("Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15")).toBe("unsupported");
  });

  it("classifies mobile safari but keeps it outside the desktop-first support scope", () => {
    const runtime = {
      Worker: class Worker {},
      createImageBitmap: async () => ({}),
      OffscreenCanvas: class OffscreenCanvas {
        width = 1;
        height = 1;
        getContext(kind: string) {
          return kind === "2d" ? {} : null;
        }
      },
      document: {
        createElement() {
          return {
            getContext(kind: string) {
              if (kind === "2d") {
                return {};
              }
              return null;
            },
          };
        },
      },
    } as unknown as typeof globalThis;

    const report = getCapabilityReport(
      runtime,
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1",
    );

    expect(report.bucket).toBe("mobile-safari");
    expect(report.supported).toBe(false);
    expect(report.reason).toBe("모바일 브라우저는 현재 데스크톱 우선 지원 범위 밖입니다.");
  });

  it("blocks desktop safari explicitly", () => {
    const report = getCapabilityReport(
      { Worker: class Worker {} } as unknown as typeof globalThis,
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15",
    );

    expect(report.supported).toBe(false);
    expect(report.reason).toBe(unsupportedDesktopSafariReason);
  });
});