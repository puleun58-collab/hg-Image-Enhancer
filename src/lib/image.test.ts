import { describe, expect, it } from "vitest";

import {
  ORIGINAL_SIZE_GUARDRAIL_MEGAPIXELS,
  OVERSIZE_MEGAPIXEL_THRESHOLD,
  chooseOutputSizing,
  choosePreviewSizing,
  clampStrength,
  computeMegapixels,
  estimateRgbaBytes,
  getOversizeDecision,
} from "./image";

describe("image helpers", () => {
  it("clamps enhancement strength", () => {
    expect(clampStrength(Number.NaN)).toBe(0);
    expect(clampStrength(-1)).toBe(0);
    expect(clampStrength(0.6)).toBe(0.6);
    expect(clampStrength(3)).toBe(1);
  });

  it("offers original-size processing only within current guardrails", () => {
    const withinGuardrail = {
      width: 5000,
      height: 3600,
      megapixels: computeMegapixels(5000, 3600),
      estimatedRgbaBytes: estimateRgbaBytes(5000, 3600),
    };
    const beyondGuardrail = {
      width: 8000,
      height: 5000,
      megapixels: computeMegapixels(8000, 5000),
      estimatedRgbaBytes: estimateRgbaBytes(8000, 5000),
    };

    const withinDecision = getOversizeDecision(withinGuardrail);
    const beyondDecision = getOversizeDecision(beyondGuardrail);

    expect(withinGuardrail.megapixels).toBeGreaterThan(OVERSIZE_MEGAPIXEL_THRESHOLD);
    expect(withinGuardrail.megapixels).toBeLessThanOrEqual(ORIGINAL_SIZE_GUARDRAIL_MEGAPIXELS);
    expect(withinDecision.allowOriginal).toBe(true);
    expect(beyondDecision.allowOriginal).toBe(false);
  });

  it("downscales oversized exports to the 16MP target", () => {
    const sizing = chooseOutputSizing(8000, 5000, false);

    expect(sizing.strategy).toBe("downscaled");
    expect(computeMegapixels(sizing.width, sizing.height)).toBeLessThanOrEqual(OVERSIZE_MEGAPIXEL_THRESHOLD + 0.01);
  });

  it("limits previews to the configured max edge", () => {
    const preview = choosePreviewSizing(8000, 5000);

    expect(Math.max(preview.width, preview.height)).toBeLessThanOrEqual(1600);
    expect(preview.scale).toBeLessThan(1);
  });
});