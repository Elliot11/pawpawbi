<script setup lang="ts">
import { computed, onActivated, onBeforeUnmount, onMounted, ref } from 'vue';
import { errorMessage } from '../errors';
import { plain } from '../plain';
import type { ColumnKind, DataSource, TableSchema } from '../shared/types';
import TransformEditor from './TransformEditor.vue';

defineEmits<{ addData: [] }>();

type Point = { x: number; y: number };

// Layout for tables that haven't been placed yet: a grid of cards.
const CARD_WIDTH = 240;
const GRID_GAP = 48;
const GRID_ROW_HEIGHT = 400;
const GRID_COLUMNS = 4;
const GRID_ORIGIN: Point = { x: 48, y: 120 };
const MIN_ZOOM = 0.3;
const MAX_ZOOM = 1.6;

const tables = ref<TableSchema[]>([]);
const sources = ref<DataSource[]>([]);
const loading = ref(true);
const error = ref('');

const positions = ref<Record<string, Point>>({});
/** Draw order: the last table is on top. */
const stacking = ref<string[]>([]);
const pan = ref<Point>({ x: 0, y: 0 });
const zoom = ref(1);

const viewport = ref<HTMLElement | null>(null);
const cardElements = new Map<string, HTMLElement>();

async function load() {
  error.value = '';
  try {
    const [schemas, sourceList, diagram] = await Promise.all([
      window.api.data.describeTables(),
      window.api.data.listSources(),
      window.api.data.loadDiagram(),
    ]);
    tables.value = schemas;
    sources.value = sourceList;
    positions.value = { ...diagram.tables };
    placeNewTables();
    stacking.value = schemas.map((t) => t.name);
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

// --- Refreshing every data source ---------------------------------------------------------------

const refreshing = ref(false);
const refreshStatus = ref('');
const refreshResult = ref<{ ok: boolean; message: string } | null>(null);
let refreshingSource: { id: string; label: string } | null = null;

const unsubscribeProgress = window.api.data.onProgress((p) => {
  if (refreshingSource && p.sourceId === refreshingSource.id) {
    refreshStatus.value = `${refreshingSource.label}: ${p.message}`;
  }
});
onBeforeUnmount(unsubscribeProgress);

/** Reloads every data source in turn, then the tables on the canvas. */
async function refreshAll() {
  if (refreshing.value) return;
  refreshing.value = true;
  refreshResult.value = null;
  const failed: string[] = [];
  const transformFailed: string[] = [];
  try {
    const all = await window.api.data.listSources();
    for (const [i, source] of all.entries()) {
      refreshingSource = { id: source.id, label: `${source.name} (${i + 1} of ${all.length})` };
      refreshStatus.value = `${refreshingSource.label}: starting…`;
      try {
        const loaded = await window.api.data.load(source.id, plain(source.resources));
        transformFailed.push(...loaded.filter((t) => t.transformError).map((t) => t.name));
      } catch (err) {
        failed.push(`${source.name}: ${errorMessage(err)}`);
      }
    }
    const problems = [
      ...failed,
      ...(transformFailed.length
        ? [`SQL transform failed for ${transformFailed.join(', ')}; showing original data`]
        : []),
    ];
    refreshResult.value = problems.length
      ? { ok: false, message: `Some data couldn't be refreshed. ${problems.join('. ')}.` }
      : { ok: true, message: `Refreshed ${all.length} ${all.length === 1 ? 'data source' : 'data sources'}.` };
  } catch (err) {
    refreshResult.value = { ok: false, message: errorMessage(err) };
  } finally {
    refreshingSource = null;
    refreshing.value = false;
    await load();
  }
}

/** Puts tables without a saved position in a grid below the ones that have one. */
function placeNewTables() {
  const placed = tables.value.filter((t) => positions.value[t.name]);
  const unplaced = tables.value.filter((t) => !positions.value[t.name]);
  const top = placed.length
    ? Math.max(...placed.map((t) => positions.value[t.name].y)) +
      GRID_ROW_HEIGHT
    : GRID_ORIGIN.y;
  unplaced.forEach((t, i) => {
    positions.value[t.name] = {
      x: GRID_ORIGIN.x + (i % GRID_COLUMNS) * (CARD_WIDTH + GRID_GAP),
      y: top + Math.floor(i / GRID_COLUMNS) * GRID_ROW_HEIGHT,
    };
  });
}

async function saveLayout() {
  const layout = Object.fromEntries(
    tables.value.map((t) => [t.name, positions.value[t.name]]),
  );
  try {
    await window.api.data.saveDiagram(plain({ tables: layout }));
  } catch (err) {
    error.value = errorMessage(err);
  }
}

// --- Table actions ------------------------------------------------------------------------------

/** The table whose SQL transform is open, if any. */
const transforming = ref<string | null>(null);
const confirmingDelete = ref<string | null>(null);

async function deleteTable(table: string) {
  confirmingDelete.value = null;
  try {
    await window.api.data.deleteTable(table);
    await load();
  } catch (err) {
    error.value = errorMessage(err);
  }
}

function tidyUp() {
  positions.value = {};
  placeNewTables();
  saveLayout();
  fitToScreen();
}

// --- Dragging tables and panning ------------------------------------------------------------

type Drag =
  | {
      kind: 'table';
      table: string;
      start: Point;
      origin: Point;
      moved: boolean;
    }
  | { kind: 'pan'; start: Point; origin: Point };
const drag = ref<Drag | null>(null);

function bringToFront(table: string) {
  stacking.value = [...stacking.value.filter((t) => t !== table), table];
}

function startTableDrag(event: PointerEvent, table: string) {
  if (event.button !== 0) return;
  event.preventDefault();
  bringToFront(table);
  drag.value = {
    kind: 'table',
    table,
    start: { x: event.clientX, y: event.clientY },
    origin: { ...positions.value[table] },
    moved: false,
  };
  listenForDrag();
}

function startPan(event: PointerEvent) {
  // Left or middle button on the empty canvas.
  if (event.button !== 0 && event.button !== 1) return;
  event.preventDefault();
  drag.value = {
    kind: 'pan',
    start: { x: event.clientX, y: event.clientY },
    origin: { ...pan.value },
  };
  listenForDrag();
}

function onDragMove(event: PointerEvent) {
  const d = drag.value;
  if (!d) return;
  const dx = event.clientX - d.start.x;
  const dy = event.clientY - d.start.y;
  if (d.kind === 'table') {
    d.moved ||= Math.abs(dx) + Math.abs(dy) > 2;
    positions.value[d.table] = {
      x: Math.round(d.origin.x + dx / zoom.value),
      y: Math.round(d.origin.y + dy / zoom.value),
    };
  } else {
    pan.value = { x: d.origin.x + dx, y: d.origin.y + dy };
  }
}

function onDragEnd() {
  const d = drag.value;
  drag.value = null;
  window.removeEventListener('pointermove', onDragMove);
  window.removeEventListener('pointerup', onDragEnd);
  if (d?.kind === 'table' && d.moved) saveLayout();
}

function listenForDrag() {
  window.addEventListener('pointermove', onDragMove);
  window.addEventListener('pointerup', onDragEnd);
}

onBeforeUnmount(onDragEnd);

// --- Zoom ----------------------------------------------------------------------------------------

const clampZoom = (value: number) =>
  Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value));

