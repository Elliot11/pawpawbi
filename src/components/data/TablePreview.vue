<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { errorMessage } from '../../errors';
import type { TablePreview } from '../../shared/types';

const props = defineProps<{ table: string }>();
defineEmits<{ back: [] }>();

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

.back {
  padding: 6px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--surface);
  font-weight: 500;
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
