import { mount } from "svelte";
import App from "./App.svelte";

// Chrome dispatches "ResizeObserver loop completed with undelivered
// notifications" as an uncaught window `error` whenever a ResizeObserver callback
// changes layout that reschedules observation — a benign, spec-sanctioned quirk
// (the remaining notifications are simply delivered on the next frame). The app
// runs several ResizeObservers (the toolbar overflow fold in ToolbarRow.svelte,
// thumbnail sizing); under Svelte 5's render/flush timing this surfaces where it
// didn't under Svelte 4, and it both trips the e2e page-error guard AND pops the
// Vite dev error overlay. Swallow ONLY these two exact messages; every other
// error propagates untouched.
if (typeof window !== "undefined") {
  const RESIZE_OBSERVER_NOISE =
    /^ResizeObserver loop (completed with undelivered notifications|limit exceeded)/;
  window.addEventListener("error", (event) => {
    if (event.message && RESIZE_OBSERVER_NOISE.test(event.message)) {
      event.stopImmediatePropagation();
      event.preventDefault();
    }
  });
}

// Svelte 5 removed the `new App({ target })` client API — the root component is
// instantiated with `mount()` now. (This was the one `new Component()` in the
// codebase; it lives in the entry point, not among the components.)
const app = mount(App, {
  target: document.getElementById("app"),
});

export default app;
