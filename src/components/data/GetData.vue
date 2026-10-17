<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { errorMessage } from '../../errors';
import type { ConnectorCatalog, ConnectorInfo, DataSource } from '../../shared/types';
import ConnectorGallery from './ConnectorGallery.vue';
import SourceSetup from './SourceSetup.vue';
import TablePreview from './TablePreview.vue';

type View =
  | { name: 'overview' }
  | { name: 'gallery' }
  | { name: 'setup'; connector: ConnectorInfo; source?: DataSource }
  | { name: 'preview'; table: string; returnTo: View };

const view = ref<View>({ name: 'overview' });
const catalog = ref<ConnectorCatalog | null>(null);
const sources = ref<DataSource[]>([]);
const loading = ref(true);
const error = ref('');

// Refresh status per source: progress messages while running, or the last error.
const refreshing = ref<Record<string, string>>({});
const refreshErrors = ref<Record<string, string>>({});
const confirmingRemove = ref<string | null>(null);

const QUICK_PICKS = ['local_files', 'postgres', 'google_sheets', 'rest_api'];

const unsubscribe = window.api.data.onProgress((p) => {
  if (p.sourceId in refreshing.value) refreshing.value = { ...refreshing.value, [p.sourceId]: p.message };
});
onBeforeUnmount(unsubscribe);

onMounted(async () => {
  try {
    [catalog.value, sources.value] = await Promise.all([window.api.data.catalog(), window.api.data.listSources()]);
  } catch (err) {
    error.value = errorMessage(err);
  } finally {
    loading.value = false;
  }
});

const connectorFor = (type: string) => catalog.value?.connectors.find((c) => c.id === type);
const quickPicks = computed(() =>
  QUICK_PICKS.map((id) => connectorFor(id)).filter((c): c is ConnectorInfo => Boolean(c)),
);

async function reloadSources() {
  sources.value = await window.api.data.listSources();
}

async function finishSetup() {
  await reloadSources();
  view.value = { name: 'overview' };
}

async function cancelSetup() {
  // Connecting saves the source even if the user then cancels, so pick that up too.
  await reloadSources();
  view.value = { name: 'overview' };
}

async function refresh(source: DataSource) {
  refreshing.value = { ...refreshing.value, [source.id]: 'Starting…' };
  const { [source.id]: _, ...otherErrors } = refreshErrors.value;
  refreshErrors.value = otherErrors;
  try {
    await window.api.data.load(source.id, source.resources);
    await reloadSources();
  } catch (err) {
    refreshErrors.value = { ...refreshErrors.value, [source.id]: errorMessage(err) };
  } finally {
    const { [source.id]: __, ...rest } = refreshing.value;
    refreshing.value = rest;
  }
}

async function remove(source: DataSource) {
  confirmingRemove.value = null;
  try {
    await window.api.data.removeSource(source.id);
    await reloadSources();
  } catch (err) {
    refreshErrors.value = { ...refreshErrors.value, [source.id]: errorMessage(err) };
  }
}

function edit(source: DataSource) {
  const connector = connectorFor(source.type);
  if (connector) view.value = { name: 'setup', connector, source };
}

/** The data source that loaded a table. */
const sourceOf = (table: string) => sources.value.find((s) => s.tables.includes(table));

function editTableSource(table: string) {
  const source = sourceOf(table);
  if (source) edit(source);
}

async function previewFromSetup(table: string) {
  const returnTo = view.value;
  // The load just finished, so pick up its tables (this also shows the Edit source button).
  await reloadSources();
  view.value = { name: 'preview', table, returnTo };
}

const relativeTime = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
function timeAgo(iso: string) {
  const minutes = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  if (minutes < 60) return relativeTime.format(-minutes, 'minute');
  const hours = Math.round(minutes / 60);
  if (hours < 24) return relativeTime.format(-hours, 'hour');
  return relativeTime.format(-Math.round(hours / 24), 'day');
}
</script>

