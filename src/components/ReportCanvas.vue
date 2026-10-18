<script setup lang="ts">
// Build visuals: the report site (report/ in the project), shown page by page in a sandboxed
// frame served by src/report.ts, with an HTML editor and the datasets beside it. The site is
// plain HTML, CSS and JavaScript so it can be hosted anywhere; nothing here ends up in it.
// Writing pages: docs/report-pages.md. Security: docs/security.md
import {
  computed,
  onActivated,
  onBeforeUnmount,
  onMounted,
  ref,
  watch,
} from 'vue';
import { useUnsavedGuard } from '../composables/useUnsavedGuard';
import { errorMessage } from '../errors';
import type { ReportFile } from '../shared/types';
import { REPORT_ORIGIN } from '../shared/types';
import { pageToShow, projectChanged } from '../ui-signals';
import CodeEditor from './CodeEditor.vue';
import DatasetsPanel from './report/DatasetsPanel.vue';

const report = ref<ReportFile | null>(null);
const loaded = ref(false);
const currentId = ref<string | null>(null);
// The frame's address. Set when choosing a page or reloading, not when a link inside the
// site moves the frame itself (the tabs just follow it then).
const frameSrc = ref('');
let reloads = 0;
const error = ref('');
const notice = ref('');
const busy = ref<'' | 'create' | 'page' | 'refresh' | 'export'>('');
const panel = ref<'' | 'html' | 'datasets'>('');

const current = computed(
  () => report.value?.pages.find((p) => p.id === currentId.value) ?? null,
);

function show(id: string | null) {
  currentId.value = id;
  reloads++;
  frameSrc.value = id ? `${REPORT_ORIGIN}/pages/${id}.html?v=${reloads}` : '';
}

async function load() {
  try {
    report.value = await window.api.report.get();
    const pages = report.value?.pages ?? [];
    if (!pages.some((p) => p.id === currentId.value)) {
      show(pages[0]?.id ?? null);
    }
    error.value = '';
  } catch (e) {
    error.value = `Couldn't load the report. ${errorMessage(e)}`;
  } finally {
    loaded.value = true;
  }
}

let stopListening: (() => void) | null = null;
onMounted(() => {
  load();
  stopListening = window.api.report.onNavigated((id) => {
    if (id === currentId.value) return;
    currentId.value = id;
    if (panel.value === 'html' && !editorDirty.value) openFile(pagePath());
  });
});
onBeforeUnmount(() => stopListening?.());
// Data may have changed on the other screens, so show the page afresh when coming back.
onActivated(() => {
  if (!loaded.value) return;
  load().then(() => show(currentId.value));
});

// The assistant changed the project (or a change was undone): show it as it is now. An open
// file in the editor is reloaded unless it has unsaved edits.
watch(projectChanged, async () => {
  await load();
  show(currentId.value);
  datasetsPanel.value?.reload();
  if (panel.value === 'html' && !editorDirty.value) openFile(filePath.value);
});

// The assistant asked to show a page.
watch(
  pageToShow,
  async (id) => {
    if (!id) return;
    pageToShow.value = null;
    await load();
    if (report.value?.pages.some((p) => p.id === id) && confirmLeave()) {
      show(id);
      if (panel.value === 'html') openFile(pagePath());
    }
  },
  { immediate: true },
);

async function createSite() {
  busy.value = 'create';
  try {
    report.value = await window.api.report.createSite();
    show(report.value.pages[0]?.id ?? null);
  } catch (e) {
    error.value = `Couldn't add the report. ${errorMessage(e)}`;
  } finally {
    busy.value = '';
  }
}

// ---------------------------------------------------------------------------------------------
// Pages

function freeTitle() {
  const titles = new Set(report.value?.pages.map((p) => p.title.toLowerCase()));
  for (let i = (report.value?.pages.length ?? 0) + 1; ; i++) {
    if (!titles.has(`page ${i}`)) return `Page ${i}`;
  }
}

function select(id: string) {
  if (id === currentId.value || !confirmLeave()) return;
  show(id);
  if (panel.value === 'html') openFile(pagePath());
}

async function newPage() {
  if (!confirmLeave()) return;
  busy.value = 'page';
  try {
    const page = await window.api.report.createPage(freeTitle());
    await load();
    show(page.id);
    if (panel.value === 'html') openFile(pagePath());
  } catch (e) {
    error.value = `Couldn't add a page. ${errorMessage(e)}`;
  } finally {
    busy.value = '';
  }
}

const renamingId = ref<string | null>(null);
const renameText = ref('');

function startRename(id: string, title: string) {
  renamingId.value = id;
  renameText.value = title;
}