/** Zooms keeping the canvas point under (clientX, clientY) in place. */
function zoomAt(clientX: number, clientY: number, nextZoom: number) {
  const rect = viewport.value!.getBoundingClientRect();
  const screen = { x: clientX - rect.left, y: clientY - rect.top };
  const world = {
    x: (screen.x - pan.value.x) / zoom.value,
    y: (screen.y - pan.value.y) / zoom.value,
  };
  zoom.value = clampZoom(nextZoom);
  pan.value = {
    x: screen.x - world.x * zoom.value,
    y: screen.y - world.y * zoom.value,
  };
}

function zoomBy(factor: number) {
  const rect = viewport.value!.getBoundingClientRect();
  zoomAt(
    rect.left + rect.width / 2,
    rect.top + rect.height / 2,
    zoom.value * factor,
  );
}

function onWheel(event: WheelEvent) {
  // Let a table's column list scroll when the pointer is over it.
  const list = (event.target as Element).closest('.columns');
  if (!event.ctrlKey && list && list.scrollHeight > list.clientHeight) return;
  event.preventDefault();
  if (event.ctrlKey || event.metaKey) {
    zoomAt(
      event.clientX,
      event.clientY,
      zoom.value * Math.exp(-event.deltaY * 0.002),
    );
  } else {
    pan.value = {
      x: pan.value.x - event.deltaX,
      y: pan.value.y - event.deltaY,
    };
  }
}

