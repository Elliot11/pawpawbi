<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';
import type { Project, WorkflowStage } from '../shared/types';
import ChatPanel from '../components/ChatPanel.vue';
import WorkflowSteps from '../components/WorkflowSteps.vue';
import GetData from '../components/data/GetData.vue';
import ReportCanvas from '../components/ReportCanvas.vue';

const props = defineProps<{ project: Project }>();
const emit = defineEmits<{ close: [] }>();

const tab = ref<'data' | 'report'>('data');
// Where the user is in the workflow. The chat loads it from the project and advances it.
const stage = ref<WorkflowStage>('data');

const saving = ref(false);
const saveError = ref('');

async function save() {
  if (saving.value || !props.project.dirty) return;
  saving.value = true;
  saveError.value = '';
  try {
    await window.api.projects.save();
  } catch (error) {
    console.error(error);
    saveError.value = "Couldn't save. Check the file isn't open in another program.";
  } finally {
    saving.value = false;
  }
}

async function close() {
  try {
    if (await window.api.projects.close()) emit('close');
  } catch (error) {
    console.error(error);
    saveError.value = "Couldn't save. Check the file isn't open in another program.";
  }
}

function onKeydown(event: KeyboardEvent) {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
    event.preventDefault();
    save();
  }
}

onMounted(() => window.addEventListener('keydown', onKeydown));
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown));
</script>

<template>
  <div class="workspace">
    <header class="topbar">
      <button class="back" title="Back to projects" @click="close">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 18l-6-6 6-6" /></svg>
        Projects
      </button>
      <span class="divider" aria-hidden="true"></span>
      <h1 :title="project.path">{{ project.name }}</h1>

      <div class="steps-slot">
        <WorkflowSteps :stage="stage" />
      </div>

      <div class="save-area">
        <span v-if="saveError" class="save-error" role="alert">{{ saveError }}</span>
        <span v-else class="save-status">{{ project.dirty ? 'Unsaved changes' : 'Saved' }}</span>
        <button
          class="save"
          :disabled="!project.dirty || saving"
          title="Save (Ctrl+S)"
          @click="save"
        >
          {{ saving ? 'Saving…' : 'Save' }}
        </button>
      </div>
    </header>

    <div class="body">
      <ChatPanel v-model:stage="stage" />
      <section class="main">
        <nav class="tabs" role="tablist" aria-label="Project views">
          <button role="tab" :aria-selected="tab === 'data'" :class="{ active: tab === 'data' }" @click="tab = 'data'">
            Data
          </button>
          <button role="tab" :aria-selected="tab === 'report'" :class="{ active: tab === 'report' }" @click="tab = 'report'">
            Report
          </button>
        </nav>
        <div class="tab-body">
          <!-- Kept alive so switching tabs doesn't lose a half-finished data source setup. -->
          <KeepAlive>
            <GetData v-if="tab === 'data'" />
            <ReportCanvas v-else />
          </KeepAlive>
        </div>
      </section>
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
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  font-size: 18px;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.steps-slot {
  display: flex;
  flex: 1;
  justify-content: center;
  min-width: max-content;
}

.save-area {
  display: flex;
  align-items: center;
  gap: 12px;
  white-space: nowrap;
}

.save-status {
  color: var(--ink-faint);
  font-size: 13px;
}

.save-error {
  color: var(--danger);
  font-size: 13px;
}

.save {
  padding: 6px 16px;
  border: none;
  border-radius: var(--radius-sm);
  background: var(--ink);
  color: #fff;
  font-weight: 600;
}

.save:hover:not(:disabled) {
  background: #2c2c33;
}

.save:disabled {
  background: var(--surface-muted);
  color: var(--ink-faint);
}

.body {
  display: flex;
  flex: 1;
  min-height: 0;
}

.main {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-width: 0;
}

.tabs {
  display: flex;
  flex: none;
  gap: 4px;
  padding: 8px 16px 0;
  border-bottom: 1px solid var(--border);
  background: var(--surface);
}

.tabs button {
  padding: 8px 14px;
  border: none;
  border-bottom: 2px solid transparent;
  background: none;
  color: var(--ink-muted);
  font-weight: 600;
}

.tabs button.active {
  border-bottom-color: var(--accent);
  color: var(--ink);
}

.tab-body {
  display: flex;
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  background: var(--bg);
}
</style>