async function finishRename() {
  const id = renamingId.value;
  if (!id) return;
  renamingId.value = null;
  const page = report.value?.pages.find((p) => p.id === id);
  const title = renameText.value.trim();
  if (!page || !title || title === page.title) return;
  try {
    await window.api.report.renamePage(id, title);
    await load();
    show(currentId.value);
  } catch (e) {
    error.value = `Couldn't rename the page. ${errorMessage(e)}`;
  }
}

async function deletePage(id: string, title: string) {
  // Deleting closes the editor panel, so unsaved edits in it would be lost.
  if (
    !confirmLeave() ||
    !window.confirm(`Delete the page "${title}"? This can't be undone.`)
  ) {
    return;
  }
  try {
    await window.api.report.deletePage(id);
    if (panel.value === 'html') panel.value = '';
    await load();
  } catch (e) {
    error.value = `Couldn't delete the page. ${errorMessage(e)}`;
  }
}

// ---------------------------------------------------------------------------------------------
// Refresh and export

async function refresh() {
  busy.value = 'refresh';
  error.value = '';
  try {
    const datasets = await window.api.report.refreshDatasets();
    datasetsPanel.value?.reload();
    const failed = datasets.filter((d) => d.error).length;
    if (failed) {
      error.value = `${failed} ${failed === 1 ? 'dataset' : 'datasets'} couldn't be updated. Open Datasets to see why.`;
    }
    show(currentId.value);
  } catch (e) {
    error.value = `Couldn't update the report's data. ${errorMessage(e)}`;
  } finally {
    busy.value = '';
  }
}

async function exportSite() {
  busy.value = 'export';
  error.value = '';
  notice.value = '';
  try {
    const folder = await window.api.report.exportSite();
    if (folder) {
      notice.value = `Published to ${folder}. Upload the folder's contents to your web host, such as an S3 bucket.`;
    }
  } catch (e) {
    error.value = `Couldn't publish the report. ${errorMessage(e)}`;
  } finally {
    busy.value = '';
  }
}

// ---------------------------------------------------------------------------------------------
// Side panel: file editor and datasets

const datasetsPanel = ref<InstanceType<typeof DatasetsPanel> | null>(null);
const filePath = ref('');
const html = ref('');
const savedHtml = ref('');
const editorError = ref('');
const saving = ref(false);
const editorDirty = computed(
  () => panel.value === 'html' && html.value !== savedHtml.value,
);
const pagePath = () => (currentId.value ? `pages/${currentId.value}.html` : '');

const files = computed(() => [
  ...(current.value
    ? [{ path: pagePath(), label: `Page: ${current.value.title}` }]
    : []),
  { path: 'assets/report.css', label: 'Styles: report.css' },
  { path: 'index.html', label: 'Landing page: index.html' },
]);

const { confirmLeave } = useUnsavedGuard(
  editorDirty,
  'Discard your unsaved changes to this file?',
);

async function openFile(path: string) {
  if (!path) return;
  editorError.value = '';
  try {
    savedHtml.value = await window.api.report.readFile(path);
    html.value = savedHtml.value;
    filePath.value = path;
    panel.value = 'html';
  } catch (e) {
    error.value = `Couldn't open ${path}. ${errorMessage(e)}`;
  }
}

function togglePanel(which: 'html' | 'datasets') {
  if (!confirmLeave()) return;
  if (panel.value === which) panel.value = '';
  else if (which === 'html') openFile(pagePath() || 'index.html');
  else panel.value = which;
}

function chooseFile(event: Event) {
  const select = event.target as HTMLSelectElement;
  if (confirmLeave()) openFile(select.value);
  else select.value = filePath.value;
}

async function saveFile() {
  if (saving.value || !filePath.value) return;
  saving.value = true;
  editorError.value = '';
  try {
    const text = html.value;
    await window.api.report.writeFile(filePath.value, text);
    savedHtml.value = text;
    show(currentId.value);
  } catch (e) {
    editorError.value = `Couldn't save the file. ${errorMessage(e)}`;
  } finally {
    saving.value = false;
  }
}

/** Ctrl+S in the editor saves the file first, then the project (the project's own Ctrl+S
 * would miss the file). Ctrl+Enter and Tab are the editor's own. */
function onEditorKey(event: KeyboardEvent) {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
    event.preventDefault();
    event.stopPropagation();
    saveFile()
      .then(() => window.api.projects.save())
      .catch(
        (e) =>
          (editorError.value = `Couldn't save the project. ${errorMessage(e)}`),
      );
  }
}
</script>

