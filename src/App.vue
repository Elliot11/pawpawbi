<script setup lang="ts">
import { ref } from 'vue';
import type { Project } from './shared/types';
import SplashScreen from './views/SplashScreen.vue';
import ProjectWorkspace from './views/ProjectWorkspace.vue';

const project = ref<Project | null>(null);
</script>

<template>
  <ProjectWorkspace v-if="project" :project="project" @close="project = null" />
  <SplashScreen v-else @open="project = $event" />
</template>
