/// <reference types="@electron-forge/plugin-vite/forge-vite-env" />
declare module '*.css';

declare module '*.vue' {
  import type { DefineComponent } from 'vue';
  const component: DefineComponent<object, object, unknown>;
  export default component;
}

interface Window {
  api: {
    getAppVersion: () => Promise<string>;
    projects: import('./shared/types').ProjectsApi;
    python: import('./shared/types').PythonApi;
  };
}
