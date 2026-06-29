import type { RenderResult } from "../types";
import { createObjectUrl } from "./image";

export const DEFAULT_JPEG_QUALITY = 0.92;

function normalizeQuality(quality: number | undefined): number {
  if (!Number.isFinite(quality)) {
    return DEFAULT_JPEG_QUALITY;
  }

  return Math.min(1, Math.max(0, quality ?? DEFAULT_JPEG_QUALITY));
}

function isOffscreenCanvas(canvas: OffscreenCanvas | HTMLCanvasElement): canvas is OffscreenCanvas {
  return typeof OffscreenCanvas !== "undefined" && canvas instanceof OffscreenCanvas;
}

function createCanvas(width: number, height: number): OffscreenCanvas | HTMLCanvasElement {
  if (typeof OffscreenCanvas !== "undefined") {
    return new OffscreenCanvas(width, height);
  }

  if (typeof document !== "undefined") {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    return canvas;
  }

  throw new Error("저장에 필요한 Canvas 2D를 사용할 수 없습니다.");
}
export async function canvasToBlob(
  canvas: OffscreenCanvas | HTMLCanvasElement,
  mimeType: "image/png" | "image/jpeg",
  quality = DEFAULT_JPEG_QUALITY,
): Promise<Blob> {
  if (isOffscreenCanvas(canvas)) {
    return canvas.convertToBlob({
      type: mimeType,
      quality: mimeType === "image/jpeg" ? normalizeQuality(quality) : undefined,
    });
  }

  const blob = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob(
      resolve,
      mimeType,
      mimeType === "image/jpeg" ? normalizeQuality(quality) : undefined,
    );
  });

  if (!blob) {
    throw new Error("캔버스를 이미지 파일로 저장하지 못했습니다.");
  }

  return blob;
}

export async function imageDataToBlob(
  imageData: ImageData,
  mimeType: "image/png" | "image/jpeg",
  quality = DEFAULT_JPEG_QUALITY,
): Promise<Blob> {
  const canvas = createCanvas(imageData.width, imageData.height);
  const context = canvas.getContext("2d", { willReadFrequently: true }) as
    | OffscreenCanvasRenderingContext2D
    | CanvasRenderingContext2D
    | null;

  if (!context) {
    throw new Error("저장에 필요한 Canvas 2D를 사용할 수 없습니다.");
  }

  context.putImageData(imageData, 0, 0);
  return canvasToBlob(canvas, mimeType, quality);
}

export async function imageDataToRenderResult(
  imageData: ImageData,
  mimeType: "image/png" | "image/jpeg",
  quality = DEFAULT_JPEG_QUALITY,
): Promise<RenderResult> {
  const blob = await imageDataToBlob(imageData, mimeType, quality);

  return {
    width: imageData.width,
    height: imageData.height,
    blob,
    objectUrl: createObjectUrl(blob),
  };
}

export function captureDebugPreviewPng(imageData: ImageData): Promise<Blob> {
  return imageDataToBlob(imageData, "image/png", 1);
}
