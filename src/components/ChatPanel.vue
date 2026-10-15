<script setup lang="ts">
import { computed, nextTick, ref } from 'vue';
import { INTRO_MESSAGE, STAGES, replyTo, type ChatMessage, type Stage } from '../workflow';

const stage = ref<Stage>('data');
const messages = ref<ChatMessage[]>([{ id: 0, role: 'assistant', text: INTRO_MESSAGE }]);
const draft = ref('');
const thinking = ref(false);
const scroller = ref<HTMLElement | null>(null);

const stageIndex = computed(() => STAGES.findIndex((s) => s.id === stage.value));
const canSend = computed(() => draft.value.trim() !== '' && !thinking.value);

let nextId = 1;

async function addMessage(role: ChatMessage['role'], text: string) {
  messages.value.push({ id: nextId++, role, text });
  await nextTick();
  scroller.value?.scrollTo({ top: scroller.value.scrollHeight, behavior: 'smooth' });
}

async function send() {
  if (!canSend.value) return;
  const text = draft.value.trim();
  draft.value = '';
  await addMessage('user', text);

  thinking.value = true;
  await new Promise((resolve) => setTimeout(resolve, 700));
  const reply = replyTo(stage.value);
  stage.value = reply.stage;
  thinking.value = false;
  await addMessage('assistant', reply.text);
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    send();
  }
}
</script>

<template>
  <aside class="chat">
    <div class="chat-header">
      <h2>Assistant</h2>
      <ol class="steps">
        <li
          v-for="(s, i) in STAGES"
          :key="s.id"
          :class="{ done: i < stageIndex, current: i === stageIndex }"
        >
          <span class="step-dot">{{ i < stageIndex ? '✓' : i + 1 }}</span>
          {{ s.label }}
        </li>
      </ol>
    </div>

    <div ref="scroller" class="messages">
      <div v-for="m in messages" :key="m.id" class="message" :class="m.role">
        {{ m.text }}
      </div>
      <div v-if="thinking" class="message assistant typing" aria-label="Assistant is typing">
        <span></span><span></span><span></span>
      </div>
    </div>

    <form class="composer" @submit.prevent="send">
      <textarea
        v-model="draft"
        rows="3"
        placeholder="Message the assistant…"
        @keydown="onKeydown"
      ></textarea>
      <div class="composer-footer">
        <small>Shift + Enter for a new line</small>
        <button type="submit" class="send" :disabled="!canSend">Send</button>
      </div>
    </form>
  </aside>
</template>

<style scoped>
.chat {
  display: flex;
  flex: none;
  flex-direction: column;
  width: 400px;
  border-right: 1px solid var(--border);
  background: var(--surface);
}

.chat-header {
  padding: 20px 20px 16px;
  border-bottom: 1px solid var(--border);
}

.chat-header h2 {
  margin-bottom: 14px;
  font-size: 22px;
}

.steps {
  display: flex;
  gap: 6px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.steps li {
  display: flex;
  flex: 1;
  align-items: center;
  gap: 6px;
  padding: 6px 8px;
  border-radius: var(--radius-sm);
  background: var(--surface-muted);
  color: var(--ink-faint);
  font-size: 12px;
  font-weight: 600;
  white-space: nowrap;
}

.steps li.current {
  background: var(--accent-soft);
  color: var(--accent);
}

.steps li.done {
  color: var(--ink-muted);
}

.step-dot {
  display: grid;
  place-items: center;
  flex: none;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: var(--surface);
  font-size: 11px;
  font-weight: 700;
}

.steps li.current .step-dot {
  background: var(--accent);
  color: #fff;
}

.messages {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 12px;
  padding: 20px;
  overflow-y: auto;
}

.message {
  max-width: 90%;
  padding: 10px 14px;
  border-radius: 14px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.message.assistant {
  align-self: flex-start;
  border-bottom-left-radius: 4px;
  background: var(--surface-muted);
}

.message.user {
  align-self: flex-end;
  border-bottom-right-radius: 4px;
  background: var(--ink);
  color: #fff;
}

.typing {
  display: flex;
  gap: 4px;
  padding: 14px;
}

.typing span {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--ink-faint);
  animation: bounce 1s infinite ease-in-out;
}

.typing span:nth-child(2) {
  animation-delay: 0.15s;
}

.typing span:nth-child(3) {
  animation-delay: 0.3s;
}

@keyframes bounce {
  0%,
  60%,
  100% {
    transform: translateY(0);
    opacity: 0.5;
  }
  30% {
    transform: translateY(-4px);
    opacity: 1;
  }
}

.composer {
  margin: 0 16px 16px;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface);
  box-shadow: var(--shadow-sm);
  transition: border-color 0.15s;
}

.composer:focus-within {
  border-color: var(--ink-faint);
}

.composer textarea {
  display: block;
  width: 100%;
  border: none;
  outline: none;
  background: none;
  resize: none;
}

.composer-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: 6px;
}

.composer-footer small {
  color: var(--ink-faint);
  font-size: 11px;
}

.send {
  padding: 6px 14px;
  border: none;
  border-radius: var(--radius-sm);
  background: var(--accent);
  color: #fff;
  font-weight: 600;
}

.send:disabled {
  background: var(--surface-muted);
  color: var(--ink-faint);
}
</style>