<template>
  <main class="report">
    <p v-if="error" class="banner box-error" role="alert">{{ error }}</p>
    <p v-else-if="notice" class="banner box-notice" role="status">
      {{ notice }}
      <button class="dismiss" aria-label="Dismiss" @click="notice = ''">
        ×
      </button>
    </p>

    <div v-if="loaded && !report" class="empty">
      <div class="empty-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24">
          <rect x="3" y="3" width="18" height="18" rx="3" />
          <path d="M8 16v-4M12 16V8M16 16v-6" />
        </svg>
      </div>
      <h2>This project has no report yet</h2>
      <p>
        A report is a small website of charts built from your tables. You can
        view it here and host it anywhere.
      </p>
      <button class="btn-primary" :disabled="!!busy" @click="createSite">
        {{ busy === 'create' ? 'Adding…' : 'Add a report' }}
      </button>
    </div>

    <template v-else-if="report">
      <header class="pagebar">
        <div class="tabs" role="tablist" aria-label="Report pages">
          <template v-for="page in report.pages" :key="page.id">
            <input
              v-if="renamingId === page.id"
              v-model="renameText"
              class="tab rename"
              aria-label="Page title"
              maxlength="80"
              @keydown.enter="finishRename"
              @keydown.escape="renamingId = null"
              @blur="finishRename"
              @vue:mounted="({ el }: { el: HTMLInputElement }) => el.select()"
            />
            <div v-else class="tab" :class="{ active: page.id === currentId }">
              <button
                class="tab-label"
                role="tab"
                :aria-selected="page.id === currentId"
                title="Double-click to rename"
                @click="select(page.id)"
                @dblclick="startRename(page.id, page.title)"
              >
                {{ page.title }}
              </button>
              <button
                v-if="page.id === currentId"
                class="tab-delete"
                :aria-label="`Delete ${page.title}`"
                title="Delete page"
                @click="deletePage(page.id, page.title)"
              >
                ×
              </button>
            </div>
          </template>
          <button
            class="add"
            title="New page"
            aria-label="New page"
            :disabled="!!busy"
            @click="newPage"
          >
            <svg class="icon" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M12 5v14M5 12h14" />
            </svg>
          </button>
        </div>

        <div class="actions">
          <button
            class="btn-ghost"
            :disabled="!!busy"
            title="Update the report's data from the tables and show it again"
            @click="refresh"
          >
            <svg class="icon" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M20 12a8 8 0 1 1-2.34-5.66M20 4v5h-5" />
            </svg>
            {{ busy === 'refresh' ? 'Refreshing…' : 'Refresh' }}
          </button>
          <button
            class="btn-ghost"
            :class="{ on: panel === 'datasets' }"
            :aria-pressed="panel === 'datasets'"
            @click="togglePanel('datasets')"
          >
            <svg class="icon" viewBox="0 0 24 24" aria-hidden="true">
              <ellipse cx="12" cy="6" rx="7" ry="3" />
              <path
                d="M5 6v12c0 1.66 3.13 3 7 3s7-1.34 7-3V6M5 12c0 1.66 3.13 3 7 3s7-1.34 7-3"
              />
            </svg>
            Datasets
          </button>
          <button
            class="btn-ghost"
            :class="{ on: panel === 'html' }"
            :aria-pressed="panel === 'html'"
            @click="togglePanel('html')"
          >
            <svg class="icon" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M8 7l-5 5 5 5M16 7l5 5-5 5" />
            </svg>
            Edit HTML
          </button>
          <button
            class="btn-ghost"
            :disabled="!!busy"
            title="Save the report as a folder of files to host on a website"
            @click="exportSite"
          >
            <svg class="icon" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M12 15V3M7 8l5-5 5 5M5 21h14" />
            </svg>
            {{ busy === 'export' ? 'Publishing…' : 'Publish' }}
          </button>
        </div>
      </header>

      <div class="stage">
        <!-- The site's pages are HTML and JavaScript from the project. sandbox without
             allow-same-origin gives them an opaque origin: no access to the app, window.api,
             storage or cookies. -->
        <iframe
          v-if="frameSrc"
          :key="frameSrc"
          class="page"
          :src="frameSrc"
          sandbox="allow-scripts"
          referrerpolicy="no-referrer"
          :title="current?.title ?? 'Report page'"
        ></iframe>
        <div v-else class="no-pages">
          <p>This report has no pages.</p>
          <button class="btn-primary" :disabled="!!busy" @click="newPage">
            Add a page
          </button>
        </div>

        <aside v-if="panel" class="side">
          <template v-if="panel === 'html'">
            <div class="side-head">
              <select
                class="file"
                :value="filePath"
                aria-label="File"
                @change="chooseFile"
              >
                <option v-for="f in files" :key="f.path" :value="f.path">
                  {{ f.label }}
                </option>
              </select>
              <span v-if="editorDirty" class="unsaved">Not saved yet</span>
            </div>
            <CodeEditor
              v-model="html"
              class="editor"
              :aria-label="filePath"
              min-height="200px"
              @run="saveFile"
              @keydown="onEditorKey"
            />
            <p class="side-note">
              Plain HTML, CSS and JavaScript. Charts come from pawpaw.barChart,
              pawpaw.lineChart, pawpaw.stat and pawpaw.table, each reading a
              dataset by name.
            </p>
            <p v-if="editorError" class="box-error side-error" role="alert">
              {{ editorError }}
            </p>
            <div class="side-actions">
              <button
                class="btn-ghost"
                :disabled="!editorDirty || saving"
                @click="html = savedHtml"
              >
                Undo changes
              </button>
              <button
                class="btn-primary"
                :disabled="!editorDirty || saving"
                title="Save and show (Ctrl+Enter)"
                @click="saveFile"
              >
                {{ saving ? 'Saving…' : 'Save and show' }}
              </button>
            </div>
          </template>
          <template v-else>
            <h3 class="side-title">Datasets</h3>
            <DatasetsPanel ref="datasetsPanel" @changed="show(currentId)" />
          </template>
        </aside>
      </div>
    </template>
  </main>
