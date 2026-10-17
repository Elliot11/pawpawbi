<script setup lang="ts">
import { computed, onActivated, onMounted, ref } from 'vue';
import { errorMessage } from '../errors';
import type { ColumnKind, DataSource, TableSchema } from '../shared/types';

defineEmits<{ addData: [] }>();

const tables = ref<TableSchema[]>([]);
const sources = ref<DataSource[]>([]);
const loading = ref(true);
const error = ref('');

async function load() {
  error.value = '';
  try {
    [tables.value, sources.value] = await Promise.all([
      window.api.data.describeTables(),
      window.api.data.listSources(),
    ]);
  } catch (err) {
    error.value = errorMessage(err);
  } finally {
    loading.value = false;
  }
}

// Kept alive between workflow steps, so reload whenever the screen is shown: data may have
// been added or refreshed in the meantime.
onMounted(load);
onActivated(load);

const sourceByTable = computed(() => {
  const map = new Map<string, string>();
  for (const s of sources.value) for (const t of s.tables) map.set(t, s.name);
  return map;
});

/** dlt splits nested data into child tables named parent__child. */
const parentOf = (table: string) => (table.includes('__') ? table.slice(0, table.lastIndexOf('__')) : null);

const BADGES: Record<ColumnKind, { label: string; title: string }> = {
  integer: { label: '123', title: 'Whole number' },
  decimal: { label: '1.2', title: 'Decimal number' },
  text: { label: 'Abc', title: 'Text' },
  boolean: { label: 'T/F', title: 'True or false' },
  date: { label: 'Date', title: 'Date' },
  datetime: { label: 'Time', title: 'Date and time' },
  time: { label: 'Time', title: 'Time of day' },
  nested: { label: '{ }', title: 'Nested data' },
  other: { label: '?', title: 'Other' },
};

const totalColumns = computed(() => tables.value.reduce((sum, t) => sum + t.columns.length, 0));
</script>

<template>
  <div class="model">
    <header class="head">
      <h2>Model data</h2>
      <p v-if="tables.length">
        {{ tables.length }} {{ tables.length === 1 ? 'table' : 'tables' }} ·
        {{ totalColumns }} columns
      </p>
    </header>

    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <p v-else-if="loading" class="status">Loading tables…</p>

    <div v-else-if="tables.length === 0" class="empty">
      <div class="empty-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24"><path d="M3 4h7v6H3zM14 14h7v6h-7zM6.5 10v4a3 3 0 0 0 3 3H14" /></svg>
      </div>
      <h3>No tables yet</h3>
      <p>Add data first. Each table you load will appear here with its columns.</p>
      <button class="primary" @click="$emit('addData')">Add data</button>
    </div>

    <div v-else class="grid">
      <article v-for="t in tables" :key="t.name" class="table-card">
        <header class="card-head">
          <h3 :title="t.name">{{ t.name }}</h3>
          <small>
            <template v-if="parentOf(t.name)">Nested in {{ parentOf(t.name) }}</template>
            <template v-else>{{ sourceByTable.get(t.name) ?? 'Unknown source' }}</template>
            · {{ t.rows.toLocaleString() }} rows
          </small>
        </header>
        <ul class="columns" :aria-label="`Columns in ${t.name}`">
          <li v-for="c in t.columns" :key="c.name" :title="`${c.name} (${c.type})`">
            <span class="badge" :class="c.kind" :title="BADGES[c.kind].title">{{ BADGES[c.kind].label }}</span>
            <span class="column-name">{{ c.name }}</span>
          </li>
        </ul>
        <footer class="card-foot">{{ t.columns.length }} {{ t.columns.length === 1 ? 'column' : 'columns' }}</footer>
      </article>
    </div>
  </div>
</template>

<style scoped>
.model {
  width: 100%;
  padding: 32px 36px 48px;
  background-image: radial-gradient(var(--border) 1px, transparent 1px);
  background-size: 20px 20px;
}

.head {
  display: flex;
  align-items: baseline;
  gap: 14px;
  margin-bottom: 22px;
}

.head h2 {
  font-size: 30px;
}

.head p {
  margin: 0;
  color: var(--ink-muted);
}

.status {
  color: var(--ink-muted);
}

.error {
  padding: 10px 14px;
  border-radius: var(--radius-sm);
  background: #fbeceb;
  color: var(--danger);
}

.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(230px, 1fr));
  align-items: start;
  gap: 16px;
}

.table-card {
  display: flex;
  flex-direction: column;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface);
  box-shadow: var(--shadow-sm);
  overflow: hidden;
}

.card-head {
  padding: 12px 14px 10px;
  border-top: 3px solid var(--accent);
  border-bottom: 1px solid var(--border);
}

.card-head h3 {
  overflow: hidden;
  font-size: 15px;
  font-weight: 800;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.card-head small {
  display: block;
  margin-top: 2px;
  overflow: hidden;
  color: var(--ink-muted);
  font-size: 12px;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.columns {
  max-height: 260px;
  margin: 0;
  padding: 6px;
  overflow-y: auto;
  list-style: none;
}

.columns li {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 8px;
  border-radius: 6px;
  font-size: 13px;
}

.columns li:hover {
  background: var(--surface-muted);
}

.column-name {
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.badge {
  flex: none;
  width: 34px;
  padding: 1px 0;
  border-radius: 4px;
  background: var(--surface-muted);
  color: var(--ink-muted);
  font-size: 10px;
  font-weight: 700;
  text-align: center;
}

.badge.integer,
.badge.decimal {
  background: #e8f0fb;
  color: #2a5ea8;
}

.badge.text {
  background: #f1ecf8;
  color: #6b46a3;
}

.badge.date,
.badge.datetime,
.badge.time {
  background: #eaf6ee;
  color: #1d6b3a;
}

.badge.boolean {
  background: var(--accent-soft);
  color: var(--accent);
}

.card-foot {
  padding: 7px 14px;
  border-top: 1px solid var(--border);
  color: var(--ink-faint);
  font-size: 11px;
}

.empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  max-width: 380px;
  margin: 60px auto 0;
  text-align: center;
}

.empty-icon {
  display: grid;
  place-items: center;
  width: 56px;
  height: 56px;
  border: 1px solid var(--border);
  border-radius: 16px;
  background: var(--surface);
  box-shadow: var(--shadow-sm);
}

.empty-icon svg {
  width: 26px;
  height: 26px;
  fill: none;
  stroke: var(--ink-muted);
  stroke-width: 1.75;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.empty h3 {
  font-size: 22px;
}

.empty p {
  margin: 0;
  color: var(--ink-muted);
}

.primary {
  margin-top: 6px;
  padding: 9px 18px;
  border: none;
  border-radius: var(--radius-sm);
  background: var(--accent);
  color: #fff;
  font-weight: 600;
}
</style>
