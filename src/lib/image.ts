import type {
  ImageSource,
  OversizeDecision,
  ProcessedImageSet,
  RenderResult,
} from "../types";

export const OUTPUT_MAX_MEGAPIXELS = 24;
export const OUTPUT_MAX_PIXEL_COUNT = OUTPUT_MAX_MEGAPIXELS * 1_000_000;
export const PREVIEW_MAX_EDGE = 1600;

export interface OutputSizing {
  strategy: "original" | "original-clamped" | "2x" | "2x-clamped";
  width: number;
  height: number;
  scale: number;
}

export interface PreviewSizing {
  width: number;
  height: number;
  scale: number;
}

export function clampDimension(value: number): number {
  return Math.max(1, Math.round(value));
}

export function clampStrength(strength: number): number {
  if (!Number.isFinite(strength)) {
    return 0;
  }

  return Math.min(1, Math.max(0, strength));
}

export function computeMegapixels(width: number, height: number): number {
  return (width * height) / 1_000_000;
}

export function estimateRgbaBytes(width: number, height: number): number {
  return width * height * 4;
}

export function isOversize(width: number, height: number): boolean {
  return width * height > OUTPUT_MAX_PIXEL_COUNT;
}

export function getOversizeDecision(
  source: Pick<ImageSource, "width" | "height" | "megapixels" | "estimatedRgbaBytes">,
): OversizeDecision {
  if (!isOversize(source.width, source.height)) {
    return {
      message: `원본 해상도가 V1의 ${OUTPUT_MAX_MEGAPIXELS}MP 처리 기준 이내입니다. Original 또는 2x 중에서 원하는 출력 크기를 선택하세요.`,
    };
  }

  return {
    message:
      `원본 해상도는 ${source.megapixels.toFixed(1)}MP입니다. Original은 현재 해상도를 유지하되 최대 ${OUTPUT_MAX_MEGAPIXELS.toFixed(1)}MP로 제한하고, 2x는 가로/세로를 2배로 키운 뒤 ${OUTPUT_MAX_MEGAPIXELS.toFixed(1)}MP 이하로 제한합니다.`,
  };
}

export function createObjectUrl(blob: Blob): string {
  return URL.createObjectURL(blob);
}

export function revokeObjectUrl(url: string | undefined): void {
  if (url) {
    URL.revokeObjectURL(url);
  }
}

export function revokeRenderResult(result: RenderResult | undefined): void {
  if (result) {
    revokeObjectUrl(result.objectUrl);
  }
}

export function revokeProcessedImageSet(result: ProcessedImageSet | undefined): void {
  if (!result) {
    return;
  }

  revokeRenderResult(result.preview);
  revokeRenderResult(result.export);
}

export function chooseOutputSizing(
  width: number,
  height: number,
  outputMode: "original" | "2x",
): OutputSizing {
  const targetScale = outputMode === "2x" ? 2 : 1;
  const targetWidth = width * targetScale;
  const targetHeight = height * targetScale;
  const fitted = fitWithinPixelLimit(targetWidth, targetHeight, OUTPUT_MAX_PIXEL_COUNT);

  return {
    strategy:
      outputMode === "2x"
        ? fitted.clamped
          ? "2x-clamped"
          : "2x"
        : fitted.clamped
          ? "original-clamped"
          : "original",
    width: fitted.width,
    height: fitted.height,
    scale: fitted.width / width,
  };
}

export function choosePreviewSizing(
  width: number,
  height: number,
  maxEdge = PREVIEW_MAX_EDGE,
): PreviewSizing {
  const longestEdge = Math.max(width, height);

  if (longestEdge <= maxEdge) {
    return {
      width,
      height,
      scale: 1,
    };
  }

  const scale = maxEdge / longestEdge;

  return {
    width: clampDimension(width * scale),
    height: clampDimension(height * scale),
    scale,
  };
}

function fitWithinPixelLimit(width: number, height: number, pixelLimit: number) {
  const targetPixels = width * height;

  if (targetPixels <= pixelLimit) {
    return {
      width: clampDimension(width),
      height: clampDimension(height),
      clamped: false,
    };
  }

  const scale = Math.sqrt(pixelLimit / targetPixels);
  let fittedWidth = clampDimension(width * scale);
  let fittedHeight = clampDimension(height * scale);

  while (fittedWidth * fittedHeight > pixelLimit) {
    if (fittedWidth >= fittedHeight && fittedWidth > 1) {
      fittedWidth -= 1;
      continue;
    }

    if (fittedHeight > 1) {
      fittedHeight -= 1;
      continue;
    }

    break;
  }

  return {
    width: fittedWidth,
    height: fittedHeight,
    clamped: true,
  };
}

export async function decodeImageDimensions(file: File): Promise<{ width: number; height: number; objectUrl: string }> {
  const objectUrl = createObjectUrl(file);

  try {
    if (typeof createImageBitmap === "function") {
      const bitmap = await createImageBitmap(file);
      const { width, height } = bitmap;
      bitmap.close();
      return { width, height, objectUrl };
    }

    const image = await loadImageElement(objectUrl);
    return {
      width: image.naturalWidth,
      height: image.naturalHeight,
      objectUrl,
    };
  } catch (error) {
    revokeObjectUrl(objectUrl);
    throw error;
  }
}

export async function inspectImageFile(file: File): Promise<ImageSource> {
  const { width, height, objectUrl } = await decodeImageDimensions(file);
  const mimeType = file.type || "image/png";

  return {
    file,
    name: file.name,
    mimeType,
    width,
    height,
    megapixels: computeMegapixels(width, height),
    estimatedRgbaBytes: estimateRgbaBytes(width, height),
    objectUrl,
  };
}

export async function loadBitmapFromSource(
  source: Pick<ImageSource, "file" | "objectUrl">,
): Promise<ImageBitmap | HTMLImageElement> {
  if (typeof createImageBitmap === "function") {
    return createImageBitmap(source.file);
  }

  return loadImageElement(source.objectUrl);
}

function loadImageElement(objectUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.decoding = "async";
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("이미지를 디코드하지 못했습니다."));
    image.src = objectUrl;
  });
}
