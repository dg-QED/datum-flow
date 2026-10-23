// The app's single Datum Bridge client, wired to Flow's tools.
import { useSyncExternalStore } from "react";
import { BridgeClient, type BridgeState } from "./bridgeClient";
import { flowTools } from "./tools";
import { getState } from "../store";
import pkg from "../../package.json";

export const APP_VERSION: string = pkg.version;

export const bridge = new BridgeClient({
  app: "flow",
  appVersion: APP_VERSION,
  title: () => `Datum Flow — ${getState().project?.title ?? ""}`,
  tools: flowTools,
  onActivity: (e) => window.dispatchEvent(new CustomEvent("flow:ai-activity", { detail: e })),
});

let webmcpDone = false;
export function initAI() {
  if (webmcpDone) return;
  webmcpDone = true;
  try { bridge.registerWebMCP(); } catch { /* feature-detected only */ }
}

export function useBridge<T>(sel: (s: BridgeState) => T): T {
  return useSyncExternalStore((f) => bridge.subscribe(f), () => sel(bridge.state), () => sel(bridge.state));
}
