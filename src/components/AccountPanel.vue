<script setup lang="ts">
// Signing in to PawpawBI (email and password, or Google or Microsoft in the browser), or who's
// signed in. Used where publishing needs an account.
import { onMounted, ref } from 'vue';
import { errorMessage } from '../errors';
import type { AccountState, SignInProvider } from '../shared/types';

const emit = defineEmits<{ changed: [state: AccountState] }>();

const state = ref<AccountState | null>(null);
const mode = ref<'sign-in' | 'sign-up'>('sign-in');
const email = ref('');
const password = ref('');
const busy = ref<'' | 'email' | SignInProvider | 'sign-out'>('');
const error = ref('');

function update(next: AccountState) {
  state.value = next;
  emit('changed', next);
}

async function reload() {
  try {
    update(await window.api.account.get());
  } catch (e) {
    error.value = errorMessage(e);
  }
}

onMounted(reload);
defineExpose({ reload });

async function run(
  kind: typeof busy.value,
  action: () => Promise<AccountState>,
) {
  busy.value = kind;
  error.value = '';
  try {
    update(await action());
    password.value = '';
  } catch (e) {
    error.value = errorMessage(e);
  } finally {
    busy.value = '';
  }
}

const submit = () =>
  run('email', () =>
    mode.value === 'sign-in'
      ? window.api.account.signIn(email.value, password.value)
      : window.api.account.signUp(email.value, password.value),
  );
const withProvider = (provider: SignInProvider) =>
  run(provider, () => window.api.account.signInWith(provider));
const signOut = () => run('sign-out', () => window.api.account.signOut());
</script>

<template>
  <div class="account">
    <p v-if="!state" class="muted">Checking your account…</p>

    <p v-else-if="!state.available" class="box-notice muted-box">
      Publishing to PawpawBI isn't available in this version yet.
    </p>

    <div v-else-if="state.email" class="signed-in">
      <span class="avatar" aria-hidden="true">{{
        state.email.charAt(0).toUpperCase()
      }}</span>
      <span>
        Signed in as <strong>{{ state.email }}</strong>
      </span>
      <button class="btn-link" :disabled="!!busy" @click="signOut">
        Sign out
      </button>
    </div>

    <div v-else class="sign-in">
      <p class="intro">
        {{
          mode === 'sign-in'
            ? 'Sign in to your PawpawBI account to publish.'
            : 'Create a free PawpawBI account to publish your reports.'
        }}
      </p>
      <div class="providers">
        <button
          class="btn-ghost provider"
          :disabled="!!busy"
          @click="withProvider('google')"
        >
          {{
            busy === 'google'
              ? 'Finish in your browser…'
              : 'Continue with Google'
          }}
        </button>
        <button
          class="btn-ghost provider"
          :disabled="!!busy"
          @click="withProvider('microsoft')"
        >
          {{
            busy === 'microsoft'
              ? 'Finish in your browser…'
              : 'Continue with Microsoft'
          }}
        </button>
      </div>
      <p class="or"><span>or with your email</span></p>
      <form class="form" @submit.prevent="submit">
        <label>
          Email
          <input v-model="email" type="email" autocomplete="email" required />
        </label>
        <label>
          Password
          <input
            v-model="password"
            type="password"
            :autocomplete="
              mode === 'sign-in' ? 'current-password' : 'new-password'
            "
            :minlength="mode === 'sign-up' ? 8 : undefined"
            required
          />
          <small v-if="mode === 'sign-up'">At least 8 characters.</small>
        </label>
        <button class="btn-primary" type="submit" :disabled="!!busy">
          {{
            busy === 'email'
              ? 'One moment…'
              : mode === 'sign-in'
                ? 'Sign in'
                : 'Create account'
          }}
        </button>
      </form>
      <p class="switch">
        <template v-if="mode === 'sign-in'">
          New to PawpawBI?
          <button class="btn-link" @click="mode = 'sign-up'">
            Create an account
          </button>
        </template>
        <template v-else>
          Already have an account?
          <button class="btn-link" @click="mode = 'sign-in'">Sign in</button>
        </template>
      </p>
    </div>

    <p v-if="error" class="box-error" role="alert">{{ error }}</p>
  </div>
</template>

<style scoped>
.account {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.muted,
.intro,
.switch {
  margin: 0;
  color: var(--ink-muted);
  font-size: 14px;
}

.muted-box {
  background: var(--surface-muted);
  color: var(--ink-muted);
}

.signed-in {
  display: flex;
  align-items: center;
  gap: 10px;
}

.avatar {
  display: grid;
  place-items: center;
  width: 30px;
  height: 30px;
  border-radius: 50%;
  background: var(--accent-soft);
  color: var(--accent);
  font-weight: 700;
}

.sign-in {
  display: flex;
  flex-direction: column;
  gap: 12px;
  max-width: 380px;
}

.providers {
  display: grid;
  gap: 8px;
}

.provider {
  padding: 9px 14px;
}

.or {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 2px 0;
  color: var(--ink-faint);
  font-size: 13px;
}

.or::before,
.or::after {
  flex: 1;
  height: 1px;
  background: var(--border);
  content: '';
}

.form {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.form label {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 14px;
  font-weight: 600;
}

.form input {
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  font: inherit;
  font-weight: 400;
}

.form small {
  color: var(--ink-muted);
  font-weight: 400;
}

.form .btn-primary {
  align-self: flex-start;
}
</style>
