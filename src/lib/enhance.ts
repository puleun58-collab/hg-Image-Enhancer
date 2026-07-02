import type { ProcessRequest, ProcessResponse } from "../types";
import { captureDebugPreviewPng, imageDataToRenderResult } from "./export";
import {
  chooseOutputSizing,
  choosePreviewSizing,
  clampStrength,
  loadBitmapFromSource,
} from "./image";
import { runFourXSuperResolution } from "./srModel";

interface EnhanceProcessOptions {
  usedWorker: boolean;
}

interface PixelBuffers {
  source: Float32Array;
  denoised: Float32Array;
  atmosphere: Float32Array;
  dehazed: Float32Array;
  sharpenBase: Float32Array;
}

export async function processImageRequest(
  request: ProcessRequest,
  options: Partial<EnhanceProcessOptions> = {},
): Promise<ProcessResponse> {
  const start = performance.now();
  const strength = clampStrength(request.strength);
  const outputSizing = chooseOutputSizing(
    request.source.width,
    request.source.height,
    request.outputMode,
  );
  const previewSizing = choosePreviewSizing(outputSizing.width, outputSizing.height);
  const drawable = await loadBitmapFromSource(request.source);

  try {
    const shouldUpscaleOutput =
      outputSizing.width > request.source.width || outputSizing.height > request.source.height;
    const exportImage = request.outputMode === "4x" && shouldUpscaleOutput
      ? await superResolveEnhancedImageData(
          renderEnhancedVariant(drawable, request.source.width, request.source.height, strength),
          outputSizing.width,
          outputSizing.height,
        )
      : shouldUpscaleOutput
        ? upscaleEnhancedImageData(
            renderEnhancedVariant(drawable, request.source.width, request.source.height, strength),
            outputSizing.width,
            outputSizing.height,
            strength,
          )
        : renderEnhancedVariant(drawable, outputSizing.width, outputSizing.height, strength);
    const previewImage =
      previewSizing.width === outputSizing.width && previewSizing.height === outputSizing.height
        ? cloneImageData(exportImage)
        : resizeImageData(exportImage, previewSizing.width, previewSizing.height);

    const [preview, fullExport, debugPreviewPng] = await Promise.all([
      imageDataToRenderResult(previewImage, request.outputMimeType, request.jpegQuality),
      imageDataToRenderResult(exportImage, request.outputMimeType, request.jpegQuality),
      captureDebugPreviewPng(previewImage),
    ]);

    return {
      preview,
      export: fullExport,
      strategy: outputSizing.strategy,
      width: outputSizing.width,
      height: outputSizing.height,
      previewScale: previewSizing.scale,
      debugPreviewPng,
      timingMs: performance.now() - start,
      usedWorker: options.usedWorker ?? false,
    };
  } finally {
    if (drawable instanceof ImageBitmap) {
      drawable.close();
    }
  }
}

export function renderEnhancedVariant(
  drawable: ImageBitmap | HTMLImageElement,
  width: number,
  height: number,
  strength: number,
): ImageData {
  const source = drawDrawableToImageData(drawable, width, height);
  return enhanceImageData(source, strength);
}

