import { writable } from 'svelte/store';

export interface Toast {
  id: number;
  msg: string;
  kind: 'info' | 'ok' | 'err';
}

export const toasts = writable<Toast[]>([]);
let n = 0;

export function toast(msg: string, kind: Toast['kind'] = 'info') {
  const id = ++n;
  toasts.update((t) => [...t, { id, msg, kind }]);
  setTimeout(() => toasts.update((t) => t.filter((x) => x.id !== id)), 3200);
}
