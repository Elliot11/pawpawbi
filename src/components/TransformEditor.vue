<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from 'vue';
import { errorMessage } from '../errors';
import type { TablePreview, TableSchema } from '../shared/types';
import DataGrid from './data/DataGrid.vue';

const props = defineProps<{
  table: string;
  /** All tables, for the reference panel. */
  tables: TableSchema[];
}>();
const emit = defineEmits<{ back: []; changed: [] }>();

const defaultSql = () => `SELECT *\nFROM ${props.table}`;

const sql = ref('');
const savedSql = ref<string | null>(null);
const preview = ref<TablePreview | null>(null);
const error = ref('');
const notice = ref('');
const busy = ref<'' | 'preview' | 'apply' | 'remove'>('');
const editor = ref<HTMLTextAreaElement | null>(null);
const expanded = ref<Set<string>>(new Set([props.table]));

const hasUnappliedChanges = computed(
  () => sql.value.trim() !== (savedSql.value ?? defaultSql()).trim(),
);

// The table being transformed first, then the rest.
const referenceTables = computed(() => [
  ...props.tables.filter((t) => t.name === props.table),
  ...props.tables.filter((t) => t.name !== props.table),
]);

onMounted(async () => {
  try {
    savedSql.value = await window.api.data.getTransform(props.table);
  } catch (err) {
    error.value = errorMessage(err);
  }
  sql.value = savedSql.value ?? defaultSql();
  editor.value?.focus();
  runPreview();
});

async function runPreview() {
  if (busy.value) return;
  busy.value = 'preview';
  error.value = '';
  notice.value = '';
  try {
    preview.value = await window.api.data.previewTransform(sql.value);
  } catch (err) {
    error.value = errorMessage(err);
  } finally {
    busy.value = '';
  }
}

async function apply() {
  if (busy.value) return;
  busy.value = 'apply';
  error.value = '';
  notice.value = '';
  try {
    const { rows } = await window.api.data.applyTransform(
      props.table,
      sql.value,
    );
    savedSql.value = sql.value;
    emit('changed');
    // Show the result of exactly what was applied, even if it wasn't previewed first.
    preview.value = await window.api.data.previewTransform(sql.value);
    notice.value = `Applied. ${props.table} now has ${rows.toLocaleString()} rows from this query.`;
  } catch (err) {
    error.value = errorMessage(err);
  } finally {
    busy.value = '';
  }
}

async function removeTransform() {
  if (busy.value) return;
  busy.value = 'remove';
  error.value = '';
  try {
    await window.api.data.removeTransform(props.table);
    savedSql.value = null;
    sql.value = defaultSql();
    notice.value = `Transform removed. ${props.table} is back to its original data.`;
    emit('changed');
  } catch (err) {
    error.value = errorMessage(err);
  } finally {
    busy.value = '';
  }
  runPreview();
}

function onKeydown(event: KeyboardEvent) {
  if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
    event.preventDefault();
    runPreview();
  } else if (event.key === 'Tab' && !event.shiftKey) {
    event.preventDefault();
    insert('  ');
  }
}

/** Inserts text at the cursor in the editor. */
async function insert(text: string) {
  const el = editor.value;
  if (!el) return;
  const start = el.selectionStart;
  sql.value =
    sql.value.slice(0, start) + text + sql.value.slice(el.selectionEnd);
  await nextTick();
  el.focus();
  el.selectionStart = el.selectionEnd = start + text.length;
}

function toggle(table: string) {
  const next = new Set(expanded.value);
  if (next.has(table)) next.delete(table);
  else next.add(table);
  expanded.value = next;
}

/** Column names that need quoting in SQL get double quotes. */
const sqlName = (name: string) =>
  /^[a-z_][a-z0-9_]*$/.test(name) ? name : `"${name.replace(/"/g, '""')}"`;
</script>