export function enhanceImageData(source: ImageData, strength: number): ImageData {
  const normalizedStrength = clampStrength(strength);
  const buffers = createPixelBuffers(source);
  const denoisePasses = normalizedStrength >= 0.55 ? 2 : 1;

  edgeAwareDenoise(buffers.source, source.width, source.height, buffers.denoised, normalizedStrength);
  for (let pass = 1; pass < denoisePasses; pass += 1) {
    edgeAwareDenoise(buffers.denoised, source.width, source.height, buffers.source, normalizedStrength);
    buffers.denoised.set(buffers.source);
  }

  const hazeRadius = Math.max(2, Math.round(3 + normalizedStrength * 6));
  boxBlurRgb(buffers.denoised, source.width, source.height, hazeRadius, buffers.atmosphere);

  const hazeLift = 0.18 + normalizedStrength * 0.42;
  for (let index = 0; index < buffers.dehazed.length; index += 4) {
    const dr = buffers.denoised[index] - buffers.atmosphere[index];
    const dg = buffers.denoised[index + 1] - buffers.atmosphere[index + 1];
    const db = buffers.denoised[index + 2] - buffers.atmosphere[index + 2];

    buffers.dehazed[index] = clampChannel(buffers.denoised[index] + dr * hazeLift);
    buffers.dehazed[index + 1] = clampChannel(buffers.denoised[index + 1] + dg * hazeLift);
    buffers.dehazed[index + 2] = clampChannel(buffers.denoised[index + 2] + db * hazeLift);
    buffers.dehazed[index + 3] = buffers.denoised[index + 3];
  }

  boxBlurRgb(buffers.dehazed, source.width, source.height, 1, buffers.sharpenBase);

  const sharpenAmount = 0.12 + normalizedStrength * 0.28;
  const saturationAmount = 1 + normalizedStrength * 0.05;
  const output = new Uint8ClampedArray(source.data.length);

  for (let index = 0; index < output.length; index += 4) {
    const sharpenedR = clampChannel(
      buffers.dehazed[index] + (buffers.dehazed[index] - buffers.sharpenBase[index]) * sharpenAmount,
    );
    const sharpenedG = clampChannel(
      buffers.dehazed[index + 1] +
        (buffers.dehazed[index + 1] - buffers.sharpenBase[index + 1]) * sharpenAmount,
    );
    const sharpenedB = clampChannel(
      buffers.dehazed[index + 2] +
        (buffers.dehazed[index + 2] - buffers.sharpenBase[index + 2]) * sharpenAmount,
    );
    const luminance = sharpenedR * 0.2126 + sharpenedG * 0.7152 + sharpenedB * 0.0722;

    output[index] = clampChannel(luminance + (sharpenedR - luminance) * saturationAmount);
    output[index + 1] = clampChannel(luminance + (sharpenedG - luminance) * saturationAmount);
    output[index + 2] = clampChannel(luminance + (sharpenedB - luminance) * saturationAmount);
    output[index + 3] = source.data[index + 3];
  }

  return new ImageData(output, source.width, source.height);
}

export function upscaleEnhancedImageData(
  source: ImageData,
  width: number,
  height: number,
  strength: number,
): ImageData {
  const resized = resizeImageData(source, width, height, "upscale");
  return refineUpscaledImageData(resized, strength);
}

export async function superResolveEnhancedImageData(
  source: ImageData,
  width: number,
  height: number,
): Promise<ImageData> {
  const upscaled = await runFourXSuperResolution(source);
  if (upscaled.width === width && upscaled.height === height) {
    return upscaled;
  }

  return resizeImageData(upscaled, width, height, "preview");
}

export function refineUpscaledImageData(source: ImageData, strength: number): ImageData {
  const normalizedStrength = clampStrength(strength);
  const buffers = createPixelBuffers(source);
  boxBlurRgb(buffers.source, source.width, source.height, 1, buffers.sharpenBase);
  boxBlurRgb(buffers.source, source.width, source.height, 3, buffers.atmosphere);

  const sharpenAmount = 0.2 + normalizedStrength * 0.28;
  const contrastAmount = 0.08 + normalizedStrength * 0.14;
  const saturationAmount = 1 + normalizedStrength * 0.03;
  const output = new Uint8ClampedArray(source.data.length);

  for (let index = 0; index < output.length; index += 4) {
    const refinedR = clampChannel(
      buffers.source[index] +
        (buffers.source[index] - buffers.sharpenBase[index]) * sharpenAmount +
        (buffers.source[index] - buffers.atmosphere[index]) * contrastAmount,
    );
    const refinedG = clampChannel(
      buffers.source[index + 1] +
        (buffers.source[index + 1] - buffers.sharpenBase[index + 1]) * sharpenAmount +
        (buffers.source[index + 1] - buffers.atmosphere[index + 1]) * contrastAmount,
    );
    const refinedB = clampChannel(
      buffers.source[index + 2] +
        (buffers.source[index + 2] - buffers.sharpenBase[index + 2]) * sharpenAmount +
        (buffers.source[index + 2] - buffers.atmosphere[index + 2]) * contrastAmount,
    );
    const luminance = refinedR * 0.2126 + refinedG * 0.7152 + refinedB * 0.0722;

    output[index] = clampChannel(luminance + (refinedR - luminance) * saturationAmount);
    output[index + 1] = clampChannel(luminance + (refinedG - luminance) * saturationAmount);
    output[index + 2] = clampChannel(luminance + (refinedB - luminance) * saturationAmount);
    output[index + 3] = source.data[index + 3];
  }

  return new ImageData(output, source.width, source.height);
}

