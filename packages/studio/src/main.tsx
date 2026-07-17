import { StrictMode, type ReactElement } from "react";
import { createRoot } from "react-dom/client";

import {
  bootstrapStudioSessionFromWindow,
  HttpStudioGateway,
  type StudioGateway
} from "./api";
import { StudioApp } from "./app";

export function StudioEntry({
  bootstrap,
  createGateway = (session) =>
    new HttpStudioGateway({ baseUrl: window.location.origin, session })
}: {
  readonly bootstrap: ReturnType<typeof bootstrapStudioSessionFromWindow>;
  readonly createGateway?: (session: Extract<typeof bootstrap, { status: "ready" }>["session"]) => StudioGateway;
}): ReactElement {
  if (bootstrap.status !== "ready") {
    return (
      <main>
        <h1>Routego Studio</h1>
        <section role="alert" aria-labelledby="studio-missing-session">
          <h2 id="studio-missing-session">本地会话缺失或无效</h2>
          <p>请关闭此页面，再从 Routego Image 重新打开 Studio。</p>
          <p lang="en">Close this page and reopen Studio from Routego Image.</p>
        </section>
      </main>
    );
  }
  return <StudioApp gateway={createGateway(bootstrap.session)} />;
}

if (typeof document !== "undefined") {
  const rootElement = document.getElementById("root");
  const bootstrap = bootstrapStudioSessionFromWindow();
  if (rootElement !== null) {
    createRoot(rootElement).render(
      <StrictMode>
        <StudioEntry bootstrap={bootstrap} />
      </StrictMode>
    );
  }
}