<template>
  <div class="transform">
    <header class="head">
      <button class="back" @click="$emit('back')">← Back to model</button>
      <h2>
        Transform <span class="table-name">{{ table }}</span>
      </h2>
      <span
        v-if="savedSql !== null"
        class="active-badge"
        title="This table currently shows the result of a SQL transform"
      >
        Transform active
      </span>
    </header>

    <div class="body">
      <aside class="reference" aria-label="Tables and columns">
        <p class="reference-hint">Click a name to insert it.</p>
        <ul>
          <li v-for="t in referenceTables" :key="t.name">
            <div class="ref-table">
              <button
                class="chevron"
                :aria-expanded="expanded.has(t.name)"
                :aria-label="`Show columns of ${t.name}`"
                @click="toggle(t.name)"
              >
                {{ expanded.has(t.name) ? '▾' : '▸' }}
              </button>
              <button
                class="ref-name"
                :title="`Insert ${t.name}`"
                @click="insert(t.name)"
              >
                {{ t.name }}
              </button>
            </div>
            <ul v-if="expanded.has(t.name)" class="ref-columns">
              <li v-for="c in t.columns" :key="c.name">
                <button
                  :title="`${c.name} (${c.type})`"
                  @click="insert(sqlName(c.name))"
                >
                  {{ c.name }}
                </button>
              </li>
            </ul>
          </li>
        </ul>
      </aside>

      <section class="work">
        <div class="editor-wrap">
          <textarea
            ref="editor"
            v-model="sql"
            class="editor"
            spellcheck="false"
            aria-label="SQL query"
            @keydown="onKeydown"
          ></textarea>
          <p class="editor-note">
            One SELECT query. It reads the original data, and can use any table
            by name (so joins work). DuckDB SQL.
          </p>
        </div>

        <div class="actions">
          <button
            class="ghost"
            :disabled="!!busy"
            title="Run (Ctrl+Enter)"
            @click="runPreview"
          >
            {{ busy === 'preview' ? 'Running…' : 'Run preview' }}
          </button>
          <button
            class="primary"
            :disabled="!!busy || (!hasUnappliedChanges && savedSql !== null)"
            @click="apply"
          >
            {{ busy === 'apply' ? 'Applying…' : 'Apply transform' }}
          </button>
          <button
            v-if="savedSql !== null"
            class="link"
            :disabled="!!busy"
            @click="removeTransform"
          >
            Remove transform
          </button>
          <span
            v-if="hasUnappliedChanges && savedSql !== null"
            class="unapplied"
            >Changes not applied yet</span
          >
        </div>

        <p v-if="error" class="error" role="alert">{{ error }}</p>
        <p v-else-if="notice" class="notice" role="status">{{ notice }}</p>

        <DataGrid v-if="preview" class="results" :preview="preview" />
      </section>
    </div>
  </div>
</template>

<style scoped>
.transform {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 18px;
  min-width: 0;
  padding: 28px 36px 32px;
}

.head {
  display: flex;
  align-items: center;
  gap: 14px;
}

.head h2 {
  font-size: 26px;
}

.table-name {
  color: var(--accent);
}

.active-badge {
  padding: 3px 10px;
  border-radius: 999px;
  background: #eaf6ee;
  color: #1d6b3a;
  font-size: 12px;
  font-weight: 600;
}

.back,
.ghost {
  padding: 7px 14px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--surface);
  font-weight: 500;
}

.back:hover,
.ghost:hover:not(:disabled) {
  border-color: var(--ink-faint);
}

.body {
  display: flex;
  flex: 1;
  gap: 18px;
  min-height: 0;
}

.reference {
  flex: none;
  width: 220px;
  overflow-y: auto;
  padding: 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface);
}

.reference ul {
  margin: 0;
  padding: 0;
  list-style: none;
}

.reference-hint {
  margin: 0 0 8px;
  color: var(--ink-faint);
  font-size: 11px;
}

.ref-table {
  display: flex;
  align-items: center;
}

.ref-table button,
.ref-columns button {
  border: none;
  background: none;
  text-align: left;
}

.chevron {
  width: 20px;
  padding: 2px 0;
  color: var(--ink-faint);
}

.ref-name {
  flex: 1;
  overflow: hidden;
  padding: 4px 6px;
  border-radius: 6px;
  font-weight: 700;
  font-size: 13px;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.ref-columns {
  margin: 0 0 6px 20px !important;
}

.ref-columns button {
  width: 100%;
  overflow: hidden;
  padding: 3px 6px;
  border-radius: 6px;
  color: var(--ink-muted);
  font-family: ui-monospace, 'Cascadia Mono', Consolas, monospace;
  font-size: 12px;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.ref-name:hover,
.ref-columns button:hover {
  background: var(--surface-muted);
  color: var(--ink);
}

.work {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 12px;
  min-width: 0;
  min-height: 0;
}

.editor {
  display: block;
  width: 100%;
  min-height: 160px;
  height: 200px;
  padding: 14px 16px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: #1b1b20;
  color: #f2f1ee;
  font-family: ui-monospace, 'Cascadia Mono', Consolas, monospace;
  font-size: 13px;
  line-height: 1.6;
  resize: vertical;
  tab-size: 2;
}

.editor:focus {
  outline: 2px solid var(--accent);
  outline-offset: -1px;
}

.editor-note {
  margin: 6px 0 0;
  color: var(--ink-faint);
  font-size: 12px;
}

.actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.primary {
  padding: 7px 16px;
  border: none;
  border-radius: var(--radius-sm);
  background: var(--accent);
  color: #fff;
  font-weight: 600;
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
  font-weight: 500;
  text-decoration: underline;
}

.unapplied {
  color: var(--ink-muted);
  font-size: 12px;
}

.error,
.notice {
  margin: 0;
  padding: 10px 14px;
  border-radius: var(--radius-sm);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.error {
  background: #fbeceb;
  color: var(--danger);
  font-family: ui-monospace, 'Cascadia Mono', Consolas, monospace;
  font-size: 12px;
}

.notice {
  background: #eaf6ee;
  color: #1d6b3a;
}

.results {
  flex: 1;
  min-height: 160px;
}
</style>