function createPixelBuffers(source: ImageData): PixelBuffers {
  const length = source.data.length;
  const sourcePixels = new Float32Array(length);
  for (let index = 0; index < length; index += 1) {
    sourcePixels[index] = source.data[index];
  }

  return {
    source: sourcePixels,
    denoised: new Float32Array(length),
    atmosphere: new Float32Array(length),
    dehazed: new Float32Array(length),
    sharpenBase: new Float32Array(length),
  };
}

function edgeAwareDenoise(
  input: Float32Array,
  width: number,
  height: number,
  output: Float32Array,
  strength: number,
): void {
  const edgeFactor = 0.04 + strength * 0.08;
  const spatialWeights = [1, 2, 1, 2, 4, 2, 1, 2, 1];

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 4;
      const centerLuma =
        input[index] * 0.2126 + input[index + 1] * 0.7152 + input[index + 2] * 0.0722;
      let weightSum = 0;
      let r = 0;
      let g = 0;
      let b = 0;
      let weightIndex = 0;

      for (let ky = -1; ky <= 1; ky += 1) {
        const sampleY = clampIndex(y + ky, height);
        for (let kx = -1; kx <= 1; kx += 1) {
          const sampleX = clampIndex(x + kx, width);
          const sampleIndex = (sampleY * width + sampleX) * 4;
          const sampleLuma =
            input[sampleIndex] * 0.2126 +
            input[sampleIndex + 1] * 0.7152 +
            input[sampleIndex + 2] * 0.0722;
          const lumaDelta = Math.abs(sampleLuma - centerLuma);
          const edgeWeight = spatialWeights[weightIndex] / (1 + lumaDelta * edgeFactor);

          weightSum += edgeWeight;
          r += input[sampleIndex] * edgeWeight;
          g += input[sampleIndex + 1] * edgeWeight;
          b += input[sampleIndex + 2] * edgeWeight;
          weightIndex += 1;
        }
      }

      output[index] = r / weightSum;
      output[index + 1] = g / weightSum;
      output[index + 2] = b / weightSum;
      output[index + 3] = input[index + 3];
    }
  }
}

function boxBlurRgb(
  input: Float32Array,
  width: number,
  height: number,
  radius: number,
  output: Float32Array,
): void {
  if (radius <= 0) {
    output.set(input);
    return;
  }

  const horizontal = new Float32Array(input.length);

  for (let y = 0; y < height; y += 1) {
    const rowOffset = y * width;
    for (let x = 0; x < width; x += 1) {
      let sumR = 0;
      let sumG = 0;
      let sumB = 0;
      let count = 0;

      for (let sampleX = x - radius; sampleX <= x + radius; sampleX += 1) {
        const clampedX = clampIndex(sampleX, width);
        const index = (rowOffset + clampedX) * 4;
        sumR += input[index];
        sumG += input[index + 1];
        sumB += input[index + 2];
        count += 1;
      }

      const writeIndex = (rowOffset + x) * 4;
      horizontal[writeIndex] = sumR / count;
      horizontal[writeIndex + 1] = sumG / count;
      horizontal[writeIndex + 2] = sumB / count;
      horizontal[writeIndex + 3] = input[writeIndex + 3];
    }
  }

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let sumR = 0;
      let sumG = 0;
      let sumB = 0;
      let count = 0;

      for (let sampleY = y - radius; sampleY <= y + radius; sampleY += 1) {
        const clampedY = clampIndex(sampleY, height);
        const index = (clampedY * width + x) * 4;
        sumR += horizontal[index];
        sumG += horizontal[index + 1];
        sumB += horizontal[index + 2];
        count += 1;
      }

      const writeIndex = (y * width + x) * 4;
      output[writeIndex] = sumR / count;
      output[writeIndex + 1] = sumG / count;
      output[writeIndex + 2] = sumB / count;
      output[writeIndex + 3] = input[writeIndex + 3];
    }
  }
}

