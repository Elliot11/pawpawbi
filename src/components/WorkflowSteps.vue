<script setup lang="ts">
import { computed } from 'vue';
import type { WorkflowStage } from '../shared/types';
import { STAGES } from '../workflow';

const props = defineProps<{ stage: WorkflowStage }>();
defineEmits<{ select: [stage: WorkflowStage] }>();

const currentIndex = computed(() =>
  STAGES.findIndex((s) => s.id === props.stage),
);

// Lucide-style 24×24 stroke icons.
const ICONS: Record<WorkflowStage, string> = {
  // Database
  data: 'M4 6c0-1.66 3.58-3 8-3s8 1.34 8 3-3.58 3-8 3-8-1.34-8-3zM4 6v12c0 1.66 3.58 3 8 3s8-1.34 8-3V6M4 12c0 1.66 3.58 3 8 3s8-1.34 8-3',
  // Connected tables
  model: 'M3 4h7v6H3zM14 14h7v6h-7zM6.5 10v4a3 3 0 0 0 3 3H14',
  // Bar chart
  visuals: 'M4 20V10M10 20V4M16 20v-7M2 20h20',
};
</script>

<template>
  <ol class="steps" aria-label="Workflow">
    <li v-for="(s, i) in STAGES" :key="s.id">
      <button
        :class="{ done: i < currentIndex, current: i === currentIndex }"
        :aria-current="i === currentIndex ? 'step' : undefined"
        @click="$emit('select', s.id)"
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path :d="ICONS[s.id]" />
        </svg>
        {{ s.label }}
      </button>
    </li>
  </ol>
</template>

<style scoped>
.steps {
  display: flex;
  gap: 6px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.steps button {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 6px 12px;
  border: none;
  border-radius: var(--radius-sm);
  background: var(--surface-muted);
  color: var(--ink-faint);
  font-size: 13px;
  font-weight: 600;
  white-space: nowrap;
  transition:
    background 0.15s,
    color 0.15s;
}

.steps button:hover:not(.current) {
  background: #e6e4de;
  color: var(--ink-muted);
}

.steps button.current {
  background: var(--accent-soft);
  color: var(--accent);
}

.steps button.done {
  color: var(--ink-muted);
}

svg {
  width: 16px;
  height: 16px;
  flex: none;
  fill: none;
  stroke: currentColor;
  stroke-width: 2;
  stroke-linecap: round;
  stroke-linejoin: round;
}
</style>
