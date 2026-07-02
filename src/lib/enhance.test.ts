import { beforeAll, describe, expect, it } from "vitest";

import { enhanceImageData, refineUpscaledImageData } from "./enhance";

class TestImageData {
  data: Uint8ClampedArray;
  width: number;
  height: number;

  constructor(data: Uint8ClampedArray, width: number, height: number) {
    this.data = data;
    this.width = width;
    this.height = height;
  }
}

beforeAll(() => {
  Object.assign(globalThis, { ImageData: TestImageData });
});

function createImageData(width: number, height: number, fill: (x: number, y: number) => [number, number, number, number]) {
  const data = new Uint8ClampedArray(width * height * 4);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 4;
      const [r, g, b, a] = fill(x, y);
      data[index] = r;
      data[index + 1] = g;
      data[index + 2] = b;
      data[index + 3] = a;
    }
  }

  return new TestImageData(data, width, height) as unknown as ImageData;
}

describe("enhanceImageData", () => {
  it("reduces isolated noise while preserving image dimensions and alpha", () => {
    const source = createImageData(3, 3, (x, y) => {
      const noisy = x === 1 && y === 1;
      return noisy ? [155, 155, 155, 255] : [100, 100, 100, 255];
    });

    const result = enhanceImageData(source, 0.8);
    const center = (1 * 3 + 1) * 4;

    expect(result.width).toBe(3);
    expect(result.height).toBe(3);
    expect(result.data[center]).toBeLessThan(source.data[center]);
    expect(result.data[center + 3]).toBe(255);
  });

  it("keeps a bright edge feature visibly distinct", () => {
    const source = createImageData(5, 5, (x, y) => {
      if (x === 2) {
        return [235, 235, 235, 255];
      }
      if (y === 2) {
        return [220, 220, 220, 255];
      }
      return [24, 24, 24, 255];
    });

    const result = enhanceImageData(source, 0.75);
    const center = (2 * 5 + 2) * 4;
    const corner = 0;

    expect(result.data[center]).toBeGreaterThan(180);
    expect(result.data[center] - result.data[corner]).toBeGreaterThan(120);
  });
});

describe("refineUpscaledImageData", () => {
  it("boosts edge contrast for upscaled imagery without changing dimensions", () => {
    const source = createImageData(5, 5, (x) => {
      if (x <= 1) {
        return [88, 88, 88, 255];
      }
      if (x === 2) {
        return [124, 124, 124, 255];
      }
      return [164, 164, 164, 255];
    });

    const result = refineUpscaledImageData(source, 0.9);
    const left = (2 * 5 + 1) * 4;
    const edge = (2 * 5 + 2) * 4;
    const right = (2 * 5 + 3) * 4;
    const beforeContrast = source.data[right] - source.data[left];
    const afterContrast = result.data[right] - result.data[left];

    expect(result.width).toBe(5);
    expect(result.height).toBe(5);
    expect(afterContrast).toBeGreaterThan(beforeContrast);
    expect(result.data[right]).toBeGreaterThan(source.data[right]);
    expect(result.data[edge + 3]).toBe(255);
  });
});