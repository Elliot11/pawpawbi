<script setup lang="ts">
import { onBeforeUnmount, ref } from 'vue';
import type { Project } from './shared/types';
import SplashScreen from './views/SplashScreen.vue';
import ProjectWorkspace from './views/ProjectWorkspace.vue';

const project = ref<Project | null>(null);

// Keep the open project's details (e.g. unsaved changes) in step with the main process.
const unsubscribe = window.api.projects.onChanged((changed) => {
  if (project.value?.id === changed.id) project.value = changed;
});
onBeforeUnmount(unsubscribe);
</script>

<template>
  <ProjectWorkspace v-if="project" :project="project" @close="project = null" />
  <SplashScreen v-else @open="project = $event" />
</template>
