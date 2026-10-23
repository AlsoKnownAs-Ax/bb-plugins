// Tiny app-wide UI state shared between the palette command, the overlay
// dialog and the review page (they are separate React roots).
import { useSyncExternalStore } from "react";

interface UiState {
  openDialog: boolean;
  /** Set when a review is opened from the dialog/command: start in focus mode. */
  focusOnOpen: boolean;
}

let state: UiState = { openDialog: false, focusOnOpen: false };
const listeners = new Set<() => void>();

export const uiStore = {
  get: () => state,
  set(patch: Partial<UiState>) {
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  },
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};

export function useUiStore(): UiState {
  return useSyncExternalStore(uiStore.subscribe, uiStore.get, uiStore.get);
}
