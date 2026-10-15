<template>
  <main class="canvas">
    <div class="empty">
      <div class="empty-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24">
          <rect x="3" y="3" width="18" height="18" rx="3" />
          <path d="M8 16v-4M12 16V8M16 16v-6" />
        </svg>
      </div>
      <h2>Your canvas is empty</h2>
      <p>Visuals will appear here as you build them with the assistant.</p>
    </div>
  </main>
</template>

<style scoped>
.canvas {
  display: grid;
  flex: 1;
  place-items: center;
  min-width: 0;
  overflow: auto;
  background-color: var(--bg);
  background-image: radial-gradient(var(--border) 1px, transparent 1px);
  background-size: 20px 20px;
}

.empty {
  max-width: 320px;
  text-align: center;
}

.empty-icon {
  display: grid;
  place-items: center;
  width: 56px;
  height: 56px;
  margin: 0 auto 16px;
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

.empty h2 {
  font-size: 22px;
}

.empty p {
  margin: 8px 0 0;
  color: var(--ink-muted);
}
</style>
