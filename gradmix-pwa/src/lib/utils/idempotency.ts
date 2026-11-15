/**
 * Utilidad de idempotencia y bloqueo por acción:
 * garantiza que un click o tap dispare una sola petición/operación a la vez,
 * bloqueando reintentos duplicados hasta que la operación finalice (o venza un límite de seguridad).
 */

export function createRequestId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `req-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export interface IdempotentRunOptions {
  /** Tiempo mínimo de bloqueo tras iniciar la acción (para evitar doble tap accidental). */
  minLockMs?: number;
  /** Límite de seguridad máximo para desbloquear si la promesa queda colgada. */
  maxLockMs?: number;
}

export interface IdempotentRunResult<T> {
  executed: boolean;
  value?: T;
}

export class IdempotentController {
  private locks = new Map<string, number>();
  private onChange?: (activeKeys: string[]) => void;

  constructor(onChange?: (activeKeys: string[]) => void) {
    this.onChange = onChange;
  }

  isLocked(key: string): boolean {
    const expiresAt = this.locks.get(key);
    if (expiresAt === undefined) return false;
    if (Date.now() >= expiresAt) {
      this.locks.delete(key);
      this.emit();
      return false;
    }
    return true;
  }

  activeKeys(): string[] {
    const now = Date.now();
    for (const [k, exp] of this.locks.entries()) {
      if (now >= exp) this.locks.delete(k);
    }
    return Array.from(this.locks.keys());
  }

  private emit(): void {
    this.onChange?.(this.activeKeys());
  }

  async run<T>(
    key: string,
    fn: () => Promise<T> | T,
    options: IdempotentRunOptions = {}
  ): Promise<IdempotentRunResult<T>> {
    if (this.isLocked(key)) {
      return { executed: false };
    }

    const minLockMs = Math.max(0, options.minLockMs ?? 80);
    const maxLockMs = Math.max(minLockMs + 500, options.maxLockMs ?? 12_000);
    const startedAt = Date.now();

    this.locks.set(key, startedAt + maxLockMs);
    this.emit();

    const safetyTimer =
      typeof setTimeout === 'function'
        ? setTimeout(() => {
            if (this.locks.has(key)) {
              this.locks.delete(key);
              this.emit();
            }
          }, maxLockMs)
        : null;

    if (safetyTimer && typeof safetyTimer === 'object' && 'unref' in safetyTimer) {
      (safetyTimer as { unref?: () => void }).unref?.();
    }

    try {
      const value = await fn();
      return { executed: true, value };
    } finally {
      if (safetyTimer) clearTimeout(safetyTimer);
      const elapsed = Date.now() - startedAt;
      const remainingMin = minLockMs - elapsed;
      if (remainingMin > 15 && typeof setTimeout === 'function') {
        await new Promise<void>((r) => setTimeout(r, remainingMin));
      }
      this.locks.delete(key);
      this.emit();
    }
  }
}
