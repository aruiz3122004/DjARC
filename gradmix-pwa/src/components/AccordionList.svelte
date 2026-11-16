<script lang="ts">
  import type { AccordionItem } from '../lib/types';

  interface Props {
    items: readonly AccordionItem[];
  }

  let { items }: Props = $props();

  let expandedId = $state<string | null>(null);
</script>

<div class="divide-y divide-zinc-200 border-t border-b border-zinc-200 dark:divide-zinc-900 dark:border-zinc-900">
  {#each items as item (item.id)}
    {@const isOpen = expandedId === item.id}
    <div>
      <button
        type="button"
        onclick={() => (expandedId = isOpen ? null : item.id)}
        aria-expanded={isOpen}
        class="flex w-full items-center justify-between gap-4 px-3.5 py-3.5 text-left transition hover:bg-zinc-50/80 dark:hover:bg-zinc-950"
      >
        <div class="min-w-0">
          <p class="text-[10px] font-medium uppercase tracking-wider text-zinc-400 dark:text-zinc-500">
            {item.category}
          </p>
          <p class="mt-1 text-xs font-medium text-zinc-900 dark:text-zinc-100">
            {item.question}
          </p>
        </div>
        <span
          class="flex h-6 w-6 shrink-0 items-center justify-center text-zinc-500 transition-colors dark:text-zinc-400"
          aria-hidden="true"
        >
          {#if isOpen}
            <svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M18 6 6 18M6 6l12 12" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
          {:else}
            <svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M12 5v14M5 12h14" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
          {/if}
        </span>
      </button>

      {#if isOpen}
        <div class="px-3.5 pb-4 pt-0.5 text-[11px] leading-relaxed text-zinc-600 dark:text-zinc-300">
          {item.answer}
        </div>
      {/if}
    </div>
  {/each}
</div>