function drawDrawableToImageData(
  drawable: ImageBitmap | HTMLImageElement,
  width: number,
  height: number,
): ImageData {
  if (typeof OffscreenCanvas !== "undefined") {
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext("2d", { willReadFrequently: true });

    if (!context) {
      throw new Error("보정 처리에 필요한 Canvas 2D를 사용할 수 없습니다.");
    }

    context.drawImage(drawable, 0, 0, width, height);
    return context.getImageData(0, 0, width, height);
  }

  if (typeof document !== "undefined") {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d", { willReadFrequently: true });

    if (!context) {
      throw new Error("보정 처리에 필요한 Canvas 2D를 사용할 수 없습니다.");
    }

    context.drawImage(drawable, 0, 0, width, height);
    return context.getImageData(0, 0, width, height);
  }

  throw new Error("보정 처리에 필요한 Canvas 2D를 사용할 수 없습니다.");
}

function resizeImageData(
  imageData: ImageData,
  width: number,
  height: number,
  mode: "preview" | "upscale" = "preview",
): ImageData {
  if (imageData.width === width && imageData.height === height) {
    return cloneImageData(imageData);
  }

  if (typeof OffscreenCanvas !== "undefined") {
    const sourceCanvas = new OffscreenCanvas(imageData.width, imageData.height);
    const sourceContext = sourceCanvas.getContext("2d", { willReadFrequently: true });
    if (!sourceContext) {
      throw new Error("미리보기 축소에 필요한 Canvas 2D를 사용할 수 없습니다.");
    }
    sourceContext.putImageData(imageData, 0, 0);

    const outputCanvas = new OffscreenCanvas(width, height);
    const outputContext = outputCanvas.getContext("2d", { willReadFrequently: true });
    if (!outputContext) {
      throw new Error("미리보기 축소에 필요한 Canvas 2D를 사용할 수 없습니다.");
    }
    configureResizeContext(outputContext, mode);
    outputContext.drawImage(sourceCanvas, 0, 0, width, height);
    return outputContext.getImageData(0, 0, width, height);
  }

  if (typeof document !== "undefined") {
    const sourceCanvas = document.createElement("canvas");
    sourceCanvas.width = imageData.width;
    sourceCanvas.height = imageData.height;
    const sourceContext = sourceCanvas.getContext("2d", { willReadFrequently: true });
    if (!sourceContext) {
      throw new Error("미리보기 축소에 필요한 Canvas 2D를 사용할 수 없습니다.");
    }
    sourceContext.putImageData(imageData, 0, 0);

    const outputCanvas = document.createElement("canvas");
    outputCanvas.width = width;
    outputCanvas.height = height;
    const outputContext = outputCanvas.getContext("2d", { willReadFrequently: true });
    if (!outputContext) {
      throw new Error("미리보기 축소에 필요한 Canvas 2D를 사용할 수 없습니다.");
    }
    configureResizeContext(outputContext, mode);
    outputContext.drawImage(sourceCanvas, 0, 0, width, height);
    return outputContext.getImageData(0, 0, width, height);
  }

  throw new Error("미리보기 축소에 필요한 Canvas 2D를 사용할 수 없습니다.");
}

function cloneImageData(imageData: ImageData): ImageData {
  return new ImageData(new Uint8ClampedArray(imageData.data), imageData.width, imageData.height);
}

function configureResizeContext(
  context: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D,
  mode: "preview" | "upscale",
) {
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = mode === "upscale" ? "high" : "medium";
}

function clampIndex(value: number, limit: number): number {
  return Math.min(limit - 1, Math.max(0, value));
}

function clampChannel(value: number): number {
  return Math.min(255, Math.max(0, value));
}
