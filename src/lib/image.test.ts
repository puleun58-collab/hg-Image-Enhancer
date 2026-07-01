import { describe, expect, it } from "vitest";

import {
  OUTPUT_MAX_MEGAPIXELS,
  chooseOutputSizing,
  choosePreviewSizing,
  clampStrength,
  computeMegapixels,
  getOversizeDecision,
} from "./image";

describe("image helpers", () => {
  it("clamps enhancement strength", () => {
    expect(clampStrength(Number.NaN)).toBe(0);
    expect(clampStrength(-1)).toBe(0);
    expect(clampStrength(0.6)).toBe(0.6);
    expect(clampStrength(3)).toBe(1);
  });

  it("describes the 24MP processing limit", () => {
    const decision = getOversizeDecision({
      width: 7000,
      height: 4000,
      megapixels: computeMegapixels(7000, 4000),
      estimatedRgbaBytes: 7000 * 4000 * 4,
    });

    expect(decision.message).toContain(`${OUTPUT_MAX_MEGAPIXELS.toFixed(1)}MP`);
    expect(decision.message).toContain("Original");
    expect(decision.message).toContain("2x");
  });

  it("keeps original output within the 24MP cap", () => {
    const sizing = chooseOutputSizing(8000, 5000, "original");

    expect(sizing.strategy).toBe("original-clamped");
    expect(computeMegapixels(sizing.width, sizing.height)).toBeLessThanOrEqual(OUTPUT_MAX_MEGAPIXELS + 0.01);
    expect(sizing.scale).toBeLessThan(1);
  });

  it("upscales to 2x and clamps to the 24MP cap when needed", () => {
    const withinCap = chooseOutputSizing(2000, 1500, "2x");
    const clamped = chooseOutputSizing(4032, 3024, "2x");

    expect(withinCap.strategy).toBe("2x");
    expect(withinCap.width).toBe(4000);
    expect(withinCap.height).toBe(3000);

    expect(clamped.strategy).toBe("2x-clamped");
    expect(computeMegapixels(clamped.width, clamped.height)).toBeLessThanOrEqual(OUTPUT_MAX_MEGAPIXELS + 0.01);
    expect(clamped.scale).toBeGreaterThan(1);
    expect(clamped.scale).toBeLessThan(2);
  });

  it("limits previews to the configured max edge", () => {
    const preview = choosePreviewSizing(8000, 5000);

    expect(Math.max(preview.width, preview.height)).toBeLessThanOrEqual(1600);
    expect(preview.scale).toBeLessThan(1);
  });
});