import { mount } from 'svelte';
import { registerSW } from 'virtual:pwa-register';
import './app.css';
import App from './App.svelte';

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  let refreshing = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (refreshing) return;
    refreshing = true;
    window.location.reload();
  });

  registerSW({
    immediate: true,
    onOfflineReady() {
      console.info('[GradMix] Lista para funcionar 100% offline.');
    },
  });
}

const app = mount(App, {
  target: document.getElementById('app')!,
});

export default app;
