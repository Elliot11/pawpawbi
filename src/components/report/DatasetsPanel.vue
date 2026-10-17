<script setup lang="ts">
// The report's datasets: named queries whose results the report site reads from
// data/<name>.json. Saving one runs its query and writes the file.
import { computed, onMounted, ref } from 'vue';
import { errorMessage } from '../../errors';
import type { Dataset, TablePreview } from '../../shared/types';
import DataGrid from '../data/DataGrid.vue';

const emit = defineEmits<{ changed: [] }>();

const datasets = ref<Dataset[]>([]);
const editing = ref<Dataset | null>(null);
const isNew = ref(false);
const name = ref('');
const sql = ref('');
const preview = ref<TablePreview | null>(null);
const busy = ref<'' | 'preview' | 'save' | 'delete'>('');
const error = ref('');

const NAME = /^[a-z][a-z0-9_]{0,62}$/;
const nameProblem = computed(() =>
  isNew.value && name.value && !NAME.test(name.value)
    ? 'Use lowercase letters, digits and underscores, starting with a letter.'
    : isNew.value && datasets.value.some((d) => d.name === name.value)
      ? 'There’s already a dataset with this name.'
      : '',
);

async function load() {
  try {
    datasets.value = await window.api.report.listDatasets();
  } catch (e) {
    error.value = `Couldn't load the datasets. ${errorMessage(e)}`;
  }
}

onMounted(load);

function open(dataset: Dataset | null) {
  editing.value = dataset;
  isNew.value = dataset === null;
  name.value = dataset?.name ?? '';
  sql.value = dataset?.sql ?? '';
  preview.value = null;
  error.value = '';
}

const cleanError = (e: unknown) =>
  errorMessage(e).replace(/^\w+(?:Error|Exception): /, '');

async function runPreview() {
  if (!sql.value.trim()) return;
  busy.value = 'preview';
  error.value = '';
  try {
    preview.value = await window.api.data.previewTransform(
      sql.value,
      'transformed',
    );
  } catch (e) {
    preview.value = null;
    error.value = cleanError(e);
  } finally {
    busy.value = '';
  }
}

async function save() {
  if (nameProblem.value || !name.value || !sql.value.trim()) {
    error.value = !name.value
      ? 'Enter a name for the dataset.'
      : nameProblem.value || 'Enter a query for the dataset.';
    return;
  }
  busy.value = 'save';
  error.value = '';
  try {
    const saved = await window.api.report.saveDataset(name.value, sql.value);
    await load();
    open(saved);
    emit('changed');
  } catch (e) {
    error.value = cleanError(e);
  } finally {
    busy.value = '';
  }
}

async function remove() {
  const dataset = editing.value;
  if (!dataset) return;
  if (
    !window.confirm(
      `Delete the dataset “${dataset.name}”? Charts that use it will show an error.`,
    )
  ) {
    return;
  }
  busy.value = 'delete';
  try {
    await window.api.report.deleteDataset(dataset.name);
    await load();
    open(null);
    editing.value = null;
    isNew.value = false;
    emit('changed');
  } catch (e) {
    error.value = cleanError(e);
  } finally {
    busy.value = '';
  }
}

function onKey(event: KeyboardEvent) {
  if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
    event.preventDefault();
    runPreview();
  }
}

const rowsLabel = (d: Dataset) =>
  d.error
    ? 'Last update failed'
    : d.rows === undefined
      ? ''
      : `${d.rows.toLocaleString()} ${d.rows === 1 ? 'row' : 'rows'}`;

defineExpose({ reload: load });
</script>

