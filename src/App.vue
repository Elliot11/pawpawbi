<script setup lang="ts">
import { onMounted, ref } from 'vue';

const version = ref('');
const count = ref(0);

onMounted(async () => {
  version.value = await window.api.getAppVersion();
});
</script>

<template>
  <main>
    <h1>PawpawBI</h1>
    <p>Electron + Vue + Vite is up and running. App version: {{ version }}</p>
    <button @click="count++">Clicked {{ count }} times</button>
  </main>
</template>

<style scoped>
main {
  padding: 2rem;
}
</style>
