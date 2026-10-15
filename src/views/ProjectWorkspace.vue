<script setup lang="ts">
import type { Project } from '../shared/types';
import ChatPanel from '../components/ChatPanel.vue';
import ReportCanvas from '../components/ReportCanvas.vue';

defineProps<{ project: Project }>();
defineEmits<{ close: [] }>();
</script>

<template>
  <div class="workspace">
    <header class="topbar">
      <button class="back" title="Back to projects" @click="$emit('close')">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 18l-6-6 6-6" /></svg>
        Projects
      </button>
      <span class="divider" aria-hidden="true"></span>
      <h1 :title="project.path">{{ project.name }}</h1>
    </header>

    <div class="body">
      <ChatPanel />
      <ReportCanvas />
    </div>
  </div>
</template>

<style scoped>
.workspace {
  display: flex;
  flex-direction: column;
  height: 100%;
}

.topbar {
  display: flex;
  flex: none;
  align-items: center;
  gap: 12px;
  height: 56px;
  padding: 0 16px;
  border-bottom: 1px solid var(--border);
  background: var(--surface);
}

.back {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 6px 10px 6px 6px;
  border: none;
  border-radius: var(--radius-sm);
  background: none;
  color: var(--ink-muted);
  font-weight: 500;
}

.back:hover {
  background: var(--surface-muted);
  color: var(--ink);
}

.back svg {
  width: 18px;
  height: 18px;
  fill: none;
  stroke: currentColor;
  stroke-width: 2;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.divider {
  width: 1px;
  height: 20px;
  background: var(--border);
}

.topbar h1 {
  overflow: hidden;
  font-size: 18px;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.body {
  display: flex;
  flex: 1;
  min-height: 0;
}
</style>
