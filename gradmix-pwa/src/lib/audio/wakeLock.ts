/**
 * Gestor de Screen Wake Lock API.
 * Mantiene la pantalla encendida (junto al modo Blackout OLED) para evitar que
 * iOS/Android suspendan el proceso del navegador durante las 10 horas de fiesta.
 */

export class WakeLockManager {
  private sentinel: WakeLockSentinel | null = null;
  private desiredActive = false;
  private listenersAttached = false;
  private onChangeCallback: ((active: boolean) => void) | null = null;

  constructor(onChange?: (active: boolean) => void) {
    this.onChangeCallback = onChange ?? null;
  }

  isSupported(): boolean {
    return typeof navigator !== 'undefined' && 'wakeLock' in navigator;
  }

  isActive(): boolean {
    return this.sentinel !== null && !this.sentinel.released;
  }

  private notify(): void {
    this.onChangeCallback?.(this.isActive());
  }

  private attachVisibilityHandler(): void {
    if (this.listenersAttached || typeof document === 'undefined') return;
    this.listenersAttached = true;

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && this.desiredActive && !this.isActive()) {
        void this.acquireInternal();
      }
    });
  }

  private async acquireInternal(): Promise<boolean> {
    if (!this.isSupported()) return false;
    try {
      this.sentinel = await navigator.wakeLock.request('screen');
      this.sentinel.addEventListener('release', () => {
        this.sentinel = null;
        this.notify();
      });
      this.notify();
      return true;
    } catch {
      this.sentinel = null;
      this.notify();
      return false;
    }
  }

  async enable(): Promise<boolean> {
    this.desiredActive = true;
    this.attachVisibilityHandler();
    if (this.isActive()) return true;
    return this.acquireInternal();
  }

  async disable(): Promise<void> {
    this.desiredActive = false;
    if (this.sentinel) {
      try {
        await this.sentinel.release();
      } catch {
        // Ignorar si ya fue liberado
      }
      this.sentinel = null;
    }
    this.notify();
  }
}
