<template>
  <main class="model">
    <div class="empty">
      <div class="empty-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24"><path d="M3 4h7v6H3zM14 14h7v6h-7zM6.5 10v4a3 3 0 0 0 3 3H14" /></svg>
      </div>
      <h2>Model your data</h2>
      <p>
        This is where you'll set up how your tables relate, fix column types and add calculations,
        with help from the assistant. It isn't built yet.
      </p>
    </div>
  </main>
</template>

<style scoped>
.model {
  display: grid;
  flex: 1;
  place-items: center;
  min-width: 0;
  padding: 24px;
}

.empty {
  max-width: 360px;
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
