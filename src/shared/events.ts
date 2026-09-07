/** Minimal typed event emitter (no dependencies). */
export type Listener<T> = (event: T) => void;

export class Emitter<T> {
  private listeners = new Set<Listener<T>>();
  on(listener: Listener<T>): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  emit(event: T): void {
    for (const l of Array.from(this.listeners)) {
      try {
        l(event);
      } catch (err) {
        console.error('[emitter] listener failed', err);
      }
    }
  }
  clear(): void {
    this.listeners.clear();
  }
}