<template>
  <div class="datasets">
    <template v-if="!editing && !isNew">
      <p class="intro">
        Datasets are the data the report publishes: each is a query over your
        tables, saved with the report as data/&lt;name&gt;.json. Pages draw
        charts from them.
      </p>
      <ul v-if="datasets.length" class="list">
        <li v-for="d in datasets" :key="d.name">
          <button class="item" @click="open(d)">
            <span class="item-name">{{ d.name }}</span>
            <span class="item-meta" :class="{ failed: d.error }">{{
              rowsLabel(d)
            }}</span>
          </button>
        </li>
      </ul>
      <p v-else class="none">No datasets yet.</p>
      <button class="primary" @click="open(null)">New dataset</button>
    </template>

    <template v-else>
      <button class="back" @click="((editing = null), (isNew = false))">
        ← All datasets
      </button>
      <label v-if="isNew" class="field">
        Name
        <input
          v-model="name"
          type="text"
          placeholder="e.g. revenue_by_month"
          spellcheck="false"
        />
      </label>
      <h3 v-else class="name">{{ editing?.name }}</h3>
      <p v-if="nameProblem" class="problem">{{ nameProblem }}</p>
      <p v-if="editing?.error" class="problem">
        The last update failed: {{ editing.error }}
      </p>

      <textarea
        v-model="sql"
        class="sql"
        spellcheck="false"
        aria-label="Query"
        placeholder="SELECT region, sum(revenue) AS revenue FROM orders GROUP BY 1"
        @keydown="onKey"
      ></textarea>
      <p class="note">
        One SELECT over any table, by name. Group the data here: only what it
        returns is published.
      </p>

      <div class="actions">
        <button
          class="ghost"
          :disabled="!!busy"
          title="Run (Ctrl+Enter)"
          @click="runPreview"
        >
          {{ busy === 'preview' ? 'Running…' : 'Run preview' }}
        </button>
        <button class="primary" :disabled="!!busy" @click="save">
          {{ busy === 'save' ? 'Saving…' : isNew ? 'Create dataset' : 'Save' }}
        </button>
        <button v-if="!isNew" class="link" :disabled="!!busy" @click="remove">
          Delete
        </button>
      </div>

      <p v-if="error" class="error" role="alert">{{ error }}</p>
      <DataGrid v-if="preview" class="grid" :preview="preview" />
    </template>
  </div>
</template>

<style scoped>
.datasets {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 10px;
  min-height: 0;
}

.intro,
.note,
.none {
  margin: 0;
  color: var(--ink-muted);
  font-size: 13px;
}

.note {
  color: var(--ink-faint);
  font-size: 12px;
}

.list {
  margin: 0;
  padding: 0;
  overflow-y: auto;
  list-style: none;
}

.item {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  width: 100%;
  padding: 8px 10px;
  border: none;
  border-radius: var(--radius-sm);
  background: none;
  text-align: left;
}

.item:hover {
  background: var(--surface-muted);
}

.item-name {
  overflow: hidden;
  font-family: ui-monospace, 'Cascadia Mono', Consolas, monospace;
  font-size: 13px;
  font-weight: 600;
  text-overflow: ellipsis;
}

.item-meta {
  flex: none;
  color: var(--ink-muted);
  font-size: 12px;
}

.item-meta.failed,
.problem {
  color: var(--danger);
}

.problem {
  margin: 0;
  font-size: 13px;
}

.back {
  align-self: flex-start;
  padding: 0;
  border: none;
  background: none;
  color: var(--ink-muted);
  font-size: 13px;
}

.back:hover {
  color: var(--ink);
}

.name {
  font-family: ui-monospace, 'Cascadia Mono', Consolas, monospace;
  font-size: 15px;
  font-weight: 700;
  letter-spacing: 0;
}

.field {
  display: flex;
  align-items: center;
  gap: 8px;
  font-weight: 600;
}

.field input {
  flex: 1;
  padding: 7px 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  font-family: ui-monospace, 'Cascadia Mono', Consolas, monospace;
  font-size: 13px;
}

.sql {
  min-height: 140px;
  height: 180px;
  padding: 12px 14px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: #1b1b20;
  color: #f2f1ee;
  font-family: ui-monospace, 'Cascadia Mono', Consolas, monospace;
  font-size: 12.5px;
  line-height: 1.6;
  resize: vertical;
}

.sql:focus {
  outline: 2px solid var(--accent);
  outline-offset: -1px;
}

.actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.primary {
  align-self: flex-start;
  padding: 7px 16px;
  border: none;
  border-radius: var(--radius-sm);
  background: var(--accent);
  color: #fff;
  font-weight: 600;
}

.ghost {
  padding: 6px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--surface);
  font-weight: 500;
}

.primary:disabled,
.ghost:disabled {
  opacity: 0.5;
}

.link {
  padding: 0 6px;
  border: none;
  background: none;
  color: var(--danger);
  font-size: 13px;
  text-decoration: underline;
}

.error {
  margin: 0;
  padding: 8px 12px;
  border-radius: var(--radius-sm);
  background: #fbeceb;
  color: var(--danger);
  font-family: ui-monospace, 'Cascadia Mono', Consolas, monospace;
  font-size: 12px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.grid {
  flex: 1;
  min-height: 120px;
}
</style>