/** Zooms and pans so every table is visible. */
function fitToScreen() {
  if (!viewport.value || tables.value.length === 0) return;
  let left = Infinity,
    top = Infinity,
    right = -Infinity,
    bottom = -Infinity;
  for (const t of tables.value) {
    const p = positions.value[t.name];
    const height = cardElements.get(t.name)?.offsetHeight ?? GRID_ROW_HEIGHT;
    left = Math.min(left, p.x);
    top = Math.min(top, p.y);
    right = Math.max(right, p.x + CARD_WIDTH);
    bottom = Math.max(bottom, p.y + height);
  }
  const padding = 48;
  const { clientWidth, clientHeight } = viewport.value;
  zoom.value = clampZoom(
    Math.min(
      1,
      (clientWidth - padding * 2) / (right - left),
      (clientHeight - padding * 2 - 60) / (bottom - top),
    ),
  );
  pan.value = {
    x: (clientWidth - (right - left) * zoom.value) / 2 - left * zoom.value,
    y:
      60 +
      (clientHeight - 60 - (bottom - top) * zoom.value) / 2 -
      top * zoom.value,
  };
}

// --- Display ----------------------------------------------------------------------------------

const sourceByTable = computed(() => {
  const map = new Map<string, string>();
  for (const s of sources.value) for (const t of s.tables) map.set(t, s.name);
  return map;
});

/** dlt splits nested data into child tables named parent__child. */
const parentOf = (table: string) =>
  table.includes('__') ? table.slice(0, table.lastIndexOf('__')) : null;

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

const totalColumns = computed(() =>
  tables.value.reduce((sum, t) => sum + t.columns.length, 0),
);

function setCardElement(table: string, element: unknown) {
  if (element instanceof HTMLElement) cardElements.set(table, element);
  else cardElements.delete(table);
}
</script>

