import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type { RpcError } from './types';
import type { WindowMethod } from './rpcMethods';

/**
 * The only bridge to the backend. The webview never sees the API key and never talks to the
 * network; every call goes through the Rust allow-list to the local sidecar.
 */
export async function call<T = unknown>(method: WindowMethod, params: Record<string, unknown> = {}): Promise<T> {
  try {
    return (await invoke('sidecar_call', { method, params })) as T;
  } catch (err) {
    const e = toRpcError(err);
    // The shell's allow-list said no: a bug in Workshop itself, never something the user did.
    if (e.code === 'rejected') {
      console.error(`[rpc] ${method}: ${e.message}`);
      window.dispatchEvent(new CustomEvent<RejectedCall>(RPC_REJECTED_EVENT, { detail: { method, message: e.message } }));
    }
    throw e;
  }
}

/** Fired on the window when the shell rejects a call, so the app can show it instead of failing silently. */
export const RPC_REJECTED_EVENT = 'void-rpc-rejected';
export interface RejectedCall {
  method: string;
  message: string;
}

export function toRpcError(err: unknown): RpcError {
  if (err && typeof err === 'object' && 'message' in err) {
    const e = err as { code?: unknown; message: unknown };
    return { code: typeof e.code === 'string' ? e.code : 'error', message: String(e.message) };
  }
  return { code: 'error', message: typeof err === 'string' ? err : 'Unexpected error' };
}

export function errorText(err: unknown): string {
  return toRpcError(err).message;
}

export interface SidecarEvent {
  event: string;
  payload: unknown;
}

export function onSidecarEvent(handler: (e: SidecarEvent) => void): Promise<UnlistenFn> {
  return listen<SidecarEvent>('sidecar-event', (e) => handler(e.payload));
}

export function onSidecarExit(handler: (code: number | null) => void): Promise<UnlistenFn> {
  return listen<{ code: number | null }>('sidecar-exit', (e) => handler(e.payload.code));
}

export const pickProjectDir = () => invoke<string | null>('pick_project_dir');
/** Opens Claude's sign-in page in the browser; the shell refuses any other URL. */
export const openLoginUrl = (url: string) => invoke<void>('open_login_url', { url });
/** Closing the window hides it to the tray instead of quitting (for VOID Portal). */
export const setBackgroundMode = (on: boolean) => invoke<void>('set_background_mode', { on });
export const restartSidecar = () => invoke<void>('sidecar_restart');
export const startupError = () => invoke<string | null>('startup_error');
/** The UI scale: the webview's own zoom, so layout, pointer and element sizes stay in one coordinate space. */
export const setUiScale = (scale: number) =>
  import('@tauri-apps/api/webview').then(({ getCurrentWebview }) => getCurrentWebview().setZoom(scale));
