/**
 * Bun test preload for component tests in this package.
 *
 * Registers happy-dom globals (`window`, `document`, `HTMLElement`, etc.) so
 * @testing-library/react can render and query React trees inside `bun test`.
 *
 * Loaded explicitly via `bun test --preload ./test/happy-dom-setup.ts` (see
 * package.json's test script). Lib/store/hook tests don't preload this — they
 * are pure-function tests and don't need a DOM.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';

if (!GlobalRegistrator.isRegistered) {
  // `url` sets window.location to a real origin. Without it, happy-dom
  // defaults to about:blank and `window.location.origin === "null"`, which
  // breaks any code that does `new URL(path, window.location.origin)`
  // (notably fetchJSON's error path in @/lib/api).
  GlobalRegistrator.register({ url: 'http://localhost:3090' });
}
