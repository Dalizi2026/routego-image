export interface MaskPoint {
  readonly x: number;
  readonly y: number;
}

export interface MaskSize {
  readonly width: number;
  readonly height: number;
}

export interface MaskViewport {
  readonly scale: number;
  readonly offsetX: number;
  readonly offsetY: number;
}

export const MIN_MASK_ZOOM = 0.05;
export const MAX_MASK_ZOOM = 32;

function positive(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive finite number.`);
  }
  return value;
}

export function clampMaskZoom(scale: number): number {
  if (!Number.isFinite(scale)) {
    return 1;
  }
  return Math.min(MAX_MASK_ZOOM, Math.max(MIN_MASK_ZOOM, scale));
}

export function fitMaskViewport(
  image: MaskSize,
  viewport: MaskSize,
  padding = 32
): MaskViewport {
  const imageWidth = positive(image.width, "Image width");
  const imageHeight = positive(image.height, "Image height");
  const viewportWidth = positive(viewport.width, "Viewport width");
  const viewportHeight = positive(viewport.height, "Viewport height");
  const safePadding = Math.max(0, Math.min(padding, viewportWidth / 3, viewportHeight / 3));
  const availableWidth = Math.max(1, viewportWidth - safePadding * 2);
  const availableHeight = Math.max(1, viewportHeight - safePadding * 2);
  const scale = clampMaskZoom(
    Math.min(availableWidth / imageWidth, availableHeight / imageHeight)
  );
  return {
    scale,
    offsetX: (viewportWidth - imageWidth * scale) / 2,
    offsetY: (viewportHeight - imageHeight * scale) / 2
  };
}

function boundedOffset(
  offset: number,
  scaledLength: number,
  viewportLength: number,
  visibleMargin: number
): number {
  if (scaledLength <= viewportLength) {
    return (viewportLength - scaledLength) / 2;
  }
  const margin = Math.max(0, Math.min(visibleMargin, viewportLength / 2));
  const minimum = viewportLength - margin - scaledLength;
  const maximum = margin;
  return Math.min(maximum, Math.max(minimum, offset));
}

export function boundMaskViewport(
  transform: MaskViewport,
  image: MaskSize,
  viewport: MaskSize,
  visibleMargin = 48
): MaskViewport {
  const scale = clampMaskZoom(transform.scale);
  return {
    scale,
    offsetX: boundedOffset(
      transform.offsetX,
      positive(image.width, "Image width") * scale,
      positive(viewport.width, "Viewport width"),
      visibleMargin
    ),
    offsetY: boundedOffset(
      transform.offsetY,
      positive(image.height, "Image height") * scale,
      positive(viewport.height, "Viewport height"),
      visibleMargin
    )
  };
}

export function imagePointToScreen(point: MaskPoint, viewport: MaskViewport): MaskPoint {
  return {
    x: point.x * viewport.scale + viewport.offsetX,
    y: point.y * viewport.scale + viewport.offsetY
  };
}

export function screenPointToImage(point: MaskPoint, viewport: MaskViewport): MaskPoint {
  const scale = positive(viewport.scale, "Viewport scale");
  return {
    x: (point.x - viewport.offsetX) / scale,
    y: (point.y - viewport.offsetY) / scale
  };
}

export function isImagePointInside(point: MaskPoint, image: MaskSize): boolean {
  return point.x >= 0 && point.y >= 0 && point.x < image.width && point.y < image.height;
}

export function zoomMaskViewportAt(
  viewport: MaskViewport,
  cursor: MaskPoint,
  requestedScale: number,
  image: MaskSize,
  viewportSize: MaskSize
): MaskViewport {
  const scale = clampMaskZoom(requestedScale);
  const imagePoint = screenPointToImage(cursor, viewport);
  return boundMaskViewport(
    {
      scale,
      offsetX: cursor.x - imagePoint.x * scale,
      offsetY: cursor.y - imagePoint.y * scale
    },
    image,
    viewportSize
  );
}

export function panMaskViewport(
  viewport: MaskViewport,
  delta: MaskPoint,
  image: MaskSize,
  viewportSize: MaskSize
): MaskViewport {
  return boundMaskViewport(
    {
      ...viewport,
      offsetX: viewport.offsetX + delta.x,
      offsetY: viewport.offsetY + delta.y
    },
    image,
    viewportSize
  );
}

export function wheelMaskZoom(scale: number, deltaY: number): number {
  const exponent = Math.max(-6, Math.min(6, -deltaY / 320));
  return clampMaskZoom(scale * 2 ** exponent);
}
