import {
  createProductionRoutegoMcpProcess,
  type ProductionRoutegoMcpProcessOptions,
  type RoutegoMcpProcess
} from "./runtime/mcp-process";

export type RoutegoImageCliOptions = ProductionRoutegoMcpProcessOptions;

/** Starts the production runtime without import-time stream or signal side effects. */
export async function startRoutegoImageCli(
  options: RoutegoImageCliOptions
): Promise<RoutegoMcpProcess> {
  const runtime = await createProductionRoutegoMcpProcess(options);
  await runtime.start();
  return runtime;
}

/** Runs until STDIO closes, MCP requests shutdown, or a supported signal is received. */
export async function runRoutegoImageCli(options: RoutegoImageCliOptions): Promise<void> {
  const runtime = await createProductionRoutegoMcpProcess(options);
  await runtime.run();
}
