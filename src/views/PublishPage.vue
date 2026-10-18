<script setup lang="ts">
// Publishing the project's report: to PawpawBI (hosted at a link, with an account), or to a
// folder to host anywhere. Design: docs/pawpaw-server-api.md and docs/report-pages.md
import { onMounted, ref } from 'vue';
import AccountPanel from '../components/AccountPanel.vue';
import { errorMessage } from '../errors';
import type { AccountState, Project, PublishedReport } from '../shared/types';
import { timeAgo } from '../time';

defineProps<{ project: Project }>();
const emit = defineEmits<{ back: [] }>();

const hasReport = ref<boolean | null>(null);
const published = ref<PublishedReport | null>(null);
const account = ref<AccountState | null>(null);
const accountPanel = ref<InstanceType<typeof AccountPanel> | null>(null);
const busy = ref<'' | 'pawpawbi' | 'folder'>('');
const error = ref('');
const notice = ref('');
const folderNotice = ref('');
const folderError = ref('');

onMounted(async () => {
  try {
    [hasReport.value, published.value] = await Promise.all([
      window.api.report.get().then((r) => r !== null),
      window.api.publish.get(),
    ]);
  } catch (e) {
    error.value = errorMessage(e);
  }
});

async function publish() {
  busy.value = 'pawpawbi';
  error.value = '';
  notice.value = '';
  const first = !published.value;
  try {
    published.value = await window.api.publish.toPawpawBI();
    notice.value = first
      ? 'Published. Save the project to keep its link with it.'
      : 'Published your changes.';
  } catch (e) {
    error.value = `Couldn't publish the report. ${errorMessage(e)}`;
    // A rejected sign-in signs out here too: show the sign-in form again.
    await accountPanel.value?.reload();
  } finally {
    busy.value = '';
  }
}

async function toFolder() {
  busy.value = 'folder';
  folderError.value = '';
  folderNotice.value = '';
  try {
    const folder = await window.api.report.exportSite();
    if (folder) {
      folderNotice.value = `Saved to ${folder}. Upload the folder's contents to your web host, such as an S3 bucket.`;
    }
  } catch (e) {
    folderError.value = `Couldn't save the report. ${errorMessage(e)}`;
  } finally {
    busy.value = '';
  }
}
</script>

<template>
  <div class="publish">
    <button class="btn-link back" @click="emit('back')">
      ← Back to the project
    </button>
    <h2>Publish</h2>

    <p v-if="hasReport === false" class="box-error">
      This project has no report yet. Add one on Build visuals first.
    </p>

    <section class="panel">
      <div class="panel-head">
        <span class="badge">Recommended</span>
        <h3>Publish to PawpawBI</h3>
        <p class="hint">
          Your report is hosted for you at a link you can share, and its data
          can be refreshed from this computer. Anyone with the link can see it.
        </p>
      </div>

      <AccountPanel ref="accountPanel" @changed="account = $event" />

      <template v-if="account?.email && hasReport">
        <div v-if="published" class="published">
          <a :href="published.url" target="_blank" rel="noreferrer">{{
            published.url
          }}</a>
          <small>
            <template v-if="published.publishedAt"
              >Published {{ timeAgo(published.publishedAt) }}</template
            >
            <template v-if="published.refreshedAt">
              · data updated {{ timeAgo(published.refreshedAt) }}</template
            >
          </small>
        </div>
        <button
          class="btn-primary"
          :disabled="!!busy || project.busy"
          @click="publish"
        >
          {{
            busy === 'pawpawbi'
              ? 'Publishing…'
              : published
                ? 'Publish changes'
                : 'Publish'
          }}
        </button>
      </template>
      <p v-if="notice" class="box-notice" role="status">{{ notice }}</p>
      <p v-if="error" class="box-error" role="alert">{{ error }}</p>
    </section>

    <section class="panel">
      <div class="panel-head">
        <h3>Publish to a folder</h3>
        <p class="hint">
          Save the report as a folder of files to host anywhere, such as an S3
          bucket behind a CDN. Publish again to update it.
        </p>
      </div>
      <button
        class="btn-ghost"
        :disabled="!!busy || !hasReport"
        @click="toFolder"
      >
        {{ busy === 'folder' ? 'Saving…' : 'Choose a folder…' }}
      </button>
      <p v-if="folderNotice" class="box-notice" role="status">
        {{ folderNotice }}
      </p>
      <p v-if="folderError" class="box-error" role="alert">
        {{ folderError }}
      </p>
    </section>
  </div>
</template>

<style scoped>
.publish {
  display: flex;
  flex-direction: column;
  gap: 20px;
  width: 100%;
  max-width: 720px;
  margin: 0 auto;
  padding: 32px 36px 48px;
}

.back {
  align-self: flex-start;
  text-decoration: none;
}

.back:hover {
  color: var(--ink);
}

h2 {
  font-size: 30px;
}

.panel {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 14px;
  padding: 20px 22px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface);
}

.panel > * {
  align-self: stretch;
}

.panel > button {
  align-self: flex-start;
}

.panel-head {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.panel-head h3 {
  font-size: 20px;
}

.badge {
  align-self: flex-start;
  padding: 2px 8px;
  border-radius: 999px;
  background: var(--accent-soft);
  color: var(--accent);
  font-size: 12px;
  font-weight: 600;
}

.hint {
  margin: 0;
  color: var(--ink-muted);
  font-size: 14px;
}

.published {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 12px 14px;
  border-radius: var(--radius-sm);
  background: var(--surface-muted);
}

.published a {
  color: var(--accent);
  font-weight: 600;
  overflow-wrap: anywhere;
}

.published small {
  color: var(--ink-muted);
}
</style>