</template>

<style scoped>
.report {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  background: var(--bg);
}

.banner {
  display: flex;
  align-items: center;
  gap: 12px;
  margin: 12px 16px 0;
}

.dismiss {
  margin-left: auto;
  border: none;
  background: none;
  color: inherit;
  font-size: 18px;
  line-height: 1;
}

/* Empty states */

.empty,
.no-pages {
  display: flex;
  flex: 1;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 24px;
  text-align: center;
}

.empty {
  background-image: radial-gradient(var(--border) 1px, transparent 1px);
  background-size: 20px 20px;
}

.no-pages p {
  margin: 0 0 14px;
  color: var(--ink-muted);
}

.empty-icon {
  margin-bottom: 16px;
}

.empty h2 {
  font-size: 22px;
}

.empty p {
  max-width: 360px;
  margin: 8px 0 18px;
  color: var(--ink-muted);
}

/* Page bar */

.pagebar {
  display: flex;
  flex: none;
  align-items: center;
  gap: 16px;
  padding: 10px 16px;
  border-bottom: 1px solid var(--border);
  background: var(--surface);
}

.tabs {
  display: flex;
  flex: 1;
  align-items: center;
  gap: 4px;
  min-width: 0;
  overflow-x: auto;
}

.tab {
  display: flex;
  flex: none;
  align-items: center;
  max-width: 240px;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
}

.tab:hover {
  background: var(--surface-muted);
}

.tab.active {
  border-color: var(--accent);
  background: var(--accent-soft);
}

.tab-label {
  overflow: hidden;
  padding: 6px 12px;
  border: none;
  background: none;
  color: var(--ink-muted);
  font-weight: 600;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.tab.active .tab-label,
.tab:hover .tab-label {
  color: var(--ink);
}

.tab.active .tab-label {
  padding-right: 4px;
}

.tab-delete {
  margin-right: 4px;
  padding: 0 6px;
  border: none;
  border-radius: 6px;
  background: none;
  color: var(--ink-muted);
  font-size: 16px;
  line-height: 1.4;
}

.tab-delete:hover {
  background: var(--danger-soft);
  color: var(--danger);
}

.tab.rename {
  width: 180px;
  padding: 6px 12px;
  border-color: var(--accent);
  background: var(--surface);
  color: var(--ink);
  font: inherit;
  font-weight: 600;
}

.add {
  display: grid;
  flex: none;
  place-items: center;
  width: 30px;
  height: 30px;
  border: 1px dashed var(--border);
  border-radius: var(--radius-sm);
  background: none;
  color: var(--ink-muted);
}

.add:hover:not(:disabled) {
  border-color: var(--accent);
  color: var(--accent);
}

.actions {
  display: flex;
  flex: none;
  gap: 6px;
}

.actions .btn-ghost {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.btn-ghost.on {
  border-color: var(--accent);
  background: var(--accent-soft);
}

/* Page and side panel */

.stage {
  display: flex;
  flex: 1;
  min-height: 0;
}

.page {
  flex: 1;
  min-width: 0;
  border: none;
  background: var(--bg);
}

.side {
  display: flex;
  flex: none;
  flex-direction: column;
  gap: 10px;
  width: min(46%, 560px);
  padding: 14px 16px 16px;
  overflow-y: auto;
  border-left: 1px solid var(--border);
  background: var(--surface);
}

.side-head {
  display: flex;
  align-items: center;
  gap: 10px;
}

.side-title {
  font-size: 18px;
}

.file {
  flex: 1;
  min-width: 0;
  padding: 6px 8px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--surface);
  font: inherit;
  font-weight: 600;
}

.unsaved {
  flex: none;
  color: var(--ink-muted);
  font-size: 12px;
}

.editor {
  flex: 1;
  white-space: pre;
  resize: none;
}

.side-note {
  margin: 0;
  color: var(--ink-faint);
  font-size: 12px;
}

.side-error {
  padding: 8px 12px;
  font-size: 13px;
}

.side-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
</style>