<template>
  <div class="model">
    <TransformEditor
      v-if="transforming"
      :key="transforming"
      :table="transforming"
      :tables="tables"
      @back="transforming = null"
      @changed="load"
    />

    <template v-else>
      <p v-if="error" class="error" role="alert">{{ error }}</p>

      <div v-if="loading" class="centered status">Loading tables…</div>

      <div v-else-if="tables.length === 0 && !error" class="centered empty">
        <div class="empty-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24">
            <path d="M3 4h7v6H3zM14 14h7v6h-7zM6.5 10v4a3 3 0 0 0 3 3H14" />
          </svg>
        </div>
        <h3>No tables yet</h3>
        <p>
          Add data first. Each table you load will appear here with its columns.
        </p>
        <button class="primary" @click="$emit('addData')">Add data</button>
      </div>

      <div
        v-else
        ref="viewport"
        class="viewport"
        :class="{
          panning: drag?.kind === 'pan',
          dragging: drag?.kind === 'table',
        }"
        :style="{
          backgroundPosition: `${pan.x}px ${pan.y}px`,
          backgroundSize: `${20 * zoom}px ${20 * zoom}px`,
        }"
        @pointerdown="startPan"
        @wheel="onWheel"
      >
        <div
          class="world"
          :style="{
            transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
          }"
        >
          <!-- Relationship lines between tables will be drawn here, underneath the cards, in the
             same coordinates as the cards' positions. -->
          <svg class="links" aria-hidden="true"></svg>

          <article
            v-for="t in tables"
            :key="t.name"
            :ref="(el) => setCardElement(t.name, el)"
            class="table-card"
            :data-table="t.name"
            :style="{
              left: `${positions[t.name]?.x ?? 0}px`,
              top: `${positions[t.name]?.y ?? 0}px`,
              width: `${CARD_WIDTH}px`,
              zIndex: stacking.indexOf(t.name) + 1,
            }"
            @pointerdown.stop="bringToFront(t.name)"
          >
            <header
              class="card-head"
              title="Drag to move"
              @pointerdown="startTableDrag($event, t.name)"
            >
              <h3 :title="t.name">{{ t.name }}</h3>
              <small>
                <template v-if="parentOf(t.name)"
                  >Nested in {{ parentOf(t.name) }}</template
                >
                <template v-else>{{
                  sourceByTable.get(t.name) ?? 'Unknown source'
                }}</template>
                · {{ t.rows.toLocaleString() }} rows
              </small>
            </header>
            <div class="card-tools">
              <template v-if="confirmingDelete === t.name">
                <span
                  class="confirm-text"
                  title="Refreshing its data source will load it again"
                  >Delete this table?</span
                >
                <button class="tool danger-solid" @click="deleteTable(t.name)">
                  Delete
                </button>
                <button class="tool" @click="confirmingDelete = null">
                  Cancel
                </button>
              </template>
              <template v-else>
                <button
                  class="tool"
                  :class="{ active: t.transformed }"
                  :title="
                    t.transformed
                      ? 'A SQL transform is active. Click to edit it.'
                      : 'Transform this table with SQL'
                  "
                  @click="transforming = t.name"
                >
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M8 6l-6 6 6 6M16 6l6 6-6 6" />
                  </svg>
                  {{ t.transformed ? 'Transformed' : 'Transform' }}
                </button>
                <button
                  class="tool delete"
                  title="Delete this table"
                  @click="confirmingDelete = t.name"
                >
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path
                      d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"
                    />
                  </svg>
                  Delete
                </button>
              </template>
            </div>
            <ul class="columns" :aria-label="`Columns in ${t.name}`">
              <li
                v-for="c in t.columns"
                :key="c.name"
                :data-column="c.name"
                :title="`${c.name} (${c.type})`"
              >
                <span
                  class="badge"
                  :class="c.kind"
                  :title="BADGES[c.kind].title"
                  >{{ BADGES[c.kind].label }}</span
                >
                <span class="column-name">{{ c.name }}</span>
              </li>
            </ul>
            <footer class="card-foot">
              {{ t.columns.length }}
              {{ t.columns.length === 1 ? 'column' : 'columns' }}
            </footer>
          </article>
        </div>

        <header class="overlay title" @pointerdown.stop>
          <h2>Model data</h2>
          <p>
            {{ tables.length }} {{ tables.length === 1 ? 'table' : 'tables' }} ·
            {{ totalColumns }} columns
          </p>
        </header>

        <div class="overlay refresh-area" @pointerdown.stop>
          <button
            class="refresh"
            :disabled="refreshing"
            title="Reload the data from every data source"
            @click="refreshAll"
          >
            <svg
              viewBox="0 0 24 24"
              aria-hidden="true"
              :class="{ spinning: refreshing }"
            >
              <path d="M21 12a9 9 0 1 1-2.6-6.4M21 4v5h-5" />
            </svg>
            {{ refreshing ? 'Refreshing…' : 'Refresh all data' }}
          </button>
          <p v-if="refreshing" class="refresh-status" aria-live="polite">
            {{ refreshStatus }}
          </p>
          <p
            v-else-if="refreshResult"
            class="refresh-result"
            :class="{ failed: !refreshResult.ok }"
            role="status"
          >
            {{ refreshResult.message }}
            <button
              class="dismiss"
              aria-label="Dismiss"
              @click="refreshResult = null"
            >
              ×
            </button>
          </p>
        </div>

        <div
          class="overlay toolbar"
          role="toolbar"
          aria-label="Canvas"
          @pointerdown.stop
        >
          <button
            title="Zoom out"
            aria-label="Zoom out"
            @click="zoomBy(1 / 1.2)"
          >
            −
          </button>
          <span class="zoom-level">{{ Math.round(zoom * 100) }}%</span>
          <button title="Zoom in" aria-label="Zoom in" @click="zoomBy(1.2)">
            +
          </button>
          <span class="sep" aria-hidden="true"></span>
          <button title="Show all tables" @click="fitToScreen">Fit</button>
          <button title="Arrange tables in a grid" @click="tidyUp">
            Tidy up
          </button>
        </div>

        <p class="overlay hint" @pointerdown.stop>
          Drag tables by their name · drag the background to pan · Ctrl + scroll
          to zoom
        </p>
      </div>
    </template>
  </div>
</template>

<style scoped>
.model {
  position: relative;
  display: flex;
  flex: 1;
  min-width: 0;
}

.viewport {
  position: relative;
  flex: 1;
  overflow: hidden;
  background-image: radial-gradient(var(--border) 1px, transparent 1px);
  cursor: grab;
  touch-action: none;
  user-select: none;
}

.viewport.panning {
  cursor: grabbing;
}

.world {
  position: absolute;
  top: 0;
  left: 0;
  transform-origin: 0 0;
}

.links {
  position: absolute;
  top: 0;
  left: 0;
  overflow: visible;
  pointer-events: none;
}

