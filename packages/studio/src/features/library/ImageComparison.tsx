import { useState, type CSSProperties, type KeyboardEvent } from "react";

import type { BrowserResourceDescriptor } from "@routego-image/contracts";

import type { StudioGateway } from "../../api";
import { ProtectedImage } from "../../components";
import {
  clampComparisonPosition,
  comparisonPositionFromKey
} from "./comparison";

export function ImageComparison({
  gateway,
  source,
  output,
  sourceLabel,
  outputLabel,
  controlLabel
}: {
  readonly gateway: StudioGateway;
  readonly source: BrowserResourceDescriptor;
  readonly output: BrowserResourceDescriptor;
  readonly sourceLabel: string;
  readonly outputLabel: string;
  readonly controlLabel: string;
}) {
  const [position, setPosition] = useState(50);
  const style = { "--comparison-position": `${position}%` } as CSSProperties;

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    const next = comparisonPositionFromKey(position, event.key);
    if (next === undefined) return;
    event.preventDefault();
    setPosition(next);
  };

  return (
    <figure className="image-comparison" style={style}>
      <div className="image-comparison__stage">
        <ProtectedImage
          gateway={gateway}
          descriptor={output}
          alt={outputLabel}
          className="image-comparison__image"
        />
        <div className="image-comparison__source" aria-hidden="true">
          <ProtectedImage
            gateway={gateway}
            descriptor={source}
            alt=""
            className="image-comparison__image"
          />
        </div>
        <span className="image-comparison__divider" aria-hidden="true" />
        <span className="image-comparison__label image-comparison__label--source">
          {sourceLabel}
        </span>
        <span className="image-comparison__label image-comparison__label--output">
          {outputLabel}
        </span>
        <input
          className="image-comparison__control"
          type="range"
          min={0}
          max={100}
          value={position}
          aria-label={controlLabel}
          aria-valuetext={`${position}%`}
          onChange={(event) => setPosition(clampComparisonPosition(Number(event.target.value)))}
          onKeyDown={handleKeyDown}
        />
      </div>
      <figcaption>
        <span>{sourceLabel}</span>
        <output>{position}%</output>
        <span>{outputLabel}</span>
      </figcaption>
    </figure>
  );
}