<template>
  <div class="get-data">
    <p v-if="loading" class="status">Loading connectors…</p>
    <p v-else-if="error" class="error" role="alert">Couldn't load the connector list: {{ error }}</p>

    <template v-else-if="catalog">
      <ConnectorGallery
        v-if="view.name === 'gallery'"
        :catalog="catalog"
        @choose="view = { name: 'setup', connector: $event }"
        @cancel="view = { name: 'overview' }"
      />

      <SourceSetup
        v-else-if="view.name === 'setup'"
        :connector="view.connector"
        :source="view.source"
        @done="finishSetup"
        @cancel="cancelSetup"
        @preview="previewFromSetup($event)"
      />

      <TablePreview
        v-else-if="view.name === 'preview'"
        :key="view.table"
        :table="view.table"
        :source-name="sourceOf(view.table)?.name"
        @back="view = view.returnTo"
        @edit="editTableSource(view.table)"
      />

      <!-- Overview -->
      <div v-else class="overview">
        <header class="head">
          <div>
            <h2>Data</h2>
            <p>Connect to your data. Each source loads into tables inside this project.</p>
          </div>
          <button v-if="sources.length" class="primary" @click="view = { name: 'gallery' }">+ Add data source</button>
        </header>

        <div v-if="sources.length === 0" class="empty">
          <h3>Where does your data live?</h3>
          <p>Choose a source to get started, or browse all {{ catalog.connectors.length }} connectors.</p>
          <div class="quick">
            <button v-for="c in quickPicks" :key="c.id" class="quick-card" @click="view = { name: 'setup', connector: c }">
              <span class="monogram" aria-hidden="true">{{ c.name.charAt(0) }}</span>
              {{ c.name }}
            </button>
          </div>
          <button class="primary" @click="view = { name: 'gallery' }">Browse all connectors</button>
        </div>

        <ul v-else class="sources">
          <li v-for="s in sources" :key="s.id" class="source">
            <div class="source-head">
              <span class="monogram" aria-hidden="true">{{ s.name.charAt(0) }}</span>
              <div class="source-text">
                <strong>{{ s.name }}</strong>
                <small>
                  {{ connectorFor(s.type)?.name ?? s.type }} ·
                  <template v-if="refreshing[s.id]">{{ refreshing[s.id] }}</template>
                  <template v-else-if="s.lastLoadedAt">
                    {{ s.tables.length }} {{ s.tables.length === 1 ? 'table' : 'tables' }}, loaded {{ timeAgo(s.lastLoadedAt) }}
                  </template>
                  <template v-else>Not loaded yet</template>
                </small>
              </div>

              <div v-if="confirmingRemove === s.id" class="source-actions confirm">
                <span>Remove this source and its tables?</span>
                <button class="danger" @click="remove(s)">Remove</button>
                <button class="ghost" @click="confirmingRemove = null">Keep</button>
              </div>
              <div v-else class="source-actions">
                <button class="ghost" :disabled="s.id in refreshing" @click="refresh(s)">
                  {{ s.id in refreshing ? 'Loading…' : s.lastLoadedAt ? 'Refresh' : 'Load' }}
                </button>
                <button class="ghost" :disabled="s.id in refreshing" @click="edit(s)">Edit</button>
                <button class="ghost" :disabled="s.id in refreshing" @click="confirmingRemove = s.id">Remove</button>
              </div>
            </div>

            <p v-if="refreshErrors[s.id]" class="error" role="alert">{{ refreshErrors[s.id] }}</p>

            <div v-if="s.tables.length" class="table-chips">
              <button
                v-for="t in s.tables"
                :key="t"
                class="chip"
                @click="view = { name: 'preview', table: t, returnTo: { name: 'overview' } }"
              >
                {{ t }}
              </button>
            </div>
          </li>
        </ul>
      </div>
    </template>
  </div>
</template>

<style scoped>
.get-data {
  width: 100%;
  max-width: 1100px;
  margin: 0 auto;
  padding: 32px 36px 48px;
}

.status {
  color: var(--ink-muted);
}

.error {
  margin: 8px 0 0;
  padding: 10px 14px;
  border-radius: var(--radius-sm);
  background: #fbeceb;
  color: var(--danger);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.overview {
  display: flex;
  flex-direction: column;
  gap: 22px;
}

.head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}

.head h2 {
  font-size: 30px;
}

.head p {
  margin: 6px 0 0;
  color: var(--ink-muted);
}

.primary {
  padding: 9px 18px;
  border: none;
  border-radius: var(--radius-sm);
  background: var(--accent);
  color: #fff;
  font-weight: 600;
  white-space: nowrap;
}

.ghost {
  padding: 6px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--surface);
  font-size: 13px;
  font-weight: 500;
}

.ghost:hover:not(:disabled) {
  border-color: var(--ink-faint);
}

.ghost:disabled {
  opacity: 0.5;
}

.danger {
  padding: 6px 12px;
  border: none;
  border-radius: var(--radius-sm);
  background: var(--danger);
  color: #fff;
  font-size: 13px;
  font-weight: 600;
}

.empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 14px;
  padding: 48px 24px;
  border: 1px dashed var(--border);
  border-radius: var(--radius-lg);
  background: var(--surface);
  text-align: center;
}

.empty h3 {
  font-size: 22px;
}

.empty p {
  margin: 0;
  color: var(--ink-muted);
}

.quick {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 10px;
  margin: 8px 0;
}

.quick-card {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 16px 10px 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface);
  font-weight: 600;
  transition:
    border-color 0.15s,
    box-shadow 0.15s;
}

.quick-card:hover {
  border-color: var(--ink-faint);
  box-shadow: var(--shadow-md);
}

.monogram {
  display: grid;
  place-items: center;
  flex: none;
  width: 34px;
  height: 34px;
  border-radius: 10px;
  background: var(--accent-soft);
  color: var(--accent);
  font-family: var(--font-display);
  font-weight: 900;
  font-size: 15px;
}

.sources {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.source {
  padding: 14px 16px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface);
  box-shadow: var(--shadow-sm);
}

.source-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
}

.source-text {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-width: 200px;
}

.source-text strong {
  font-weight: 700;
}

.source-text small {
  color: var(--ink-muted);
  font-size: 12px;
}

.source-actions {
  display: flex;
  align-items: center;
  gap: 6px;
}

.confirm span {
  color: var(--ink-muted);
  font-size: 13px;
}

.table-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px solid var(--border);
}

.chip {
  padding: 4px 10px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--bg);
  font-family: ui-monospace, 'Cascadia Mono', Consolas, monospace;
  font-size: 12px;
}

.chip:hover {
  border-color: var(--accent);
  color: var(--accent);
}
</style>
