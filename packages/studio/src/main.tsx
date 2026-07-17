import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";

import {
  bootstrapStudioSessionFromWindow,
  HttpStudioGateway,
  StudioGatewayError,
  type StudioGateway
} from "./api";

type BootState =
  | { readonly status: "checking" }
  | { readonly status: "ready"; readonly providerCount: number }
  | { readonly status: "failed"; readonly message: string };

function StudioFoundationScreen({ gateway }: { readonly gateway: StudioGateway }) {
  const [state, setState] = useState<BootState>({ status: "checking" });

  useEffect(() => {
    let active = true;
    void Promise.all([gateway.invoke("status", {}), gateway.invoke("readSettings", {})])
      .then(([status, settings]) => {
        if (!active) {
          return;
        }
        if (!status.service.studioAvailable) {
          setState({
            status: "failed",
            message: "本地服务尚未开放 Studio，请从 Routego Image 重新打开。"
          });
          return;
        }
        setState({ status: "ready", providerCount: settings.profiles.length });
      })
      .catch((error: unknown) => {
        if (active) {
          setState({
            status: "failed",
            message:
              error instanceof StudioGatewayError
                ? error.message
                : "Studio 无法验证本地服务，请从 Routego Image 重新打开。"
          });
        }
      });
    return () => {
      active = false;
    };
  }, [gateway]);

  return (
    <main aria-busy={state.status === "checking"}>
      <h1>Routego Studio</h1>
      {state.status === "checking" ? <p>正在验证本地安全会话…</p> : null}
      {state.status === "ready" ? (
        <p>本地工作区已连接，已读取 {state.providerCount} 个中转配置。</p>
      ) : null}
      {state.status === "failed" ? (
        <section role="alert" aria-labelledby="studio-session-error">
          <h2 id="studio-session-error">无法进入 Studio</h2>
          <p>{state.message}</p>
          <p>请关闭此页面，再从 Routego Image 重新打开 Studio。</p>
        </section>
      ) : null}
    </main>
  );
}

function StudioEntry({ bootstrap }: { readonly bootstrap: ReturnType<typeof bootstrapStudioSessionFromWindow> }) {
  if (bootstrap.status !== "ready") {
    return (
      <main>
        <h1>Routego Studio</h1>
        <section role="alert" aria-labelledby="studio-missing-session">
          <h2 id="studio-missing-session">本地会话缺失或无效</h2>
          <p>请关闭此页面，再从 Routego Image 重新打开 Studio。</p>
        </section>
      </main>
    );
  }
  const gateway = new HttpStudioGateway({
    baseUrl: window.location.origin,
    session: bootstrap.session
  });
  return <StudioFoundationScreen gateway={gateway} />;
}

const rootElement = document.getElementById("root");
if (rootElement !== null) {
  const bootstrap = bootstrapStudioSessionFromWindow();
  createRoot(rootElement).render(
    <StrictMode>
      <StudioEntry bootstrap={bootstrap} />
    </StrictMode>
  );
}
