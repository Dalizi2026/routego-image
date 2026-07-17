import { useEffect, useState, type ReactNode } from "react";

import type { BrowserResourceDescriptor } from "@routego-image/contracts";

import type { ProtectedObjectUrl, StudioGateway } from "../api";
import { useI18n } from "../i18n";

type ResourceState =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly resource: ProtectedObjectUrl }
  | { readonly status: "failure" };

export function ProtectedResourceBoundary({
  gateway,
  descriptor,
  children,
  fallback
}: {
  readonly gateway: StudioGateway;
  readonly descriptor: BrowserResourceDescriptor;
  readonly children: (resource: ProtectedObjectUrl) => ReactNode;
  readonly fallback?: ReactNode;
}) {
  const { t } = useI18n();
  const [state, setState] = useState<ResourceState>({ status: "loading" });

  useEffect(() => {
    let active = true;
    let objectUrl: ProtectedObjectUrl | undefined;
    setState({ status: "loading" });
    void gateway
      .fetchProtectedObjectUrl(descriptor)
      .then((resource) => {
        objectUrl = resource;
        if (active) {
          setState({ status: "ready", resource });
        } else {
          resource.revoke();
        }
      })
      .catch(() => {
        if (active) {
          setState({ status: "failure" });
        }
      });
    return () => {
      active = false;
      objectUrl?.revoke();
    };
  }, [descriptor, gateway]);

  if (state.status === "loading") {
    return <div className="protected-resource protected-resource--loading">{t("resource.loading")}</div>;
  }
  if (state.status === "failure") {
    return (
      <div className="protected-resource protected-resource--failure" role="alert">
        {fallback ?? t("resource.failure")}
      </div>
    );
  }
  return children(state.resource);
}

export function ProtectedImage({
  gateway,
  descriptor,
  alt,
  className
}: {
  readonly gateway: StudioGateway;
  readonly descriptor: BrowserResourceDescriptor;
  readonly alt: string;
  readonly className?: string;
}) {
  return (
    <ProtectedResourceBoundary gateway={gateway} descriptor={descriptor}>
      {(resource) => <img className={className} src={resource.url} alt={alt} />}
    </ProtectedResourceBoundary>
  );
}