.table-card {
  position: absolute;
  display: flex;
  flex-direction: column;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface);
  box-shadow: var(--shadow-sm);
  overflow: hidden;
  cursor: default;
  transition: box-shadow 0.15s;
}

.table-card:hover {
  box-shadow: var(--shadow-md);
}

.card-head {
  padding: 12px 14px 10px;
  border-top: 3px solid var(--accent);
  border-bottom: 1px solid var(--border);
  cursor: grab;
}

.viewport.dragging .card-head {
  cursor: grabbing;
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

.card-tools {
  display: flex;
  align-items: center;
  gap: 4px;
  min-height: 38px;
  padding: 5px 8px;
  border-bottom: 1px solid var(--border);
  background: var(--bg);
}

.tool {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 4px 8px;
  border: none;
  border-radius: 6px;
  background: none;
  color: var(--ink-muted);
  font-size: 12px;
  font-weight: 600;
}

.tool:hover {
  background: var(--surface-muted);
  color: var(--ink);
}

.tool svg {
  width: 14px;
  height: 14px;
  fill: none;
  stroke: currentColor;
  stroke-width: 2;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.tool.delete {
  margin-left: auto;
}

.tool.delete:hover {
  background: #fbeceb;
  color: var(--danger);
}

.tool.danger-solid {
  margin-left: auto;
  background: var(--danger);
  color: #fff;
}

.confirm-text {
  padding-left: 4px;
  color: var(--ink);
  font-size: 12px;
  font-weight: 600;
}

/* A transform is active on this table. */
.tool.active,
.tool.active:hover {
  background: #eaf6ee;
  color: #1d6b3a;
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

.overlay {
  position: absolute;
  z-index: 10000;
  cursor: default;
}

.title {
  top: 24px;
  left: 36px;
  display: flex;
  align-items: baseline;
  gap: 14px;
  padding: 4px 10px 4px 0;
  border-radius: var(--radius-sm);
  background: color-mix(in srgb, var(--bg) 85%, transparent);
}

.title h2 {
  font-size: 30px;
}

.title p {
  margin: 0;
  color: var(--ink-muted);
}

.refresh-area {
  top: 28px;
  right: 24px;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 8px;
  max-width: 420px;
}

.refresh {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 8px 14px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--surface);
  box-shadow: var(--shadow-sm);
  font-weight: 600;
  white-space: nowrap;
}

.refresh:hover:not(:disabled) {
  border-color: var(--ink-faint);
}

.refresh:disabled {
  color: var(--ink-muted);
}

.refresh svg {
  width: 16px;
  height: 16px;
  fill: none;
  stroke: currentColor;
  stroke-width: 2;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.spinning {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

.refresh-status,
.refresh-result {
  margin: 0;
  padding: 8px 12px;
  border-radius: var(--radius-sm);
  font-size: 13px;
  overflow-wrap: anywhere;
}

.refresh-status {
  background: var(--surface);
  color: var(--ink-muted);
  box-shadow: var(--shadow-sm);
}

.refresh-result {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  background: #eaf6ee;
  color: #1d6b3a;
}

.refresh-result.failed {
  background: #fbeceb;
  color: var(--danger);
}

.dismiss {
  padding: 0 2px;
  border: none;
  background: none;
  color: inherit;
  font-size: 16px;
  line-height: 1;
}

.toolbar {
  right: 20px;
  bottom: 20px;
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 4px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface);
  box-shadow: var(--shadow-md);
}

.toolbar button {
  min-width: 32px;
  height: 30px;
  padding: 0 10px;
  border: none;
  border-radius: 7px;
  background: none;
  font-weight: 600;
}

.toolbar button:hover {
  background: var(--surface-muted);
}

.zoom-level {
  min-width: 44px;
  color: var(--ink-muted);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  text-align: center;
}

.sep {
  width: 1px;
  height: 18px;
  margin: 0 4px;
  background: var(--border);
}

.hint {
  bottom: 26px;
  left: 36px;
  margin: 0;
  color: var(--ink-faint);
  font-size: 12px;
}

.error {
  position: absolute;
  top: 80px;
  left: 36px;
  z-index: 10001;
  margin: 0;
  padding: 10px 14px;
  border-radius: var(--radius-sm);
  background: #fbeceb;
  color: var(--danger);
}

.centered {
  margin: auto;
}

.status {
  color: var(--ink-muted);
}

.empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  max-width: 380px;
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
