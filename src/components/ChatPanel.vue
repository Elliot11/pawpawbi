<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from 'vue';
import { plain } from '../plain';
import { newId } from '../shared/ids';
import type { ChatMessage, WorkflowStage } from '../shared/types';
import { INTRO_MESSAGE, replyTo } from '../workflow';

// Shared with the workspace's step tracker in the top bar.
const stage = defineModel<WorkflowStage>('stage', { required: true });
const messages = ref<ChatMessage[]>([]);
const draft = ref('');
const loading = ref(true);
const thinking = ref(false);
const scroller = ref<HTMLElement | null>(null);

const canSend = computed(() => draft.value.trim() !== '' && !loading.value && !thinking.value);

// How many of `messages` are already saved in the project. The intro message isn't saved
// until the user replies, so opening a project and closing it again isn't a change.
let savedCount = 0;

const createMessage = (role: ChatMessage['role'], text: string): ChatMessage => ({
  id: newId(),
  role,
  text,
  createdAt: new Date().toISOString(),
});

onMounted(async () => {
  const chat = await window.api.projects.loadChat();
  stage.value = chat.stage;
  messages.value = chat.messages.length
    ? chat.messages
    : [createMessage('assistant', INTRO_MESSAGE)];
  savedCount = chat.messages.length;
  loading.value = false;
  await scrollToBottom('auto');
});

async function scrollToBottom(behavior: ScrollBehavior = 'smooth') {
  await nextTick();
  scroller.value?.scrollTo({ top: scroller.value.scrollHeight, behavior });
}

async function addMessage(role: ChatMessage['role'], text: string) {
  messages.value.push(createMessage(role, text));
  const unsaved = messages.value.slice(savedCount);
  savedCount = messages.value.length;
  await window.api.projects.appendChat(plain(unsaved), stage.value);
  await scrollToBottom();
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
  font-size: 22px;
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
