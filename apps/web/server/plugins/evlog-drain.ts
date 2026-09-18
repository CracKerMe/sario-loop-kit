import { createFsDrain } from "evlog/fs";

// `defineNitroPlugin` is a Nitro auto-import; see ../nitro-globals.d.ts for
// why it is declared locally.
export default defineNitroPlugin((nitroApp) => {
  if (!import.meta.dev) return;
  nitroApp.hooks.hook("evlog:drain", createFsDrain());
});
