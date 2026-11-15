<script lang="ts">
  interface Props {
    open: boolean;
    title: string;
    message: string;
    confirmLabel?: string;
    cancelLabel?: string;
    danger?: boolean;
    onConfirm: () => void;
    onCancel: () => void;
  }

  let {
    open,
    title,
    message,
    confirmLabel = 'Confirmar',
    cancelLabel = 'Cancelar',
    danger = true,
    onConfirm,
    onCancel,
  }: Props = $props();
</script>

{#if open}
  <div
    class="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
    role="dialog"
    aria-modal="true"
    aria-label={title}
  >
    <div class="w-full max-w-sm border border-zinc-300 bg-white p-4 shadow-2xl dark:border-zinc-800 dark:bg-zinc-950">
      <h3 class="text-sm font-semibold text-zinc-900 dark:text-white">
        {title}
      </h3>
      <p class="mt-2 text-xs leading-relaxed text-zinc-600 dark:text-zinc-400">
        {message}
      </p>

      <div class="mt-4 flex items-center justify-end gap-2">
        <button
          type="button"
          onclick={onCancel}
          class="border border-zinc-300 bg-zinc-50 px-3 py-1.5 text-xs font-medium text-zinc-800 transition hover:bg-zinc-100 dark:border-zinc-800 dark:bg-black dark:text-zinc-200 dark:hover:bg-zinc-900"
        >
          {cancelLabel}
        </button>
        <button
          type="button"
          onclick={onConfirm}
          class="px-3 py-1.5 text-xs font-semibold transition {danger
            ? 'bg-red-600 text-white hover:bg-red-700'
            : 'bg-zinc-900 text-white hover:bg-zinc-800 dark:bg-white dark:text-black dark:hover:bg-zinc-200'}"
        >
          {confirmLabel}
        </button>
      </div>
    </div>
  </div>
{/if}
