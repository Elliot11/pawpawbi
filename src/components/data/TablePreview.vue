<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { errorMessage } from '../../errors';
import type { TablePreview } from '../../shared/types';

const props = defineProps<{
  table: string;
  /** Name of the data source the table came from; shows an Edit button when set. */
  sourceName?: string;
}>();
defineEmits<{ back: []; edit: [] }>();

const PREVIEW_ROWS = 200;
const preview = ref<TablePreview | null>(null);
const error = ref('');

onMounted(async () => {
  try {
    preview.value = await window.api.data.previewTable(props.table, PREVIEW_ROWS);
  } catch (err) {
    error.value = errorMessage(err);
  }
});

const format = (value: unknown) =>
  value === null || value === undefined ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
</script>

<template>
  <div class="preview">
    <header class="head">
      <button class="back" @click="$emit('back')">← Back</button>
      <h2>{{ table }}</h2>
      <span v-if="preview" class="meta">
        {{ preview.row_count.toLocaleString() }} rows · {{ preview.columns.length }} columns
      </span>
      <button v-if="sourceName" class="edit" :title="`Edit the ${sourceName} data source`" @click="$emit('edit')">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" /></svg>
        Edit source
      </button>
    </header>

    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <p v-else-if="!preview" class="loading">Loading preview…</p>

    <template v-else>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th v-for="c in preview.columns" :key="c.name">
                {{ c.name }}
                <small>{{ c.dtype }}</small>
              </th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(row, i) in preview.rows" :key="i">
              <td v-for="(value, j) in row" :key="j" :class="{ empty: value === null }">{{ format(value) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p v-if="preview.row_count > preview.rows.length" class="more">
        Showing the first {{ preview.rows.length.toLocaleString() }} rows.
      </p>
    </template>
  </div>
</template>

<style scoped>
.preview {
  display: flex;
  flex-direction: column;
  gap: 14px;
  min-height: 0;
}

.head {
  display: flex;
  align-items: baseline;
  gap: 14px;
}

.head h2 {
  font-size: 24px;
  overflow-wrap: anywhere;
}

.meta {
  color: var(--ink-muted);
  font-size: 13px;
  white-space: nowrap;
}

.back,
.edit {
  padding: 6px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--surface);
  font-weight: 500;
}

.back:hover,
.edit:hover {
  border-color: var(--ink-faint);
}

.edit {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-left: auto;
  align-self: center;
  white-space: nowrap;
}

.edit svg {
  width: 15px;
  height: 15px;
  fill: none;
  stroke: currentColor;
  stroke-width: 2;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.table-wrap {
  max-height: calc(100vh - 220px);
  overflow: auto;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface);
}

table {
  border-collapse: collapse;
  font-size: 13px;
  font-variant-numeric: tabular-nums;
}

th,
td {
  max-width: 320px;
  padding: 7px 12px;
  border-bottom: 1px solid var(--border);
  overflow: hidden;
  white-space: nowrap;
  text-align: left;
  text-overflow: ellipsis;
}

th {
  position: sticky;
  top: 0;
  background: var(--surface-muted);
  font-weight: 700;
}

th small {
  display: block;
  color: var(--ink-faint);
  font-weight: 500;
  font-size: 11px;
}

td.empty::after {
  content: 'null';
  color: var(--ink-faint);
  font-style: italic;
}

tbody tr:hover {
  background: var(--bg);
}

.error {
  padding: 10px 14px;
  border-radius: var(--radius-sm);
  background: #fbeceb;
  color: var(--danger);
}

.loading,
.more {
  margin: 0;
  color: var(--ink-muted);
}
</style>
